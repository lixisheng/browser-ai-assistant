import type { NetworkHeader, NetworkRequestDetail, NetworkRequestMeta } from "./types";
import { truncateText } from "./utils/text";

const REDACTED_VALUE = "[已脱敏]";
const BODY_LIMIT = 6000;
const FIELD_LIMIT = 1200;

const SENSITIVE_NAME_PATTERN = /(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|credential|session|sid|csrf|xsrf)/i;

export function redactNetworkRequestDetail(detail: NetworkRequestDetail): NetworkRequestDetail {
  return {
    ...detail,
    url: redactUrl(detail.url),
    requestHeaders: redactHeaders(detail.requestHeaders),
    responseHeaders: redactHeaders(detail.responseHeaders),
    requestBody: redactBody(detail.requestBody),
    responseBody: redactBody(detail.responseBody),
    redacted: true,
  };
}

export function redactNetworkRequestMeta(meta: NetworkRequestMeta): NetworkRequestMeta {
  return {
    ...meta,
    url: redactUrl(meta.url),
    requestHeaders: redactHeaders(meta.requestHeaders),
    responseHeaders: redactHeaders(meta.responseHeaders),
    requestBody: redactBody(meta.requestBody),
  };
}

export function redactNetworkText(value: string): string {
  return redactBody(value) ?? "";
}

export function parseRelevantNetworkRequestIds(content: string, availableRequests: string[] | NetworkRequestMeta[]): string[] {
  const availableIds = availableRequests.map((request) => (typeof request === "string" ? request : request.id));
  const availableIdSet = new Set(availableIds);
  const candidates = parseRequestIdCandidates(content);
  const seen = new Set<string>();

  return candidates.flatMap((candidate) => {
    const id = resolveRequestIdCandidate(candidate, availableIds, availableIdSet);
    if (!id || seen.has(id)) {
      return [];
    }

    seen.add(id);
    return [id];
  });
}

