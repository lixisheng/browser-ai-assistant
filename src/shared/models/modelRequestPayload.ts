import { createAnthropicMessagesPayload } from "./anthropicMessagesAdapter";
import { createOpenAIChatPayload } from "./openaiChatAdapter";
import type { OpenAIStructuredOutputFormat } from "./types";
import type { ChatMessage, ModelConfig } from "../types";

export function createModelRequestPayload(
  model: ModelConfig,
  messages: ChatMessage[],
  stream: boolean,
  structuredOutput?: OpenAIStructuredOutputFormat,
) {
  if (model.endpointType === "anthropic_messages") {
    return createAnthropicMessagesPayload(model, messages, stream);
  }

  return createOpenAIChatPayload(model, messages, stream, structuredOutput);
}
