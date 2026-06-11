import type { ChatToolAttachment, ChatToolCallRecord } from "../../shared/types";
import type { ModelRequestMessage, ModelResponseData, ModelToolCall, ModelToolExecutor, ModelToolRegistryEntry, ModelToolResultMessage } from "../../shared/models/types";
import { truncateText } from "../../shared/utils/text";

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export interface RunModelToolLoopInput {
  initialMessages: ModelRequestMessage[];
  tools: ModelToolRegistryEntry[];
  enabledToolIds: string[];
  requestModel: (messages: ModelRequestMessage[]) => Promise<ModelToolLoopResponse>;
  requestFinalModel?: (messages: ModelRequestMessage[]) => Promise<ModelToolLoopResponse>;
  executeTool: ModelToolExecutor;
  onToolCallStart?: (record: ChatToolCallRecord) => void;
  onToolCallComplete?: (record: ChatToolCallRecord, attachments: ChatToolAttachment[]) => void;
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
  const toolCallRecords: ChatToolCallRecord[] = [];
  const toolAttachments: ChatToolAttachment[] = [];
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
        ...(toolCallRecords.length ? { toolCallRecords } : {}),
        ...(toolAttachments.length ? { toolAttachments } : {}),
      };
      break;
    }

    const toolResultMessages = await Promise.all(
      response.toolCalls.map((toolCall) =>
        executeAllowedTool(toolCall, input.tools, enabledToolIds, input.executeTool, {
          onStart: (record) => {
            toolCallRecords.push(record);
            input.onToolCallStart?.(record);
          },
          onComplete: (record, attachments) => {
            const existingIndex = toolCallRecords.findIndex((item) => item.id === record.id);
            if (existingIndex >= 0) {
              toolCallRecords[existingIndex] = record;
            } else {
              toolCallRecords.push(record);
            }
            appendUniqueToolAttachments(toolAttachments, attachments);
            input.onToolCallComplete?.(record, attachments);
          },
        }),
      ),
    );
    for (const toolResultMessage of toolResultMessages) {
      appendUniqueToolAttachments(toolAttachments, toolResultMessage.toolAttachments ?? []);
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
      ...(toolCallRecords.length ? { toolCallRecords } : {}),
      ...(toolAttachments.length ? { toolAttachments } : {}),
    };
  }

  return lastResponse ?? { ok: false, message: "工具调用超过最大轮次，已停止本次请求。" };
}

async function executeAllowedTool(
  toolCall: ModelToolCall,
  tools: ModelToolRegistryEntry[],
  enabledToolIds: Set<string>,
  executeTool: ModelToolExecutor,
  callbacks: {
    onStart: (record: ChatToolCallRecord) => void;
    onComplete: (record: ChatToolCallRecord, attachments: ChatToolAttachment[]) => void;
  },
): Promise<ModelToolResultMessage> {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  const runningRecord: ChatToolCallRecord = {
    id: toolCall.id,
    toolId: tool?.id ?? toolCall.name,
    name: toolCall.name,
    displayName: tool?.displayName ?? toolCall.name,
    arguments: sanitizeToolArguments(toolCall.arguments),
    status: "running",
    startedAt: Date.now(),
  };
  callbacks.onStart(runningRecord);

  if (!tool) {
    return completeToolError(runningRecord, toolCall, `工具 ${toolCall.name} 未注册，已拒绝执行。`, callbacks);
  }

  if (!enabledToolIds.has(tool.id)) {
    return completeToolError(runningRecord, toolCall, `工具 ${toolCall.name} 未启用，已拒绝执行。`, callbacks);
  }

  if (toolCall.parseError) {
    return completeToolError(runningRecord, toolCall, `工具 ${toolCall.name} 参数无效：${toolCall.parseError}`, callbacks);
  }

  try {
    const result = await executeTool(toolCall, tool);
    const resultMessage: ModelToolResultMessage = {
      role: "tool",
      toolCallId: result.toolCallId,
      name: result.name,
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
      ...(result.toolAttachments?.length ? { toolAttachments: result.toolAttachments } : {}),
    };
    callbacks.onComplete(createCompletedToolRecord(runningRecord, resultMessage), result.toolAttachments ?? []);
    return resultMessage;
  } catch {
    return completeToolError(runningRecord, toolCall, `工具 ${toolCall.name} 执行失败，请稍后重试。`, callbacks);
  }
}

function completeToolError(
  runningRecord: ChatToolCallRecord,
  toolCall: ModelToolCall,
  content: string,
  callbacks: { onComplete: (record: ChatToolCallRecord, attachments: ChatToolAttachment[]) => void },
): ModelToolResultMessage {
  const result = createToolErrorResult(toolCall, content);
  callbacks.onComplete(createCompletedToolRecord(runningRecord, result), []);
  return result;
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

function createCompletedToolRecord(record: ChatToolCallRecord, result: ModelToolResultMessage): ChatToolCallRecord {
  const attachmentIds = result.toolAttachments?.map((attachment) => attachment.id).filter(Boolean) ?? [];
  return {
    ...record,
    status: result.isError ? "error" : "success",
    completedAt: Date.now(),
    resultSummary: truncateText(result.content.trim(), 280).text,
    ...(result.isError ? { errorMessage: result.content } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}),
  };
}

function appendUniqueToolAttachments(target: ChatToolAttachment[], attachments: ChatToolAttachment[]): void {
  for (const attachment of attachments) {
    if (!target.some((item) => item.id === attachment.id)) {
      target.push(attachment);
    }
  }
}

function sanitizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, truncateText(value, 1000).text];
      }
      if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return [key, value];
      }
      try {
        return [key, JSON.parse(JSON.stringify(value ?? null)) as unknown];
      } catch {
        return [key, "[无法序列化的参数]"];
      }
    }),
  );
}
