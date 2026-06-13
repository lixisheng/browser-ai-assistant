import type { OpenAIStructuredOutputFormat } from "../../shared/models/types";
import {
  createNetworkContextPrompt,
  createNetworkMetadataPrompt,
  filterNetworkRequestsByType,
  formatNetworkAttachmentSummary,
  parseRelevantNetworkRequestIds,
  redactNetworkRequestDetail,
  redactNetworkRequestMeta,
} from "../../shared/networkContext";
import type {
  ChatMessage,
  ChatNetworkContextAttachment,
  EndpointType,
  NetworkRequestDetail,
  NetworkRequestMeta,
  NetworkRequestTypeFilter,
} from "../../shared/types";
import type { AppChatSendMessage, StoreSetter } from "./appStore";
import { sendRuntimeMessage } from "./runtimeMessage";

type NetworkContextSnapshotResponse =
  | { ok: true; tabId?: number; requests: NetworkRequestMeta[] }
  | { ok: false; message?: string };

type NetworkContextDetailsResponse =
  | { ok: true; details: NetworkRequestDetail[] }
  | { ok: false; message?: string };

type NetworkRelevanceResponse =
  | { ok: true; content: string }
  | { ok: false; message?: string; status?: number; errorBody?: string };

export type PreparedNetworkContext =
  | {
      ok: true;
      userMessage: ChatMessage;
      attachment?: ChatNetworkContextAttachment;
    }
  | {
      ok: false;
      message: string;
    };

