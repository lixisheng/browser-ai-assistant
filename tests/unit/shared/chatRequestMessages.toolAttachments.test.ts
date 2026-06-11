import { describe, expect, it } from "vitest";
import { buildChatRequestMessages } from "../../../src/shared/chat/buildChatRequestMessages";
import { createModelConfig } from "../../../src/shared/chat/modelConfig";
import type { ChatMessage, ModelProvider, ProviderModel } from "../../../src/shared/types";

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
    maxTokens: 4096,
    systemPrompt: "你是网页助手",
    isTitleModel: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createMessage(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "已结合搜索结果回答。",
    createdAt: 1,
    modelId: "model-1",
    endpointType: "openai_chat",
    streamMode: false,
    systemPrompt: "你是网页助手",
    contextPrompt: "",
    contextMode: "text",
    ...partial,
  };
}

describe("聊天请求历史工具附件", () => {
  it("后续追问只注入聚合后的同类工具附件", () => {
    const model = createModelConfig(createProvider(), createModel());
    const assistantMessage = createMessage({
      toolCallRecords: [
        {
          id: "call-search-1",
          toolId: "web_search.tavily",
          name: "tavily_search",
          displayName: "Tavily 搜索",
          arguments: { query: "Tavily API" },
          status: "success",
          startedAt: 1,
          completedAt: 2,
        },
        {
          id: "call-search-2",
          toolId: "web_search.tavily",
          name: "tavily_search",
          displayName: "Tavily 搜索",
          arguments: { query: "Chrome 扩展" },
          status: "success",
          startedAt: 2,
          completedAt: 3,
        },
      ],
      toolAttachments: [
        {
          id: "attachment-search-1",
          kind: "web-search",
          title: "网络搜索结果",
          summary: "搜索问题：Tavily API",
          sourceToolCallId: "call-search-1",
          createdAt: 2,
          redacted: false,
          truncated: false,
          provider: "tavily",
          query: "Tavily API",
          answer: "答案 A",
          results: [
            { title: "Tavily Docs", url: "https://docs.tavily.com/search", content: "Search endpoint." },
            { title: "Tavily Docs", url: "https://docs.tavily.com/search", content: "重复结果。" },
          ],
        },
        {
          id: "attachment-search-2",
          kind: "web-search",
          title: "网络搜索结果",
          summary: "搜索问题：Chrome 扩展",
          sourceToolCallId: "call-search-2",
          createdAt: 3,
          redacted: false,
          truncated: false,
          provider: "tavily",
          query: "Chrome 扩展",
          answer: "答案 B",
          results: [{ title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", content: "Chrome extension docs." }],
        },
      ],
    });
    const userMessage = createMessage({
      id: "message-user",
      role: "user",
      content: "继续分析",
      createdAt: 4,
    });

    const result = buildChatRequestMessages({
      model,
      pageContext: "",
      existingMessages: [assistantMessage],
      userMessage,
    });

    expect(result[1].content.match(/网络搜索上下文/g)).toHaveLength(1);
    expect(result[1].content.match(/https:\/\/docs\.tavily\.com\/search/g)).toHaveLength(1);
    expect(result[1].content).toContain("https://developer.chrome.com/docs/extensions");
    expect(result[1].content).toContain("Tavily API；Chrome 扩展");
  });
});
