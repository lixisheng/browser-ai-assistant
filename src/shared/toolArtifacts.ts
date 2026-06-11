import type {
  ChatGenericToolAttachment,
  ChatMessage,
  ChatNetworkContextAttachment,
  ChatNetworkToolAttachment,
  ChatToolCallRecord,
  ChatToolAttachment,
  ChatWebSearchResult,
  ChatWebSearchPayload,
  ChatWebSearchToolAttachment,
} from "./types";
import { formatNetworkAttachmentForExport, formatNetworkAttachmentSummary, redactNetworkRequestDetail } from "./networkContext";
import { createTavilySearchContextPrompt, formatTavilySearchAttachmentSummary } from "./webSearch/tavily";
import { truncateText } from "./utils/text";

const TOOL_ATTACHMENT_KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const GENERIC_DETAIL_LIMIT = 4000;

type ToolAttachmentAggregateGroup = {
  attachments: ChatToolAttachment[];
  toolDisplayName?: string;
};

export function createWebSearchToolAttachment(
  attachment: ChatWebSearchPayload,
  sourceToolCallId?: string,
): ChatWebSearchToolAttachment {
  return {
    id: sourceToolCallId ? `tool-attachment-${sourceToolCallId}` : `tool-attachment-web-search-${attachment.createdAt}`,
    kind: "web-search",
    title: "网络搜索结果",
    summary: formatTavilySearchAttachmentSummary(attachment),
    sourceToolCallId,
    createdAt: attachment.createdAt,
    redacted: false,
    truncated: attachment.truncated,
    provider: attachment.provider,
    query: attachment.query,
    answer: attachment.answer,
    results: attachment.results,
  };
}

export function createNetworkToolAttachment(attachment: ChatNetworkContextAttachment): ChatNetworkToolAttachment {
  const requests = attachment.requests.map(redactNetworkRequestDetail);
  return {
    id: attachment.id,
    kind: "network",
    title: "Network 请求详情",
    summary: formatNetworkAttachmentSummary(requests),
    createdAt: attachment.createdAt,
    redacted: true,
    truncated: attachment.truncated,
    requests,
  };
}

export function collectMessageToolAttachments(message: ChatMessage): ChatToolAttachment[] {
  return aggregateToolAttachments(collectRawMessageToolAttachments(message), message.toolCallRecords);
}

// 原始附件用于工具调用详情追溯；聚合附件用于消息展示、导出和后续追问，避免同一轮多次工具调用撑开附件区。
export function collectRawMessageToolAttachments(message: ChatMessage): ChatToolAttachment[] {
  const attachments = uniqueToolAttachmentsById(message.toolAttachments ?? []);
  const legacyAttachments: ChatToolAttachment[] = [];
  if (message.networkContextAttachment) {
    legacyAttachments.push(createNetworkToolAttachment(message.networkContextAttachment));
  }
  return mergeCompatibleToolAttachments(attachments, legacyAttachments);
}

export function aggregateToolAttachments(attachments: ChatToolAttachment[], records: ChatToolCallRecord[] = []): ChatToolAttachment[] {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const recordsByAttachmentId = createRecordsByAttachmentId(records);
  const groups = new Map<string, ToolAttachmentAggregateGroup>();
  const order: string[] = [];
  for (const attachment of attachments) {
    const target = createToolAttachmentAggregateTarget(attachment, recordsById, recordsByAttachmentId);
    if (!groups.has(target.key)) {
      groups.set(target.key, { attachments: [], toolDisplayName: target.toolDisplayName });
      order.push(target.key);
    }
    groups.get(target.key)?.attachments.push(attachment);
  }

  return order
    .map((groupKey) => {
      const group = groups.get(groupKey);
      return group ? aggregateToolAttachmentGroup(group) : undefined;
    })
    .filter((attachment): attachment is ChatToolAttachment => Boolean(attachment));
}

export function formatToolAttachmentForPrompt(attachment: ChatToolAttachment): string | undefined {
  if (isWebSearchToolAttachment(attachment)) {
    return ["后续追问需要继续参考以下历史网络搜索结果：", createTavilySearchContextPrompt(attachment)].join("\n");
  }

  if (isNetworkToolAttachment(attachment)) {
    const requests = attachment.requests.map(redactNetworkRequestDetail);
    return ["后续追问需要继续参考以下历史 DevTools Network 请求详情：", formatNetworkAttachmentForExport(requests)].join("\n");
  }

  if (attachment.details?.trim()) {
    return [`后续追问需要继续参考以下历史工具附件：${attachment.title}`, attachment.details.trim()].join("\n");
  }

  return attachment.summary.trim() ? [`后续追问需要继续参考以下历史工具附件：${attachment.title}`, attachment.summary.trim()].join("\n") : undefined;
}

