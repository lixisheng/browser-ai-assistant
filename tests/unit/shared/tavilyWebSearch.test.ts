import { describe, expect, it, vi } from "vitest";
import {
  createTavilySearchContextPrompt,
  parseTavilyApiKeys,
  searchTavily,
  selectTavilyApiKey,
} from "../../../src/shared/webSearch/tavily";
import type { WebSearchSettings } from "../../../src/shared/types";

const settings: WebSearchSettings = {
  provider: "tavily",
  tavily: {
    apiKeysText: " tvly-1, ,tvly-2 ",
    apiKeyStrategy: "round_robin",
    includeAnswer: "basic",
    includeRawContent: false,
    maxResults: 5,
  },
  updatedAt: 1,
};

describe("Tavily 网络搜索", () => {
  it("按英文逗号拆分 API Key 并过滤空值", () => {
    expect(parseTavilyApiKeys(" tvly-1, ,tvly-2 ,, ")).toEqual(["tvly-1", "tvly-2"]);
  });

  it("轮询策略会返回当前 Key 和下一次索引", () => {
    expect(selectTavilyApiKey(["tvly-1", "tvly-2"], "round_robin", 1)).toEqual({
      apiKey: "tvly-2",
      nextIndex: 0,
    });
  });

  it("随机策略使用注入的随机数选择 Key", () => {
    expect(selectTavilyApiKey(["tvly-1", "tvly-2", "tvly-3"], "random", 0, () => 0.7)).toEqual({
      apiKey: "tvly-3",
      nextIndex: 0,
    });
  });

  it("发送 Tavily 搜索请求并归一化结果", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        answer: "Tavily 是搜索 API。",
        results: [
          {
            title: "Tavily Docs",
            url: "https://docs.tavily.com/search",
            content: "官方文档内容",
            score: 0.9,
            published_date: "2026-01-01",
          },
        ],
      }),
    });

    const result = await searchTavily({
      query: "Tavily API",
      settings,
      currentApiKeyIndex: 0,
      fetcher,
    });

    expect(result).toMatchObject({
      ok: true,
      nextApiKeyIndex: 1,
      attachment: {
        provider: "tavily",
        query: "Tavily API",
        answer: "Tavily 是搜索 API。",
        results: [
          {
            title: "Tavily Docs",
            url: "https://docs.tavily.com/search",
            content: "官方文档内容",
            score: 0.9,
            publishedDate: "2026-01-01",
          },
        ],
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tvly-1",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          query: "Tavily API",
          search_depth: "basic",
          include_answer: "basic",
          include_raw_content: false,
          max_results: 5,
        }),
      }),
    );
  });

  it("请求失败时返回固定中文错误且不泄露 API Key", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized tvly-secret",
      text: vi.fn().mockResolvedValue("tvly-secret"),
    });

    const result = await searchTavily({
      query: "失败场景",
      settings: {
        ...settings,
        tavily: { ...settings.tavily, apiKeysText: "tvly-secret", apiKeyStrategy: "round_robin" },
      },
      currentApiKeyIndex: 0,
      fetcher,
    });

    expect(result).toEqual({
      ok: false,
      message: "网络搜索失败，请检查 Tavily 配置后重试",
    });
    expect(JSON.stringify(result)).not.toContain("tvly-secret");
  });

  it("格式化搜索附件供后续对话注入", () => {
    const prompt = createTavilySearchContextPrompt({
      provider: "tavily",
      query: "Tavily API",
      answer: "Tavily 是搜索 API。",
      results: [
        {
          title: "Tavily Docs",
          url: "https://docs.tavily.com/search",
          content: "官方文档内容",
          score: 0.9,
          publishedDate: "2026-01-01",
        },
      ],
      createdAt: 1,
      truncated: false,
    });

    expect(prompt).toContain("网络搜索上下文：");
    expect(prompt).toContain("搜索问题：Tavily API");
    expect(prompt).toContain("Tavily Docs");
    expect(prompt).toContain("https://docs.tavily.com/search");
  });

  it("开启原始内容时会保留并注入 Tavily raw_content", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        results: [
          {
            title: "Tavily Raw",
            url: "https://docs.tavily.com/raw",
            content: "摘要内容",
            raw_content: "完整原始内容\n第二段",
          },
        ],
      }),
    });

    const result = await searchTavily({
      query: "raw content",
      settings: {
        ...settings,
        tavily: { ...settings.tavily, includeRawContent: "markdown" },
      },
      currentApiKeyIndex: 0,
      fetcher,
    });

    expect(result).toMatchObject({
      ok: true,
      attachment: {
        results: [
          {
            content: "摘要内容",
            rawContent: "完整原始内容\n第二段",
          },
        ],
      },
    });

    if (result.ok) {
      expect(createTavilySearchContextPrompt(result.attachment)).toContain("原始内容：完整原始内容\n第二段");
    }
  });
});
