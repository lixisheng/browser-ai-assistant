import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../src/side-panel/state/appStore";
import { clearDatabase, saveModelProvider, saveProviderModel } from "../../../src/shared/storage/repositories";
import type { ModelProvider, ProviderModel } from "../../../src/shared/types";

function createProvider(): ModelProvider {
  return {
    id: "provider-1",
    name: "默认渠道",
    endpointType: "openai_chat",
    endpointUrl: "https://api.example.com/v1/chat/completions",
    apiKey: "sk-test",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createModel(): ProviderModel {
  return {
    id: "model-1",
    providerId: "provider-1",
    displayName: "默认模型",
    modelId: "gpt-test",
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: "你是网页助手",
    isTitleModel: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("appStore", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    useAppStore.getState().reset();
    await clearDatabase();
  });

  it("当前页上下文消息没有返回值时不会读取 undefined.ok", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });

    await useAppStore.getState().refreshPageContext();

    expect(useAppStore.getState().pageContext).toMatchObject({
      loading: false,
      error: "提取当前页面失败",
    });
  });

  it("使用用户指定的模型请求 AI 生成 URL 正则候选", async () => {
    const provider = createProvider();
    const model = createModel();
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://example.com/news/123?from=home",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                "https://example\\.com/news/123",
                "https://example\\.com/news/\\d+",
                "https://example\\.com/news/.*",
                "https://example\\.com/.*",
                "https://.*",
              ]),
            },
          },
        ],
      }),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveModelProvider(provider);
    await saveProviderModel(model);
    await useAppStore.getState().loadChannelConfig();

    const result = await useAppStore.getState().generateUrlPatterns("model-1");

    expect(result).toEqual({
      ok: true,
      patterns: [
        "https://example\\.com/news/123",
        "https://example\\.com/news/\\d+",
        "https://example\\.com/news/.*",
        "https://example\\.com/.*",
        "https://.*",
      ],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "extractionRule.getCurrentTabUrl",
        debugRequestId: expect.stringMatching(/^url-pattern-/),
      },
      expect.any(Function),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("兼容 callback 形态的当前标签页 URL 响应", async () => {
    const provider = createProvider();
    const model = createModel();
    const sendMessage = vi.fn((_message: unknown, callback: (response: unknown) => void) => {
      callback({
        ok: true,
        url: "https://example.com/article",
      });
      return undefined;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify(["https://example\\.com/.*"]),
            },
          },
        ],
      }),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveModelProvider(provider);
    await saveProviderModel(model);
    await useAppStore.getState().loadChannelConfig();

    const result = await useAppStore.getState().generateUrlPatterns("model-1");

    expect(result).toEqual({
      ok: true,
      patterns: ["https://example\\.com/.*"],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "extractionRule.getCurrentTabUrl",
        debugRequestId: expect.stringMatching(/^url-pattern-/),
      },
      expect.any(Function),
    );
  });
});