export function formatToolAttachmentForExport(attachment: ChatToolAttachment): string {
  if (isWebSearchToolAttachment(attachment)) {
    return ["# 网络搜索结果附件", "", formatTavilySearchAttachmentSummary(attachment), "", createTavilySearchContextPrompt(attachment)].join("\n");
  }

  if (isNetworkToolAttachment(attachment)) {
    const requests = attachment.requests.map(redactNetworkRequestDetail);
    return ["# Network 请求详情附件", "", formatNetworkAttachmentSummary(requests), "", formatNetworkAttachmentForExport(requests)].join("\n");
  }

  return ["# 工具结果附件", "", attachment.summary, "", attachment.details ?? ""].join("\n").trim();
}

export function normalizeToolAttachment(value: unknown): ChatToolAttachment | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const source = value as Partial<ChatToolAttachment>;
  const kind = typeof source.kind === "string" ? source.kind.trim() : "";
  if (!TOOL_ATTACHMENT_KIND_PATTERN.test(kind)) {
    return undefined;
  }

  if (kind === "web-search") {
    return normalizeWebSearchToolAttachment(source);
  }

  if (kind === "network") {
    return normalizeNetworkToolAttachment(source);
  }

  return normalizeGenericToolAttachment(source, kind);
}

export function isWebSearchToolAttachment(attachment: ChatToolAttachment): attachment is ChatWebSearchToolAttachment {
  return attachment.kind === "web-search" && "results" in attachment;
}

export function isNetworkToolAttachment(attachment: ChatToolAttachment): attachment is ChatNetworkToolAttachment {
  return attachment.kind === "network" && "requests" in attachment;
}

export function uniqueToolAttachmentsById(attachments: ChatToolAttachment[]): ChatToolAttachment[] {
  return uniqueBy(attachments, (attachment) => attachment.id);
}

export function mergeCompatibleToolAttachments(primary: ChatToolAttachment[], compatible: ChatToolAttachment[]): ChatToolAttachment[] {
  const result = uniqueToolAttachmentsById(primary);
  for (const attachment of compatible) {
    if (result.some((item) => isSameToolAttachmentContent(item, attachment))) {
      continue;
    }
    result.push(attachment);
  }
  return result;
}

function isSameToolAttachmentContent(left: ChatToolAttachment, right: ChatToolAttachment): boolean {
  return left.id === right.id || createToolAttachmentContentKey(left) === createToolAttachmentContentKey(right);
}

function createToolAttachmentContentKey(attachment: ChatToolAttachment): string {
  if (isWebSearchToolAttachment(attachment)) {
    return [
      attachment.kind,
      attachment.provider,
      normalizeComparableText(attachment.query),
      normalizeComparableText(attachment.answer ?? ""),
      ...attachment.results.map((result) =>
        [normalizeComparableText(result.url), normalizeComparableText(result.title), normalizeComparableText(result.content)].join("\u0001"),
      ),
    ].join("\u0000");
  }

  if (isNetworkToolAttachment(attachment)) {
    return [
      attachment.kind,
      ...attachment.requests.map((request) =>
        [normalizeComparableText(request.id), normalizeComparableText(request.method), normalizeComparableText(request.url), String(request.status ?? "")].join("\u0001"),
      ),
    ].join("\u0000");
  }

  return [attachment.kind, normalizeComparableText(attachment.title), normalizeComparableText(attachment.summary), normalizeComparableText(attachment.details ?? "")].join("\u0000");
}

function createRecordsByAttachmentId(records: ChatToolCallRecord[]): Map<string, ChatToolCallRecord> {
  const recordsByAttachmentId = new Map<string, ChatToolCallRecord>();
  for (const record of records) {
    for (const attachmentId of record.attachmentIds ?? []) {
      if (!recordsByAttachmentId.has(attachmentId)) {
        recordsByAttachmentId.set(attachmentId, record);
      }
    }
  }
  return recordsByAttachmentId;
}

function createToolAttachmentAggregateTarget(
  attachment: ChatToolAttachment,
  recordsById: Map<string, ChatToolCallRecord>,
  recordsByAttachmentId: Map<string, ChatToolCallRecord>,
): { key: string; toolDisplayName?: string } {
  // 兼容旧工具结果：有的历史或过渡数据只在工具记录里保存 attachmentIds，附件本身没有 sourceToolCallId。
  const record = attachment.sourceToolCallId ? recordsById.get(attachment.sourceToolCallId) : recordsByAttachmentId.get(attachment.id);
  if (record) {
    return { key: `tool:${record.toolId || record.name}`, toolDisplayName: record.displayName || record.name };
  }

  // 缺少工具记录的旧数据无法可靠判断“同一工具”，带调用 ID 的附件保守地按调用拆开。
  if (attachment.sourceToolCallId) {
    return { key: `${attachment.kind}\u0000call:${attachment.sourceToolCallId}` };
  }

  return { key: `${attachment.kind}\u0000legacy` };
}

