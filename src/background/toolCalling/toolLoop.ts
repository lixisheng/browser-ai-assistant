import type { ModelRequestMessage, ModelResponseData, ModelToolCall, ModelToolExecutor, ModelToolRegistryEntry, ModelToolResultMessage } from "../../shared/models/types";

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export interface RunModelToolLoopInput {
  initialMessages: ModelRequestMessage[];
  tools: ModelToolRegistryEntry[];
  enabledToolIds: string[];
  requestModel: (messages: ModelRequestMessage[]) => Promise<ModelToolLoopResponse>;
  requestFinalModel?: (messages: ModelRequestMessage[]) => Promise<ModelToolLoopResponse>;
  executeTool: ModelToolExecutor;
  maxIterations?: number;
}

export type ModelToolLoopResponse =
  | ({ ok: true } & ModelResponseData)
  | {
      ok: false;
      message: string;
    };

export async function runModelToolLoop(input: RunModelToolLoopInput): Promise<ModelToolLoopResponse> {
  const maxIterations = Math.max(1, Math.floor(input.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS));
  const enabledToolIds = new Set(input.enabledToolIds);
  let messages = [...input.initialMessages];
  let webSearchContextAttachment: ModelResponseData["webSearchContextAttachment"];
  let lastResponse: ModelToolLoopResponse | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await input.requestModel(messages);
    if (!response.ok) {
      return response;
    }

    if (!response.toolCalls?.length) {
      lastResponse = {
        ok: true,
        content: response.content,
        thinking: response.thinking,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        ...(webSearchContextAttachment ? { webSearchContextAttachment } : {}),
      };
      break;
    }

    const toolResultMessages = await Promise.all(
      response.toolCalls.map((toolCall) => executeAllowedTool(toolCall, input.tools, enabledToolIds, input.executeTool)),
    );
    for (const toolResultMessage of toolResultMessages) {
      if (toolResultMessage.webSearchContextAttachment) {
        webSearchContextAttachment = mergeWebSearchContextAttachment(webSearchContextAttachment, toolResultMessage.webSearchContextAttachment);
      }
    }

    messages = [
      ...messages,
      {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      },
      ...toolResultMessages,
    ];
  }

  if (input.requestFinalModel && lastResponse?.ok) {
    const finalResponse = await input.requestFinalModel(messages);
    if (!finalResponse.ok) {
      return finalResponse;
    }

    return {
      ok: true,
      content: finalResponse.content,
      thinking: finalResponse.thinking,
      ...(finalResponse.reasoningContent ? { reasoningContent: finalResponse.reasoningContent } : {}),
      ...(webSearchContextAttachment ? { webSearchContextAttachment } : {}),
    };
  }

  return lastResponse ?? { ok: false, message: "工具调用超过最大轮次，已停止本次请求。" };
}

async function executeAllowedTool(
  toolCall: ModelToolCall,
  tools: ModelToolRegistryEntry[],
  enabledToolIds: Set<string>,
  executeTool: ModelToolExecutor,
): Promise<ModelToolResultMessage> {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return createToolErrorResult(toolCall, `工具 ${toolCall.name} 未注册，已拒绝执行。`);
  }

  if (!enabledToolIds.has(tool.id)) {
    return createToolErrorResult(toolCall, `工具 ${toolCall.name} 未启用，已拒绝执行。`);
  }

  if (toolCall.parseError) {
    return createToolErrorResult(toolCall, `工具 ${toolCall.name} 参数无效：${toolCall.parseError}`);
  }

  try {
    const result = await executeTool(toolCall, tool);
    return {
      role: "tool",
      toolCallId: result.toolCallId,
      name: result.name,
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
      ...(result.webSearchContextAttachment ? { webSearchContextAttachment: result.webSearchContextAttachment } : {}),
    };
  } catch {
    return createToolErrorResult(toolCall, `工具 ${toolCall.name} 执行失败，请稍后重试。`);
  }
}

function createToolErrorResult(toolCall: ModelToolCall, content: string): ModelToolResultMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}

function mergeWebSearchContextAttachment(
  current: ModelResponseData["webSearchContextAttachment"],
  next: NonNullable<ModelResponseData["webSearchContextAttachment"]>,
): NonNullable<ModelResponseData["webSearchContextAttachment"]> {
  if (!current) {
    return next;
  }

  const resultsByKey = new Map<string, (typeof next.results)[number]>();
  for (const result of [...current.results, ...next.results]) {
    resultsByKey.set(result.url || result.title, result);
  }

  // 现有消息结构只支持单个 Tavily 附件；多次搜索时合并内容，避免后一次覆盖前一次。
  return {
    provider: next.provider,
    query: uniqueNonEmpty([current.query, next.query]).join("；"),
    ...(uniqueNonEmpty([current.answer, next.answer]).length
      ? { answer: uniqueNonEmpty([current.answer, next.answer]).join("\n\n") }
      : {}),
    results: Array.from(resultsByKey.values()),
    createdAt: Math.max(current.createdAt, next.createdAt),
    truncated: current.truncated || next.truncated,
  };
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}
