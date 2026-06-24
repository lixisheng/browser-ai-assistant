import {
  FULL_ACCESS_EXECUTE_SCRIPT_TOOL_ID,
  FULL_ACCESS_EXECUTE_SCRIPT_TOOL_NAME,
  FULL_ACCESS_FETCH_TOOL_ID,
  FULL_ACCESS_FETCH_TOOL_NAME,
  FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_ID,
  FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_NAME,
  FULL_ACCESS_READ_STORAGE_TOOL_ID,
  FULL_ACCESS_READ_STORAGE_TOOL_NAME,
  FULL_ACCESS_REVOKE_TOOL_ID,
  FULL_ACCESS_REVOKE_TOOL_NAME,
} from "../../shared/models/toolRegistry";
import type { ModelToolCall, ModelToolResult } from "../../shared/models/types";
import type { ChatNetworkToolAttachment, NetworkRequestDetail } from "../../shared/types";
import { formatNetworkAttachmentSummary } from "../../shared/networkContext";

interface FullAccessConnection {
  evaluate(params: Record<string, unknown>): Promise<unknown>;
}

interface FullAccessRecorder {
  isEnabled: boolean | (() => boolean);
  getDetails(requestIds: string[], options?: { redacted?: boolean }): Promise<NetworkRequestDetail[]>;
}

interface FullAccessContext {
  tabId?: number;
  origin?: string;
  fullAccess: boolean;
}

type FullAccessToolName =
  | typeof FULL_ACCESS_EXECUTE_SCRIPT_TOOL_ID
  | typeof FULL_ACCESS_EXECUTE_SCRIPT_TOOL_NAME
  | typeof FULL_ACCESS_FETCH_TOOL_ID
  | typeof FULL_ACCESS_FETCH_TOOL_NAME
  | typeof FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_ID
  | typeof FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_NAME
  | typeof FULL_ACCESS_READ_STORAGE_TOOL_ID
  | typeof FULL_ACCESS_READ_STORAGE_TOOL_NAME
  | typeof FULL_ACCESS_REVOKE_TOOL_ID
  | typeof FULL_ACCESS_REVOKE_TOOL_NAME;

const FULL_ACCESS_TOOL_NAMES = new Set<string>([
  FULL_ACCESS_EXECUTE_SCRIPT_TOOL_ID,
  FULL_ACCESS_EXECUTE_SCRIPT_TOOL_NAME,
  FULL_ACCESS_FETCH_TOOL_ID,
  FULL_ACCESS_FETCH_TOOL_NAME,
  FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_ID,
  FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_NAME,
  FULL_ACCESS_READ_STORAGE_TOOL_ID,
  FULL_ACCESS_READ_STORAGE_TOOL_NAME,
  FULL_ACCESS_REVOKE_TOOL_ID,
  FULL_ACCESS_REVOKE_TOOL_NAME,
]);

const FULL_ACCESS_DISABLED_MESSAGE = "当前不是完全访问模式，已拒绝执行 full_access.* 工具。";
const FULL_ACCESS_FAILED_MESSAGE = "完全访问工具执行失败，请确认当前页面仍可访问后重试。";
const MAX_DETAIL_IDS = 100;

export class FullAccessToolExecutor {
  constructor(
    private readonly connection: FullAccessConnection,
    private readonly recorder: FullAccessRecorder,
    private readonly getContext: () => FullAccessContext,
    private readonly revoke: () => void,
  ) {}

  canExpose(): boolean {
    return this.getContext().fullAccess && this.isRecorderEnabled();
  }