function aggregateToolAttachmentGroup(group: ToolAttachmentAggregateGroup): ChatToolAttachment | undefined {
  const { attachments } = group;
  if (attachments.length === 0) {
    return undefined;
  }

  if (attachments.length === 1) {
    return attachments[0];
  }

  const kinds = uniqueNonEmptyStrings(attachments.map((attachment) => attachment.kind));
  if (kinds.length > 1) {
    return aggregateMixedKindToolAttachments(attachments, group.toolDisplayName);
  }

  const kind = kinds[0] ?? attachments[0].kind;
  if (kind === "web-search") {
    return aggregateWebSearchToolAttachments(attachments.filter(isWebSearchToolAttachment));
  }

  if (kind === "network") {
    return aggregateNetworkToolAttachments(attachments.filter(isNetworkToolAttachment));
  }

  return aggregateGenericToolAttachments(kind, attachments);
}

function aggregateMixedKindToolAttachments(attachments: ChatToolAttachment[], toolDisplayName?: string): ChatGenericToolAttachment {
  const details = uniqueNonEmptyStrings(attachments.map(formatToolAttachmentForExport)).join("\n\n");
  const truncatedDetails = truncateText(details, GENERIC_DETAIL_LIMIT);
  return {
    id: `tool-attachment-tool-result-set-aggregated-${attachments.map((attachment) => attachment.id).join("-")}`,
    kind: "tool-result-set",
    title: `${toolDisplayName ?? attachments[0].title}结果`,
    summary: uniqueNonEmptyStrings(attachments.map((attachment) => attachment.summary)).join("\n"),
    createdAt: Math.max(...attachments.map((attachment) => attachment.createdAt)),
    redacted: attachments.every((attachment) => attachment.redacted),
    truncated: attachments.some((attachment) => attachment.truncated) || truncatedDetails.truncated,
    details: truncatedDetails.text || undefined,
  };
}

function aggregateWebSearchToolAttachments(attachments: ChatWebSearchToolAttachment[]): ChatWebSearchToolAttachment | undefined {
  if (attachments.length === 0) {
    return undefined;
  }

  const first = attachments[0];
  const results = uniqueBy(attachments.flatMap((attachment) => attachment.results), (result) => result.url.trim() || result.title.trim());
  const createdAt = Math.max(...attachments.map((attachment) => attachment.createdAt));
  const aggregated: ChatWebSearchToolAttachment = {
    id: `tool-attachment-web-search-aggregated-${attachments.map((attachment) => attachment.id).join("-")}`,
    kind: "web-search",
    title: first.title || "网络搜索结果",
    summary: "",
    createdAt,
    redacted: false,
    truncated: attachments.some((attachment) => attachment.truncated),
    provider: first.provider,
    query: uniqueNonEmptyStrings(attachments.map((attachment) => attachment.query)).join("；"),
    answer: uniqueNonEmptyStrings(attachments.map((attachment) => attachment.answer)).join("\n\n") || undefined,
    results,
  };
  return {
    ...aggregated,
    summary: formatTavilySearchAttachmentSummary(aggregated),
  };
}

function aggregateNetworkToolAttachments(attachments: ChatNetworkToolAttachment[]): ChatNetworkToolAttachment | undefined {
  if (attachments.length === 0) {
    return undefined;
  }

  const requests = uniqueBy(
    attachments.flatMap((attachment) => attachment.requests.map(redactNetworkRequestDetail)),
    (request) => request.id.trim() || `${request.method}\u0000${request.url}\u0000${request.status ?? ""}`,
  );
  const createdAt = Math.max(...attachments.map((attachment) => attachment.createdAt));
  return {
    id: `tool-attachment-network-aggregated-${attachments.map((attachment) => attachment.id).join("-")}`,
    kind: "network",
    title: "Network 请求详情",
    summary: formatNetworkAttachmentSummary(requests),
    createdAt,
    redacted: true,
    truncated: attachments.some((attachment) => attachment.truncated || attachment.requests.some((request) => request.truncated)),
    requests,
  };
}

