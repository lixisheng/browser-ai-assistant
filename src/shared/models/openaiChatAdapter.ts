import type { ChatMessage, ModelConfig } from "../types";
import type { ModelRequestPayload } from "./types";

export function createOpenAIChatPayload(
  model: ModelConfig,
  messages: ChatMessage[],
  stream: boolean,
): ModelRequestPayload {
  return {
    url: model.endpointUrl,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: {
      model: model.modelId,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: model.temperature,
      max_tokens: model.maxTokens,
      stream,
    },
  };
}