  async execute(toolCall: ModelToolCall): Promise<ModelToolResult> {
    if (!this.canExpose()) {
      return createFullAccessErrorResult(toolCall, FULL_ACCESS_DISABLED_MESSAGE);
    }

    if (!isFullAccessToolName(toolCall.name)) {
      return createFullAccessErrorResult(toolCall, `未知的完全访问工具：${toolCall.name}。`);
    }

    try {
      if (isToolCallName(toolCall.name, FULL_ACCESS_EXECUTE_SCRIPT_TOOL_ID, FULL_ACCESS_EXECUTE_SCRIPT_TOOL_NAME)) {
        return await this.executeScript(toolCall);
      }
      if (isToolCallName(toolCall.name, FULL_ACCESS_FETCH_TOOL_ID, FULL_ACCESS_FETCH_TOOL_NAME)) {
        return await this.fetchFromPage(toolCall);
      }
      if (isToolCallName(toolCall.name, FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_ID, FULL_ACCESS_GET_NETWORK_DETAILS_TOOL_NAME)) {
        return await this.getNetworkDetails(toolCall);
      }
      if (isToolCallName(toolCall.name, FULL_ACCESS_READ_STORAGE_TOOL_ID, FULL_ACCESS_READ_STORAGE_TOOL_NAME)) {
        return await this.readStorage(toolCall);
      }

      return this.revokeFullAccess(toolCall);
    } catch (error) {
      console.error("完全访问工具执行失败", error);
      return createFullAccessErrorResult(toolCall, FULL_ACCESS_FAILED_MESSAGE);
    }
  }

  private async executeScript(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const validation = normalizeExecuteScriptArguments(toolCall.arguments);
    if (!validation.ok) {
      return createFullAccessErrorResult(toolCall, validation.message);
    }

    const response = await this.connection.evaluate({
      expression: validation.script,
      awaitPromise: validation.awaitPromise,
      returnByValue: true,
    });

    return createFullAccessResult(toolCall, response);
  }

  private async fetchFromPage(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const validation = normalizeFetchArguments(toolCall.arguments);
    if (!validation.ok) {
      return createFullAccessErrorResult(toolCall, validation.message);
    }

    const response = await this.connection.evaluate({
      expression: createPageFetchExpression(validation.request),
      awaitPromise: true,
      returnByValue: true,
    });

    return createFullAccessResult(toolCall, response);
  }

  private async getNetworkDetails(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const requestIds = normalizeRequestIds(toolCall.arguments.requestIds);
    if (!requestIds.ok) {
      return createFullAccessErrorResult(toolCall, requestIds.message);
    }

    const details = await this.recorder.getDetails(requestIds.requestIds, { redacted: false });
    return {
      ...createFullAccessResult(toolCall, details),
      toolAttachments: [createFullAccessNetworkAttachment(toolCall.id, details)],
    };
  }

  private async readStorage(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const extraKeys = Object.keys(toolCall.arguments);
    if (extraKeys.length > 0) {
      return createFullAccessErrorResult(toolCall, `full_access.read_storage 不接受参数：${extraKeys.join("、")}。`);
    }

    const response = await this.connection.evaluate({
      expression: createReadStorageExpression(),
      awaitPromise: false,
      returnByValue: true,
    });

    return createFullAccessResult(toolCall, response);
  }

  private revokeFullAccess(toolCall: ModelToolCall): ModelToolResult {
    const extraKeys = Object.keys(toolCall.arguments);
    if (extraKeys.length > 0) {
      return createFullAccessErrorResult(toolCall, `full_access.revoke 不接受参数：${extraKeys.join("、")}。`);
    }

    this.revoke();
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: "完全访问模式已撤销，浏览器自动化已回到普通模式（受限）。",
    };
  }

  private isRecorderEnabled(): boolean {
    return typeof this.recorder.isEnabled === "function" ? this.recorder.isEnabled() : this.recorder.isEnabled;
  }
}

interface NormalizedFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials: RequestCredentials;
}

function normalizeExecuteScriptArguments(args: Record<string, unknown>): { ok: true; script: string; awaitPromise: boolean } | { ok: false; message: string } {
  const extraKeys = Object.keys(args).filter((key) => key !== "script" && key !== "awaitPromise");
  if (extraKeys.length > 0) {
    return { ok: false, message: `full_access.execute_script 不接受参数：${extraKeys.join("、")}。` };
  }

  if (typeof args.script !== "string" || args.script.length === 0) {
    return { ok: false, message: "full_access.execute_script 需要非空 script。" };
  }

  if (args.awaitPromise !== undefined && typeof args.awaitPromise !== "boolean") {
    return { ok: false, message: "awaitPromise 必须是布尔值。" };
  }

  return { ok: true, script: args.script, awaitPromise: args.awaitPromise !== false };
}

