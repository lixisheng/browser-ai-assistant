import { describe, expect, it, vi } from "vitest";
import { searchTavily } from "../../../src/shared/webSearch/tavily";
import type { WebSearchSettings } from "../../../src/shared/types";

describe("Tavily 搜索参数", () => {
  it("使用配置中的 include_answer、include_raw_content 和 max_results 构造请求体", async () => {
    const settings: WebSearchSettings = {
      provider: "tavily",
      tavily: {
        apiKeysText: "tvly-1",
        apiKeyStrategy: "round_robin",
        includeAnswer: "advanced",
        includeRawContent: "markdown",
        maxResults: 12,
      },
      updatedAt: 1,
    };
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        answer: "advanced answer",
        results: [
          {
            title: "Tavily",
            url: "https://docs.tavily.com",
            content: "docs",
          },
        ],
      }),
    });

    await searchTavily({
      query: "Tavily 参数",
      settings,
      currentApiKeyIndex: 0,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        body: JSON.stringify({
          query: "Tavily 参数",
          search_depth: "basic",
          include_answer: "advanced",
          include_raw_content: "markdown",
          max_results: 12,
        }),
      }),
    );
  });
});
