import {
  REPLAY_COMPARE_RESPONSES_TOOL_ID,
  REPLAY_COMPARE_RESPONSES_TOOL_NAME,
  REPLAY_PREPARE_REQUEST_TOOL_ID,
  REPLAY_PREPARE_REQUEST_TOOL_NAME,
  REPLAY_SEND_REQUEST_TOOL_ID,
  REPLAY_SEND_REQUEST_TOOL_NAME,
} from "../../shared/models/toolRegistry";
import type { ModelToolCall, ModelToolResult } from "../../shared/models/types";
import type { NetworkHeader, NetworkRequestDetail, NetworkRequestMeta } from "../../shared/types";
import type { BoundaryGrantContext } from "../../shared/toolAuthorization";
import { createBoundaryGrantScopeKey } from "../../shared/toolAuthorization";
import { redactNetworkText } from "../../shared/networkContext";
import { truncateText } from "../../shared/utils/text";

interface ReplayRecorderLike {
  isEnabled: boolean | (() => boolean);
  getRawRequestMeta(requestId: string): NetworkRequestMeta | undefined;
  getDetails(requestIds: string[]): Promise<NetworkRequestDetail[]>;
}

interface ReplayDraft {
  id: string;
  sourceRequestId: string;
  tabId: number;
  origin: string;
  url: string;
  method: "GET" | "HEAD" | "POST";
  headers: NetworkHeader[];
  requestBody?: string;
  createdAt: number;
  expiresAt: number;
  confirmedGrantId?: string;
  sendResult?: ReplaySendResult;
}

interface ReplaySendResult {
  status?: number;
  ok: boolean;
  redirected: boolean;
  responseBody?: string;
  responseHeaders: NetworkHeader[];
  redacted: boolean;
  truncated: boolean;
}

const REPLAY_TOOL_NAMES = new Set([
  REPLAY_PREPARE_REQUEST_TOOL_ID,
  REPLAY_PREPARE_REQUEST_TOOL_NAME,
  REPLAY_SEND_REQUEST_TOOL_ID,
  REPLAY_SEND_REQUEST_TOOL_NAME,
  REPLAY_COMPARE_RESPONSES_TOOL_ID,
  REPLAY_COMPARE_RESPONSES_TOOL_NAME,
]);
const MAX_DRAFTS = 3;
const MAX_SENDS = 2;
const DRAFT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_CHARS = 256 * 1024;
const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_FIELD_NAME_PATTERN = /^(authorization|cookie|set-cookie|proxy-authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|credential|session|sid|csrf|xsrf)$/i;
const SENSITIVE_TEXT_FIELD_PATTERN = /\b(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|credential|session|sid|csrf|xsrf)\s*[:=]/i;

export class ReplayToolExecutor {
  private readonly drafts = new Map<string, ReplayDraft>();
  private sendCount = 0;

  constructor(
    private readonly recorder: ReplayRecorderLike,
    private readonly fetcher: typeof fetch,
    private readonly getContext: () => { tabId?: number; origin?: string; enhanced: boolean; grant?: BoundaryGrantContext },
  ) {}

  canExpose(): boolean {
    return this.getContext().enhanced && this.isEnabled();
  }

  clear(): void {
    this.drafts.clear();
    this.sendCount = 0;
  }

  async execute(toolCall: ModelToolCall): Promise<ModelToolResult> {
    if (!this.canExpose()) {
      return createErrorResult(toolCall, "当前不是受控增强模式或 Network 采集未启用，无法使用请求重放沙箱。");
    }
    if (!REPLAY_TOOL_NAMES.has(toolCall.name)) {
      return createErrorResult(toolCall, `未知的请求重放工具：${toolCall.name}。`);
    }

    try {
      if (isToolCallName(toolCall.name, REPLAY_PREPARE_REQUEST_TOOL_ID, REPLAY_PREPARE_REQUEST_TOOL_NAME)) {
        return this.prepareRequest(toolCall);
      }
      if (isToolCallName(toolCall.name, REPLAY_SEND_REQUEST_TOOL_ID, REPLAY_SEND_REQUEST_TOOL_NAME)) {
        return await this.sendRequest(toolCall);
      }
      return await this.compareResponses(toolCall);
    } catch (error) {
      console.error("请求重放工具执行失败", error);
      return createErrorResult(toolCall, "请求重放工具执行失败，请稍后重试。");
    }
  }

