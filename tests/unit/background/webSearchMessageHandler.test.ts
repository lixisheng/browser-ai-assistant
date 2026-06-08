import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebSearchMessage } from "../../../src/background/webSearchMessageHandler";
import { clearDatabase, getAppSetting, saveAppSetting } from "../../../src/shared/storage/repositories";
import type { WebSearchSettings } from "../../../src/shared/types";

const settings: WebSearchSettings = {
  provider: "tavily",
  tavily: {
    apiKeysText: "tvly-1,tvly-2",
    apiKeyStrategy: "round_robin",
    includeAnswer: "basic",
    includeRawContent: false,
    maxResults: 5,
  },
  updatedAt: 1,
};

describe("网络搜索 background 消息处理", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  it("读取 Tavily 配置并返回搜索附件", async () => {
    await saveAppSetting({ key: "webSearchSettings", value: settings, updatedAt: 1 });
    await saveAppSetting({ key: "tavilyApiKeyRoundRobinIndex", value: 1, updatedAt: 1 });
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        answer: "Tavily 是搜索 API。",
        results: [{ title: "Tavily Docs", url: "https://docs.tavily.com/search", content: "官方文档内容" }],
      }),
    });

    const response = await handleWebSearchMessage({ type: "webSearch.search", query: "Tavily API" }, fetcher);

    expect(response).toMatchObject({
      ok: true,
      attachment: {
        provider: "tavily",
        query: "Tavily API",
        answer: "Tavily 是搜索 API。",
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tvly-2" }),
      }),
    );
    await expect(getAppSetting("tavilyApiKeyRoundRobinIndex")).resolves.toBe(0);
  });

  it("缺少 API Key 时返回中文错误", async () => {
    const response = await handleWebSearchMessage({ type: "webSearch.search", query: "Tavily API" }, vi.fn());

    expect(response).toEqual({
      ok: false,
      message: "请先配置 Tavily API Key",
    });
  });
});