export function createNetworkContextPrompt(input: { userDemand: string; details: NetworkRequestDetail[] }): string {
  const sections = input.details.map((detail, index) =>
    [
      `Request ${index + 1}: ${detail.method || "UNKNOWN"} ${detail.url}`,
      detail.status !== undefined ? `Status: ${detail.status}${detail.statusText ? ` ${detail.statusText}` : ""}` : "",
      detail.mimeType ? `MIME: ${detail.mimeType}` : "",
      detail.resourceType ? `Type: ${detail.resourceType}` : "",
      detail.durationMs !== undefined ? `Duration: ${detail.durationMs}ms` : "",
      detail.redacted ? "Redacted: true" : "Redacted: false",
      detail.truncated ? "Truncated: true" : "Truncated: false",
      formatHeaderBlock("Request headers", detail.requestHeaders),
      detail.requestBody ? `Request body:\n${truncateForPrompt(detail.requestBody, BODY_LIMIT)}` : "",
      formatHeaderBlock("Response headers", detail.responseHeaders),
      detail.responseBody ? `Response body:\n${truncateForPrompt(detail.responseBody, BODY_LIMIT)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return ["Network context:", `用户需求：${input.userDemand}`, "", sections.join("\n\n---\n\n")].join("\n").trim();
}

export function formatNetworkAttachmentSummary(details: NetworkRequestDetail[]): string {
  if (details.length === 0) {
    return "未注入 Network 请求";
  }

  const first = details[0];
  return `已注入 ${details.length} 个 Network 请求：${first.method || "UNKNOWN"} ${first.status ?? "unknown"} ${first.url}`;
}

export function formatNetworkAttachmentForExport(details: NetworkRequestDetail[]): string {
  if (details.length === 0) {
    return "";
  }

  return createNetworkContextPrompt({ userDemand: "聊天记录中保存的 Network 请求详情", details });
}

function parseRequestIdCandidates(content: string): string[] {
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const parsedCandidates = parseRequestIdCandidatesFromValue(parsed);
    if (parsedCandidates.length > 0) {
      return parsedCandidates;
    }

    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["requestIds", "ids", "requests"]) {
        const value = record[key];
        if (Array.isArray(value)) {
          return value.flatMap((item) => {
            if (typeof item === "string") {
              return [item];
            }
            if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
              return [item.id];
            }
            return [];
          });
        }
      }
    }
  } catch {
    // 第三方模型可能返回编号列表；JSON 解析失败时继续走宽松文本解析。
  }

  return Array.from(trimmed.matchAll(/req-[\w.-]+/g)).map((match) => match[0]);
}

function resolveRequestIdCandidate(candidate: string, availableIds: string[], availableIdSet: Set<string>): string | undefined {
  if (availableIdSet.has(candidate)) {
    return candidate;
  }

  const ordinalMatch = candidate.match(/^req-(\d+)$/i);
  if (!ordinalMatch) {
    return undefined;
  }

  const numericId = ordinalMatch[1];
  // Chrome HAR 的 _requestId 常见为裸数字；模型可能按提示格式误补成 req-N，因此先兼容真实裸编号。
  if (availableIdSet.has(numericId)) {
    return numericId;
  }

  const ordinal = Number(numericId);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > availableIds.length) {
    return undefined;
  }

  return availableIds[ordinal - 1];
}

function parseRequestIdCandidatesFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    return parseRequestIdCandidates(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      return parseRequestIdCandidatesFromValue(item);
    });
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directCandidates = ["requestIds", "ids", "requests"].flatMap((key) => parseRequestIdCandidatesFromValue(record[key]));
  if (directCandidates.length > 0) {
    return directCandidates;
  }

  if (typeof record.id === "string") {
    return [record.id];
  }

  const choiceCandidates = parseRequestIdCandidatesFromValue(record.choices);
  if (choiceCandidates.length > 0) {
    return choiceCandidates;
  }

  const messageCandidates = parseRequestIdCandidatesFromValue(record.message);
  if (messageCandidates.length > 0) {
    return messageCandidates;
  }

  return parseRequestIdCandidatesFromValue(record.content);
}

function redactHeaders(headers: NetworkHeader[] | undefined): NetworkHeader[] | undefined {
  if (!headers) {
    return undefined;
  }

  return headers.map((header) => ({
    ...header,
    value: isSensitiveName(header.name) ? REDACTED_VALUE : header.value,
  }));
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const redactedParams = Array.from(url.searchParams.entries()).map(([key, paramValue]) =>
      `${encodeURIComponent(key)}=${isSensitiveName(key) ? REDACTED_VALUE : encodeURIComponent(paramValue)}`,
    );
    const query = redactedParams.length > 0 ? `?${redactedParams.join("&")}` : "";
    return `${url.origin}${url.pathname}${query}${url.hash}`;
  } catch {
    return redactNonStandardUrl(value);
  }
}

function redactNonStandardUrl(value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart < 0) {
    return value;
  }

  const hashStart = value.indexOf("#", queryStart);
  const queryEnd = hashStart >= 0 ? hashStart : value.length;
  const query = value.slice(queryStart + 1, queryEnd);
  const hash = hashStart >= 0 ? value.slice(hashStart) : "";

  // URL 可能来自浏览器、导入数据或旧快照；即使不是标准绝对 URL，也要尽量脱敏 query，避免敏感参数穿透。
  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of Array.from(params.keys())) {
    if (isSensitiveName(key)) {
      params.set(key, REDACTED_VALUE);
      changed = true;
    }
  }

  return changed ? `${value.slice(0, queryStart)}?${params.toString()}${hash}` : value;
}

function redactBody(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  try {
    return JSON.stringify(redactJsonValue(JSON.parse(value)));
  } catch {
    return redactFormEncodedBody(value);
  }
}

function redactJsonValue(value: unknown, key = ""): unknown {
  if (isSensitiveName(key)) {
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactJsonValue(entryValue, entryKey)]));
  }

  return value;
}

function redactFormEncodedBody(value: string): string {
  const params = new URLSearchParams(value);
  let changed = false;
  for (const key of Array.from(params.keys())) {
    if (isSensitiveName(key)) {
      params.set(key, REDACTED_VALUE);
      changed = true;
    }
  }

  return changed ? params.toString() : value;
}

function formatHeaderBlock(title: string, headers: NetworkHeader[] | undefined): string {
  if (!headers?.length) {
    return "";
  }

  return `${title}:\n${headers.map((header) => `${header.name}: ${truncateForPrompt(header.value, FIELD_LIMIT)}`).join("\n")}`;
}

function truncateForPrompt(value: string, maxLength: number): string {
  return truncateText(value, maxLength).text;
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name);
}
