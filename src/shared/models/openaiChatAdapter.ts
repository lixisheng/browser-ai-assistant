import type { ChatImageAttachment, ChatMessage, ModelConfig } from "../types";
import { createEndpointUrl } from "./modelCatalog";
import type { ModelRequestPayload, OpenAIStructuredOutputFormat } from "./types";

type OpenAIMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export function createOpenAIChatPayload(
  model: ModelConfig,
  messages: ChatMessage[],
  stream: boolean,
  structuredOutput?: OpenAIStructuredOutputFormat,
): ModelRequestPayload {
  const body: Record<string, unknown> = {
    model: model.modelId,
    messages: messages.map((message) => ({
      role: message.role,
      content: createOpenAIMessageContent(message.content, message.attachments),
    })),
    temperature: model.temperature,
    max_tokens: model.maxTokens,
    stream,
  };

  if (typeof model.topK === "number") {
    body.top_k = model.topK;
  }

  if (structuredOutput?.type === "json_schema") {
    body.response_format = structuredOutput;
  }

  if (structuredOutput?.type === "tool") {
    body.tools = [
      {
        type: "function",
        function: structuredOutput.tool,
      },
    ];
    body.tool_choice = {
      type: "function",
      function: {
        name: structuredOutput.tool.name,
      },
    };
  }

  return {
    url: createEndpointUrl(model.endpointUrl, "openai_chat"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body,
  };
}

function createOpenAIMessageContent(content: string, attachments?: ChatImageAttachment[]): OpenAIMessageContent {
  if (!attachments?.length) {
    return content;
  }

  return [
    { type: "text", text: content },
    ...attachments.map((attachment) => ({
      type: "image_url" as const,
      image_url: {
        url: attachment.dataUrl,
      },
    })),
  ];
}