const NETWORK_RELEVANCE_MAX_RETRIES = 3;
const NETWORK_RELEVANCE_MODEL_REQUEST_RETRY_COUNT = 1;
const NETWORK_RELEVANCE_SCHEMA = {
  type: "object",
  properties: {
    requestIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["requestIds"],
  additionalProperties: false,
};
const NETWORK_RELEVANCE_JSON_SCHEMA_OUTPUT = {
  type: "json_schema",
  json_schema: {
    name: "network_relevance",
    strict: true,
    schema: NETWORK_RELEVANCE_SCHEMA,
  },
} satisfies OpenAIStructuredOutputFormat;
const NETWORK_RELEVANCE_TOOL_OUTPUT = {
  type: "tool",
  tool: {
    name: "select_network_requests",
    description: "筛选与用户需求最相关的 DevTools Network 请求 ID。",
    parameters: NETWORK_RELEVANCE_SCHEMA,
  },
} satisfies OpenAIStructuredOutputFormat;

export async function prepareNetworkContextForRequest(input: {
  userMessage: ChatMessage;
  modelConfig: AppChatSendMessage["model"];
  endpointType: EndpointType;
  networkRelevancePrompt: string;
  networkRelevanceBatchSize: number;
  networkRequestTypeFilters: NetworkRequestTypeFilter[];
  aiRequestRetryCount: number;
  existingMessages: ChatMessage[];
  set: StoreSetter;
}): Promise<PreparedNetworkContext> {
  input.set({ networkContextStatus: "正在读取 DevTools Network 请求" });
  const snapshot = await sendRuntimeMessage<NetworkContextSnapshotResponse | undefined>({
    type: "networkContext.getSnapshot",
  });
  if (!snapshot?.ok) {
    return { ok: false, message: snapshot?.message ?? "获取 Network 请求失败，请确认 DevTools 已打开" };
  }

  // background 正常会先脱敏；这里保留二次脱敏，用于防御旧版本 IndexedDB、同步恢复或导入数据绕过 background 边界。
  const filteredRequests = filterNetworkRequestsByType(snapshot.requests.map(redactNetworkRequestMeta), input.networkRequestTypeFilters);
  const dedupedRequests = filterNewNetworkRequestsByUrl(filteredRequests, input.existingMessages);
  const requests = dedupedRequests.requests;
  if (requests.length === 0) {
    if (filteredRequests.length > 0 && dedupedRequests.skippedMissingUrlCount === 0 && dedupedRequests.skippedDuplicateUrlCount > 0) {
      return { ok: true, userMessage: input.userMessage };
    }

    return snapshot.requests.length === 0
      ? { ok: false, message: "未采集到可用于分析的 Network 请求，请先打开 DevTools Network 并刷新页面" }
      : filteredRequests.length === 0
        ? { ok: false, message: "未采集到符合当前类型过滤条件的 Network 请求，请在聊天偏好中调整默认采集类型" }
        : { ok: false, message: "未采集到可用于筛选的新 Network 请求" };
  }

  input.set({ networkContextStatus: "正在筛选相关 Network 请求" });
  const relevanceResponse = await selectRelevantNetworkRequestBatches({
    modelConfig: input.modelConfig,
    endpointType: input.endpointType,
    userDemand: input.userMessage.content,
    requests,
    promptTemplate: input.networkRelevancePrompt,
    batchSize: input.networkRelevanceBatchSize,
    retryCount: Math.min(input.aiRequestRetryCount, NETWORK_RELEVANCE_MODEL_REQUEST_RETRY_COUNT),
  });
  if (!relevanceResponse?.ok) {
    return { ok: false, message: relevanceResponse?.message ?? "Network 请求相关性筛选失败" };
  }

  const requestIds = relevanceResponse.requestIds;
  if (requestIds.length === 0) {
    return { ok: false, message: "未筛选到与本次需求相关的 Network 请求" };
  }

  input.set({ networkContextStatus: "正在补充 Network 请求详情" });
  const detailsResponse = await sendRuntimeMessage<NetworkContextDetailsResponse | undefined>({
    type: "networkContext.getDetails",
    tabId: snapshot.tabId,
    requestIds,
  });
  if (!detailsResponse?.ok) {
    return { ok: false, message: detailsResponse?.message ?? "读取 Network 请求详情失败" };
  }

  // 详情会进入提示词、附件和历史记录，侧边栏侧再次脱敏可以兜住旧数据或异常 runtime 返回。
  const details = detailsResponse.details.map(redactNetworkRequestDetail);
  if (details.length === 0) {
    return { ok: false, message: "未读取到筛选请求的完整详情" };
  }

  const networkPrompt = createNetworkContextPrompt({
    userDemand: input.userMessage.content,
    details,
  });
  const attachment: ChatNetworkContextAttachment = {
    id: `network-${Date.now()}`,
    title: "Network 请求详情",
    summary: formatNetworkAttachmentSummary(details),
    requests: details,
    createdAt: Date.now(),
    redacted: details.some((detail) => detail.redacted),
    truncated: details.some((detail) => detail.truncated),
  };

  return {
    ok: true,
    userMessage: {
      ...input.userMessage,
      content: [input.userMessage.content, "", "请结合以下 DevTools Network 请求详情回答用户需求：", networkPrompt].join("\n"),
    },
    attachment,
  };
}

function filterNewNetworkRequestsByUrl(
  requests: NetworkRequestMeta[],
  existingMessages: ChatMessage[],
): { requests: NetworkRequestMeta[]; skippedDuplicateUrlCount: number; skippedMissingUrlCount: number } {
  const seenUrls = collectHistoricalNetworkRequestUrls(existingMessages);
  const result: NetworkRequestMeta[] = [];
  let skippedDuplicateUrlCount = 0;
  let skippedMissingUrlCount = 0;

  for (const request of requests) {
    if (!request.url) {
      skippedMissingUrlCount += 1;
      continue;
    }

    if (seenUrls.has(request.url)) {
      skippedDuplicateUrlCount += 1;
      continue;
    }

    seenUrls.add(request.url);
    result.push(request);
  }

  return { requests: result, skippedDuplicateUrlCount, skippedMissingUrlCount };
}

function collectHistoricalNetworkRequestUrls(messages: ChatMessage[]): Set<string> {
  const urls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const request of message.networkContextAttachment?.requests ?? []) {
      const redactedUrl = redactNetworkRequestDetail(request).url;
      if (redactedUrl) {
        urls.add(redactedUrl);
      }
    }
  }

  return urls;
}

async function selectRelevantNetworkRequestBatches(input: {
  modelConfig: AppChatSendMessage["model"];
  endpointType: EndpointType;
  userDemand: string;
  requests: NetworkRequestMeta[];
  promptTemplate: string;
  batchSize: number;
  retryCount: number;
}): Promise<{ ok: true; requestIds: string[] } | Extract<NetworkRelevanceResponse, { ok: false }>> {
  const batches = chunkArray(input.requests, input.batchSize);
  const results = await Promise.all(
    batches.map((batch) =>
      selectRelevantNetworkRequestBatchWithRetry({
        modelConfig: input.modelConfig,
        messages: createNetworkRelevanceMessages({
          model: input.modelConfig,
          endpointType: input.endpointType,
          userDemand: input.userDemand,
          requests: batch,
          promptTemplate: input.promptTemplate,
        }),
        requests: batch,
        retryCount: input.retryCount,
      }),
    ),
  );
  const failedResult = results.find((result): result is Extract<NetworkRelevanceResponse, { ok: false }> => !result.ok);
  if (failedResult) {
    return failedResult;
  }

  const successResults = results.filter((result): result is { ok: true; requestIds: string[] } => result.ok);
  const seen = new Set<string>();
  const requestIds = successResults.flatMap((result) =>
    result.requestIds.filter((requestId) => {
      if (seen.has(requestId)) {
        return false;
      }

      seen.add(requestId);
      return true;
    }),
  );

  return { ok: true, requestIds };
}

