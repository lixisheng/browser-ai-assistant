import type { ChatImageAttachment, ChatMessage, ModelConfig } from "../types";
import { createEndpointUrl } from "./modelCatalog";
import type { ModelRequestPayload } from "./types";

type AnthropicMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    >;

export function createAnthropicMessagesPayload(
  model: ModelConfig,
  messages: ChatMessage[],
  stream: boolean,
): ModelRequestPayload {
  const system = messages.find((message) => message.role === "system")?.content || model.systemPrompt;

  const body: Record<string, unknown> = {
    model: model.modelId,
    system,
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: createAnthropicMessageContent(message.content, message.attachments),
      })),
    temperature: model.temperature,
    max_tokens: model.maxTokens,
    stream,
  };

  if (typeof model.topK === "number") {
    body.top_k = model.topK;
  }

  return {
    url: createEndpointUrl(model.endpointUrl, "anthropic_messages"),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": model.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
  };
}

function createAnthropicMessageContent(content: string, attachments?: ChatImageAttachment[]): AnthropicMessageContent {
  if (!attachments?.length) {
    return content;
  }

  return [
    { type: "text", text: content },
    ...attachments.map((attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: attachment.mediaType,
        data: extractBase64Data(attachment.dataUrl),
      },
    })),
  ];
}

function extractBase64Data(dataUrl: string): string {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("图片附件 dataUrl 格式无效");
  }

  const [, data] = match;
  return data;
}
