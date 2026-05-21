import { createAnthropicMessagesPayload } from "./anthropicMessagesAdapter";
import { createOpenAIChatPayload } from "./openaiChatAdapter";
import type { ChatMessage, ModelConfig } from "../types";

export function createModelRequestPayload(model: ModelConfig, messages: ChatMessage[], stream: boolean) {
  if (model.endpointType === "anthropic_messages") {
    return createAnthropicMessagesPayload(model, messages, stream);
  }

  return createOpenAIChatPayload(model, messages, stream);
}
