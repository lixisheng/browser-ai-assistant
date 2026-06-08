import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../src/side-panel/state/appStore";
import { clearDatabase, saveModelProvider, saveProviderModel } from "../../../src/shared/storage/repositories";
import type { ChatPreferenceValues, ModelProvider, ProviderModel } from "../../../src/shared/types";

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

describe("appStore 网络搜索参数覆盖", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppStore.getState().reset();
    await clearDatabase();
  });

  it("当前聊天 Tavily 参数覆盖优先于全局偏好并随搜索消息发送", async () => {
    const sendMessage = vi.fn((message: { type: string; query?: string }, callback: (response: unknown) => void) => {
      if (message.type === "webSearch.search") {
        callback({
          ok: true,
          attachment: {
            provider: "tavily",
            query: message.query,
            results: [{ title: "Tavily Docs", url: "https://docs.tavily.com/search", content: "官方文档内容" }],
            createdAt: 1,
            truncated: false,
          },
        });
        return undefined;
      }

      if (message.type === "chat.send") {
        callback({ ok: true, content: "AI 搜索回复" });
        return undefined;
      }

      callback({ ok: true });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await saveModelProvider(createProvider());
    await saveProviderModel(createModel());
    await useAppStore.getState().loadChannelConfig();
    await useAppStore.getState().loadChatData();
    const chatPreferences: ChatPreferenceValues = useAppStore.getState().chatPreferences;
    useAppStore.setState((state) => ({
      chatPreferences,
      webSearchSettings: {
        ...state.webSearchSettings,
        tavily: {
          ...state.webSearchSettings.tavily,
          includeAnswer: "basic",
          includeRawContent: false,
          maxResults: 5,
        },
      },
    }));
    useAppStore.getState().setStreamMode(false);
    useAppStore.getState().setWebSearchEnabled(true);
    await useAppStore.getState().updateActiveSessionChatPreferences({
      webSearchIncludeAnswer: "advanced",
      webSearchIncludeRawContent: "markdown",
      webSearchMaxResults: 12,
    });

    await useAppStore.getState().sendChatMessage("Tavily 参数覆盖");

    const webSearchCall = sendMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find((message) => message.type === "webSearch.search");
    expect(webSearchCall).toMatchObject({
      type: "webSearch.search",
      query: "Tavily 参数覆盖",
      tavily: {
        includeAnswer: "advanced",
        includeRawContent: "markdown",
        maxResults: 12,
      },
    });
  });
});