function normalizeFetchArguments(args: Record<string, unknown>): { ok: true; request: NormalizedFetchRequest } | { ok: false; message: string } {
  const extraKeys = Object.keys(args).filter((key) => key !== "url" && key !== "method" && key !== "headers" && key !== "body" && key !== "credentials");
  if (extraKeys.length > 0) {
    return { ok: false, message: `full_access.fetch 不接受参数：${extraKeys.join("、")}。` };
  }

  if (typeof args.url !== "string" || args.url.length === 0) {
    return { ok: false, message: "full_access.fetch 需要非空 url。" };
  }

  if (args.method !== undefined && typeof args.method !== "string") {
    return { ok: false, message: "method 必须是字符串。" };
  }

  if (args.body !== undefined && typeof args.body !== "string") {
    return { ok: false, message: "body 必须是字符串。" };
  }

  const headers = normalizeHeaders(args.headers);
  if (!headers.ok) {
    return headers;
  }

  const credentials = args.credentials;
  if (credentials !== undefined && credentials !== "include" && credentials !== "same-origin" && credentials !== "omit") {
    return { ok: false, message: "credentials 必须是 include、same-origin 或 omit。" };
  }

  return {
    ok: true,
    request: {
      url: args.url,
      method: typeof args.method === "string" && args.method.length > 0 ? args.method : undefined,
      headers: headers.headers,
      body: typeof args.body === "string" ? args.body : undefined,
      credentials: credentials ?? "include",
    },
  };
}

function normalizeHeaders(value: unknown): { ok: true; headers?: Record<string, string> } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "headers 必须是对象。" };
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue !== "string") {
      return { ok: false, message: "headers 的值必须是字符串。" };
    }
    headers[name] = headerValue;
  }

  return { ok: true, headers };
}

function normalizeRequestIds(value: unknown): { ok: true; requestIds: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DETAIL_IDS || value.some((entry) => typeof entry !== "string" || !entry)) {
    return { ok: false, message: "requestIds 必须是 1 到 100 个非空字符串组成的数组。" };
  }

  return { ok: true, requestIds: value };
}
function createPageFetchExpression(request: NormalizedFetchRequest): string {
  return `(() => {
    const request = ${JSON.stringify(request)};
    return fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: request.credentials ?? "include",
    }).then(async (response) => ({
      url: response.url,
      redirected: response.redirected,
      type: response.type,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: Array.from(response.headers.entries()).map(([name, value]) => ({ name, value })),
      body: await response.text(),
    }));
  })()`;
}

function createReadStorageExpression(): string {
  return `(() => ({
    location: {
      href: location.href,
      origin: location.origin,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    },
    title: document.title,
    referrer: document.referrer,
    cookie: document.cookie,
    localStorage: Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, key === null ? null : localStorage.getItem(key)];
    }).filter(([key]) => key !== null)),
    sessionStorage: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index);
      return [key, key === null ? null : sessionStorage.getItem(key)];
    }).filter(([key]) => key !== null)),
  }))()`;
}

function createFullAccessResult(toolCall: ModelToolCall, value: unknown): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content: stringifyRawValue(value),
  };
}

function createFullAccessNetworkAttachment(sourceToolCallId: string, requests: NetworkRequestDetail[]): ChatNetworkToolAttachment {
  const rawRequests = requests.map((request) => ({ ...request, redacted: false }));
  return {
    id: `tool-attachment-${sourceToolCallId}`,
    kind: "network",
    title: "Network 请求详情",
    summary: formatNetworkAttachmentSummary(rawRequests),
    sourceToolCallId,
    createdAt: Date.now(),
    redacted: false,
    fullAccess: true,
    truncated: rawRequests.some((request) => request.truncated),
    requests: rawRequests,
  };
}

function createFullAccessErrorResult(toolCall: ModelToolCall, content: string): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}

function stringifyRawValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isFullAccessToolName(name: string): name is FullAccessToolName {
  return FULL_ACCESS_TOOL_NAMES.has(name);
}

function isToolCallName(name: string, id: string, compatibleName: string): boolean {
  return name === id || name === compatibleName;
}