  private prepareRequest(toolCall: ModelToolCall): ModelToolResult {
    const requestId = normalizeId(toolCall.arguments.requestId);
    if (!requestId) {
      return createErrorResult(toolCall, "replay.prepare_request 需要合法 requestId。");
    }
    const context = this.getContext();
    if (typeof context.tabId !== "number" || !context.origin) {
      return createErrorResult(toolCall, "当前页面授权上下文无效，无法生成请求重放草案。");
    }
    this.removeExpiredDrafts();
    if (this.drafts.size >= MAX_DRAFTS) {
      return createErrorResult(toolCall, `单轮最多保留 ${MAX_DRAFTS} 个请求重放草案。`);
    }
    const meta = this.recorder.getRawRequestMeta(requestId);
    if (!meta) {
      return createErrorResult(toolCall, "未找到对应的 Network 请求。");
    }
    const draftResult = createDraftFromMeta(meta, context.tabId, context.origin);
    if (!draftResult.ok) {
      return createErrorResult(toolCall, draftResult.message);
    }
    const draft = draftResult.draft;
    this.drafts.set(draft.id, draft);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: [
        "已生成请求重放草案，尚未发送网络请求。",
        `- draftId：${draft.id}`,
        `- 来源请求：${draft.sourceRequestId}`,
        `- 方法：${draft.method}`,
        `- 目标：${summarizeUrl(draft.url)}`,
        `- Header：${draft.headers.length ? draft.headers.map((header) => header.name).join("、") : "无"}`,
        `- Body：${draft.requestBody ? `${estimateBytes(draft.requestBody)} 字节` : "无"}`,
        "发送前需要用户通过受控增强边界确认授权。建议调用 boundary.request_user_choice。",
      ].join("\n"),
    };
  }

  private async sendRequest(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const draftId = normalizeId(toolCall.arguments.draftId);
    if (!draftId) {
      return createErrorResult(toolCall, "replay.send_request 需要合法 draftId。");
    }
    const draft = this.getUsableDraft(draftId);
    if (!draft) {
      return createErrorResult(toolCall, "请求重放草案不存在、已过期或不属于当前页面。");
    }
    const grant = this.getContext().grant;
    if (!grant?.grants.includes("send_single_confirmed_replay_request_without_credentials") || grant.scopeKey !== createBoundaryGrantScopeKey(toolCall)) {
      return createErrorResult(toolCall, "发送请求重放前必须先通过用户边界确认。");
    }
    if (this.sendCount >= MAX_SENDS) {
      return createErrorResult(toolCall, `单轮最多发送 ${MAX_SENDS} 次请求重放。`);
    }
    this.sendCount += 1;
    draft.confirmedGrantId = grant.id;
    const result = await this.performFetch(draft);
    draft.sendResult = result;
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: [
        "请求重放已完成：",
        `- draftId：${draft.id}`,
        `- 状态：${result.status ?? "未知"}`,
        `- 重定向：${result.redirected ? "是" : "否"}`,
        `- 响应 Header：${result.responseHeaders.map((header) => header.name).join("、") || "无"}`,
        `- 响应摘要：${result.responseBody || "无可读文本响应"}`,
        result.truncated ? "- 响应已截断。" : "",
        "- 返回内容已按请求重放沙箱规则脱敏。",
      ].filter(Boolean).join("\n"),
    };
  }

  private async compareResponses(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const draftId = normalizeId(toolCall.arguments.draftId);
    if (!draftId) {
      return createErrorResult(toolCall, "replay.compare_responses 需要合法 draftId。");
    }
    const draft = this.getUsableDraft(draftId, true);
    if (!draft?.sendResult) {
      return createErrorResult(toolCall, "请求重放草案尚未发送，无法对比响应。");
    }
    const [original] = await this.recorder.getDetails([draft.sourceRequestId]);
    const originalStatus = original?.status ?? "未知";
    const replayStatus = draft.sendResult.status ?? "未知";
    const originalBody = original?.responseBody ? truncateText(original.responseBody, 600).text : "";
    const replayBody = draft.sendResult.responseBody ? truncateText(draft.sendResult.responseBody, 600).text : "";
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: [
        "请求重放响应对比：",
        `- 原始状态：${originalStatus}`,
        `- 重放状态：${replayStatus}`,
        `- 状态是否一致：${String(originalStatus) === String(replayStatus) ? "是" : "否"}`,
        `- 原始响应摘要：${originalBody || "无可读摘要"}`,
        `- 重放响应摘要：${replayBody || "无可读摘要"}`,
      ].join("\n"),
    };
  }

  private async performFetch(draft: ReplayDraft): Promise<ReplaySendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(draft.url, {
        method: draft.method,
        headers: createReplayHeaders(draft.headers),
        body: draft.method === "POST" ? draft.requestBody : undefined,
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      if (response.type === "opaqueredirect") {
        return createOpaqueRedirectResult(response);
      }
      if (isRedirectStatus(response.status)) {
        const redirectUrl = resolveSameOriginRedirect(response.headers.get("location"), draft.url);
        if (draft.method === "POST" || !redirectUrl.ok) {
          return createReplaySendResult(response, true);
        }
        const redirectedResponse = await this.fetcher(redirectUrl.url, {
          method: draft.method,
          headers: createReplayHeaders(draft.headers),
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
        });
        return redirectedResponse.type === "opaqueredirect"
          ? createOpaqueRedirectResult(redirectedResponse)
          : await createReplaySendResult(redirectedResponse, true);
      }
      return await createReplaySendResult(response, false);
    } finally {
      clearTimeout(timer);
    }
  }

  private getUsableDraft(draftId: string, allowSent = false): ReplayDraft | undefined {
    this.removeExpiredDrafts();
    const draft = this.drafts.get(draftId);
    const context = this.getContext();
    if (!draft || draft.tabId !== context.tabId || draft.origin !== context.origin) {
      return undefined;
    }
    if (!allowSent && draft.sendResult) {
      return undefined;
    }
    return draft;
  }

  private removeExpiredDrafts(): void {
    const now = Date.now();
    for (const [draftId, draft] of this.drafts) {
      if (draft.expiresAt <= now) {
        this.drafts.delete(draftId);
      }
    }
  }

  private isEnabled(): boolean {
    return typeof this.recorder.isEnabled === "function" ? this.recorder.isEnabled() : this.recorder.isEnabled;
  }
}