function aggregateGenericToolAttachments(kind: string, attachments: ChatToolAttachment[]): ChatGenericToolAttachment {
  const first = attachments[0];
  const details = uniqueNonEmptyStrings(
    attachments.map((attachment) => ("details" in attachment && typeof attachment.details === "string" ? attachment.details : undefined)),
  ).join("\n\n");
  const truncatedDetails = truncateText(details, GENERIC_DETAIL_LIMIT);
  return {
    id: `tool-attachment-${kind}-aggregated-${attachments.map((attachment) => attachment.id).join("-")}`,
    kind,
    title: first.title,
    summary: uniqueNonEmptyStrings(attachments.map((attachment) => attachment.summary)).join("\n"),
    createdAt: Math.max(...attachments.map((attachment) => attachment.createdAt)),
    redacted: attachments.every((attachment) => attachment.redacted),
    truncated: attachments.some((attachment) => attachment.truncated) || truncatedDetails.truncated,
    details: truncatedDetails.text || undefined,
  };
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    result.push(item);
  }
  return result;
}

function uniqueNonEmptyStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeWebSearchToolAttachment(source: Partial<ChatToolAttachment>): ChatWebSearchToolAttachment | undefined {
  const query = "query" in source && typeof source.query === "string" ? source.query.trim() : "";
  const provider = "provider" in source && source.provider === "tavily" ? source.provider : undefined;
  const results = "results" in source && Array.isArray(source.results) ? source.results : undefined;
  if (!query || !provider || !results) {
    return undefined;
  }

  const attachment = {
    provider,
    query,
    answer: "answer" in source && typeof source.answer === "string" && source.answer.trim() ? source.answer.trim() : undefined,
    results: results
      .map((item): ChatWebSearchResult | undefined => {
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const result = item as { title?: unknown; url?: unknown; content?: unknown; rawContent?: unknown; score?: unknown; publishedDate?: unknown };
        const url = typeof result.url === "string" ? result.url.trim() : "";
        const content = typeof result.content === "string" ? result.content.trim() : "";
        if (!url || !content) {
          return undefined;
        }
        return {
          title: typeof result.title === "string" && result.title.trim() ? result.title.trim() : url,
          url,
          content,
          rawContent: typeof result.rawContent === "string" && result.rawContent.trim() ? result.rawContent.trim() : undefined,
          score: typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined,
          publishedDate: typeof result.publishedDate === "string" && result.publishedDate.trim() ? result.publishedDate.trim() : undefined,
        };
      })
      .filter((item): item is ChatWebSearchResult => Boolean(item)),
    createdAt: normalizeTimestamp(source.createdAt),
    truncated: typeof source.truncated === "boolean" ? source.truncated : false,
  };

  return {
    ...createWebSearchToolAttachment(attachment, normalizeOptionalString(source.sourceToolCallId)),
    id: normalizeId(source.id, `tool-attachment-web-search-${attachment.createdAt}`),
    title: normalizeOptionalString(source.title) ?? "网络搜索结果",
    summary: normalizeOptionalString(source.summary) ?? formatTavilySearchAttachmentSummary(attachment),
  };
}

function normalizeNetworkToolAttachment(source: Partial<ChatToolAttachment>): ChatNetworkToolAttachment | undefined {
  if (!("requests" in source) || !Array.isArray(source.requests)) {
    return undefined;
  }

  const requests = source.requests
    .map((item) => (item && typeof item === "object" ? redactNetworkRequestDetail(item as ChatNetworkToolAttachment["requests"][number]) : undefined))
    .filter((item): item is ChatNetworkToolAttachment["requests"][number] => Boolean(item));
  if (requests.length === 0) {
    return undefined;
  }

  return {
    id: normalizeId(source.id, `tool-attachment-network-${normalizeTimestamp(source.createdAt)}`),
    kind: "network",
    title: "Network 请求详情",
    summary: formatNetworkAttachmentSummary(requests),
    sourceToolCallId: normalizeOptionalString(source.sourceToolCallId),
    createdAt: normalizeTimestamp(source.createdAt),
    redacted: true,
    truncated: typeof source.truncated === "boolean" ? source.truncated : false,
    requests,
  };
}

function normalizeGenericToolAttachment(source: Partial<ChatToolAttachment>, kind: string): ChatGenericToolAttachment | undefined {
  const title = normalizeOptionalString(source.title);
  const summary = normalizeOptionalString(source.summary);
  if (!title || !summary) {
    return undefined;
  }

  const truncatedDetails = "details" in source && typeof source.details === "string" ? truncateText(source.details, GENERIC_DETAIL_LIMIT) : undefined;
  return {
    id: normalizeId(source.id, `tool-attachment-${kind}-${normalizeTimestamp(source.createdAt)}`),
    kind,
    title,
    summary,
    sourceToolCallId: normalizeOptionalString(source.sourceToolCallId),
    createdAt: normalizeTimestamp(source.createdAt),
    redacted: typeof source.redacted === "boolean" ? source.redacted : true,
    truncated: source.truncated === true || Boolean(truncatedDetails?.truncated),
    details: truncatedDetails?.text,
  };
}

function normalizeId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}