async function selectRelevantNetworkRequestBatchWithRetry(input: {
  modelConfig: AppChatSendMessage["model"];
  messages: ChatMessage[];
  requests: NetworkRequestMeta[];
  retryCount: number;
}): Promise<{ ok: true; requestIds: string[] } | Extract<NetworkRelevanceResponse, { ok: false }>> {
  let lastFailure: Extract<NetworkRelevanceResponse, { ok: false }> | undefined;
  for (let retryIndex = 0; retryIndex < NETWORK_RELEVANCE_MAX_RETRIES; retryIndex += 1) {
    const response = await selectRelevantNetworkRequests({
      modelConfig: input.modelConfig,
      messages: input.messages,
      retryCount: input.retryCount,
    });
    if (response?.ok) {
      return {
        ok: true,
        requestIds: parseRelevantNetworkRequestIds(response.content, input.requests),
      };
    }

    lastFailure = response ?? { ok: false, message: "Network 请求相关性筛选失败" };
  }

  return lastFailure ?? { ok: false, message: "Network 请求相关性筛选失败" };
}

async function selectRelevantNetworkRequests(input: {
  modelConfig: AppChatSendMessage["model"];
  messages: ChatMessage[];
  retryCount: number;
}): Promise<NetworkRelevanceResponse | undefined> {
  const attempts: Array<{
    structuredOutput?: OpenAIStructuredOutputFormat;
  }> = [
    { structuredOutput: NETWORK_RELEVANCE_JSON_SCHEMA_OUTPUT },
    { structuredOutput: NETWORK_RELEVANCE_TOOL_OUTPUT },
    {},
  ];

  let lastFailure: NetworkRelevanceResponse | undefined;
  for (const attempt of attempts) {
    const response = await sendRuntimeMessage<NetworkRelevanceResponse | undefined>({
      type: "chat.send",
      model: input.modelConfig,
      messages: input.messages,
      stream: false,
      structuredOutput: attempt.structuredOutput,
      retryCount: input.retryCount,
    });
    if (response?.ok) {
      return response;
    }

    lastFailure = response;
    if (!isStructuredOutputUnsupported(response)) {
      return response;
    }
  }

  return lastFailure;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return items.length ? [items] : [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function isStructuredOutputUnsupported(response: NetworkRelevanceResponse | undefined): boolean {
  if (!response || response.ok) {
    return false;
  }

  const text = `${response.message ?? ""}\n${response.errorBody ?? ""}`.toLowerCase();
  return (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 422
  ) && /response[_\s-]?format|json[_\s-]?schema|tool[_\s-]?choice|tool_calls?|function[_\s-]?calling|functions?|unsupported|not\s+supported|unknown\s+parameter|invalid\s+parameter|extra_forbidden/.test(text);
}

function createNetworkRelevanceMessages(input: {
  model: AppChatSendMessage["model"];
  endpointType: EndpointType;
  userDemand: string;
  requests: NetworkRequestMeta[];
  promptTemplate: string;
}): ChatMessage[] {
  const now = Date.now();
  const baseMessage = {
    modelId: input.model.id,
    endpointType: input.endpointType,
    streamMode: false,
    systemPrompt: "你是 Network 请求相关性筛选器，只能返回 JSON。",
    contextPrompt: "",
    contextMode: "text" as const,
    createdAt: now,
  };

  return [
    {
      ...baseMessage,
      id: `network-relevance-${now}-system`,
      role: "system",
      content: "你只负责根据用户需求筛选相关 Network 请求。只返回 JSON，不要解释。",
    },
    {
      ...baseMessage,
      id: `network-relevance-${now}-user`,
      role: "user",
      content: createNetworkMetadataPrompt({
        userDemand: input.userDemand,
        requests: input.requests,
        promptTemplate: input.promptTemplate,
      }),
    },
  ];
}
