import { createAnthropicMessagesPayload } from "../shared/models/anthropicMessagesAdapter";
import { createOpenAIChatPayload } from "../shared/models/openaiChatAdapter";
import type { ChatMessage, ModelConfig } from "../shared/types";

export function createModelRequestPayload(model: ModelConfig, messages: ChatMessage[], stream: boolean) {
  if (model.endpointType === "anthropic_messages") {
    return createAnthropicMessagesPayload(model, messages, stream);
  }

  return createOpenAIChatPayload(model, messages, stream);
}