function createDraftFromMeta(meta: NetworkRequestMeta, tabId: number, origin: string): { ok: true; draft: ReplayDraft } | { ok: false; message: string } {
  const method = meta.method?.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return { ok: false, message: "请求重放沙箱 v1 只允许 GET、HEAD 和受限 POST。" };
  }
  const urlResult = normalizeReplayUrl(meta.url, origin);
  if (!urlResult.ok) {
    return urlResult;
  }
  if (hasSensitiveUrlQuery(urlResult.url)) {
    return { ok: false, message: "请求重放沙箱拒绝包含敏感 query 字段的请求。" };
  }
  const headersResult = normalizeReplayHeaders(meta.requestHeaders);
  if (!headersResult.ok) {
    return headersResult;
  }
  const body = meta.requestBody;
  if (method !== "POST" && body) {
    return { ok: false, message: "非 POST 请求不允许携带请求体。" };
  }
  if (body && estimateBytes(body) > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, message: "请求体超过请求重放沙箱大小上限。" };
  }
  if (body && !isSupportedBody(headersResult.headers)) {
    return { ok: false, message: "请求重放沙箱 v1 只允许 JSON、表单 URL 编码或纯文本请求体。" };
  }
  if (body && hasSensitiveBody(body, headersResult.headers)) {
    return { ok: false, message: "请求重放沙箱拒绝包含敏感 body 字段的请求。" };
  }

  return {
    ok: true,
    draft: {
      id: `replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceRequestId: meta.id,
      tabId,
      origin,
      url: urlResult.url,
      method,
      headers: headersResult.headers,
      requestBody: body,
      createdAt: Date.now(),
      expiresAt: Date.now() + DRAFT_TTL_MS,
    },
  };
}

function normalizeReplayUrl(urlRaw: string, origin: string): { ok: true; url: string } | { ok: false; message: string } {
  try {
    const url = new URL(urlRaw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, message: "请求重放只允许 http 或 https URL。" };
    }
    if (url.origin !== origin) {
      return { ok: false, message: "请求重放 v1 只允许当前受控页面同源目标。" };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, message: "请求重放 URL 无效。" };
  }
}

function normalizeReplayHeaders(headers: NetworkHeader[] | undefined): { ok: true; headers: NetworkHeader[] } | { ok: false; message: string } {
  const result: NetworkHeader[] = [];
  for (const header of headers ?? []) {
    if (SENSITIVE_HEADER_PATTERN.test(header.name)) {
      return { ok: false, message: "请求包含敏感 Header，受控增强模式下拒绝重放。" };
    }
    const lower = header.name.toLowerCase();
    if (["host", "content-length", "connection", "accept-encoding"].includes(lower)) {
      continue;
    }
    result.push({ name: header.name, value: header.value });
  }
  return { ok: true, headers: result };
}

function isSupportedBody(headers: NetworkHeader[]): boolean {
  const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  return contentType.includes("application/json") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.startsWith("text/plain");
}

function hasSensitiveUrlQuery(urlRaw: string): boolean {
  try {
    const url = new URL(urlRaw);
    return Array.from(url.searchParams.keys()).some(isSensitiveFieldName);
  } catch {
    return true;
  }
}

function hasSensitiveBody(body: string, headers: NetworkHeader[]): boolean {
  const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      return hasSensitiveJsonKey(JSON.parse(body));
    } catch {
      return true;
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      return Array.from(new URLSearchParams(body).keys()).some(isSensitiveFieldName);
    } catch {
      return true;
    }
  }
  return SENSITIVE_TEXT_FIELD_PATTERN.test(body);
}

function hasSensitiveJsonKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasSensitiveJsonKey);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(([key, entryValue]) => isSensitiveFieldName(key) || hasSensitiveJsonKey(entryValue));
}

function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAME_PATTERN.test(name);
}

function shouldReadResponseText(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized.includes("json") || normalized.startsWith("text/") || normalized.includes("xml") || normalized.includes("form");
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value.trim() : undefined;
}

function isToolCallName(name: string, legacyId: string, publicName: string): boolean {
  return name === legacyId || name === publicName;
}

function estimateBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function summarizeUrl(urlRaw: string): string {
  try {
    const url = new URL(urlRaw);
    return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
  } catch {
    return "[无效 URL]";
  }
}

function redactHeaderValue(name: string, value: string): string {
  return SENSITIVE_HEADER_PATTERN.test(name) ? "[已脱敏]" : truncateText(value, 300).text;
}

function createReplayHeaders(headers: NetworkHeader[]): Headers {
  const replayHeaders = new Headers();
  for (const header of headers) {
    replayHeaders.append(header.name, header.value);
  }
  return replayHeaders;
}

async function createReplaySendResult(response: Response, redirected: boolean): Promise<ReplaySendResult> {
  const contentType = response.headers.get("content-type") ?? "";
  const headers = Array.from(response.headers.entries()).map(([name, value]) => ({ name, value: redactHeaderValue(name, value) }));
  const text = shouldReadResponseText(contentType) ? await response.text() : "";
  const truncated = truncateText(redactNetworkText(text), MAX_RESPONSE_BODY_CHARS);
  return {
    status: response.status,
    ok: response.ok,
    redirected,
    responseHeaders: headers,
    responseBody: truncated.text,
    redacted: true,
    truncated: truncated.truncated,
  };
}

function createOpaqueRedirectResult(response: Response): ReplaySendResult {
  return {
    status: response.status || undefined,
    ok: false,
    redirected: true,
    responseHeaders: [],
    responseBody: "",
    redacted: true,
    truncated: false,
  };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function resolveSameOriginRedirect(location: string | null, baseUrl: string): { ok: true; url: string } | { ok: false } {
  if (!location) {
    return { ok: false };
  }
  try {
    const base = new URL(baseUrl);
    const next = new URL(location, base);
    return next.origin === base.origin ? { ok: true, url: next.toString() } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function createErrorResult(toolCall: ModelToolCall, content: string): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}
