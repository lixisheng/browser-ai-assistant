import type { BoundaryChoiceOption, BrowserControlBoundaryChoiceRequestMessage } from "../../shared/browserControl";
import { BROWSER_CONTROL_BOUNDARY_CHOICE_REQUEST_MESSAGE_TYPE } from "../../shared/browserControl";
import {
  BOUNDARY_REQUEST_USER_CHOICE_TOOL_ID,
  BOUNDARY_REQUEST_USER_CHOICE_TOOL_NAME,
} from "../../shared/models/toolRegistry";
import type { ModelToolCall, ModelToolResult } from "../../shared/models/types";
import type { BoundaryGrantContext, BrowserAutomationGrant } from "../../shared/toolAuthorization";
import { createBoundaryGrantScopeKey } from "../../shared/toolAuthorization";

export type BoundaryChoiceNotifier = (message: BrowserControlBoundaryChoiceRequestMessage) => void;

export interface BoundaryChoiceResponse {
  selectedChoiceIds: string[];
  otherText?: string;
}

interface PendingBoundaryChoice {
  request: BrowserControlBoundaryChoiceRequestMessage;
  toolCallId: string;
  scopeKey: string;
  choices: BoundaryChoiceOption[];
  allowMultiple: boolean;
  context: { tabId: number; origin: string };
  expiresAt: number;
  resolve: (response: BoundaryChoiceResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

const BOUNDARY_TOOL_NAMES = new Set([BOUNDARY_REQUEST_USER_CHOICE_TOOL_ID, BOUNDARY_REQUEST_USER_CHOICE_TOOL_NAME]);
const ALLOWED_GRANTS: BrowserAutomationGrant[] = [
  "include_sensitive_field_in_current_tool_result",
  "send_single_confirmed_replay_request_without_credentials",
  "expand_runtime_summary_depth",
  "expand_js_or_sourcemap_context",
  "write_sensitive_result_to_chat_once",
];
const DISALLOWED_TEXT_PATTERN = /(验证码|风控|爆破|撞库|绕过|扫描|批量|破解|越权|提权|隐藏采集)/i;
const DEFAULT_EXPIRES_IN_MS = 120000;
const MAX_EXPIRES_IN_MS = 300000;
const MAX_CHOICES = 6;
const MAX_TEXT_LENGTH = 500;

export class BoundaryChoiceToolExecutor {
  private readonly pendingChoices = new Map<string, PendingBoundaryChoice>();
  private grantContext: BoundaryGrantContext | undefined;

  constructor(
    private readonly notify: BoundaryChoiceNotifier,
    private readonly getContext: () => { tabId?: number; origin?: string; enhanced: boolean },
  ) {}

  canExpose(): boolean {
    return this.getContext().enhanced;
  }

  getCurrentGrantContext(): BoundaryGrantContext | undefined {
    const context = this.getContext();
    if (!this.grantContext || Date.now() >= this.grantContext.expiresAt) {
      this.grantContext = undefined;
      return undefined;
    }
    if (this.grantContext.tabId !== context.tabId || this.grantContext.origin !== context.origin) {
      this.grantContext = undefined;
      return undefined;
    }

    return this.grantContext;
  }

  clearGrantContext(): void {
    this.grantContext = undefined;
  }

  clear(): void {
    this.clearGrantContext();
    for (const [requestId, pending] of this.pendingChoices) {
      clearTimeout(pending.timer);
      pending.resolve({ selectedChoiceIds: [], otherText: "授权状态已清理。" });
      this.pendingChoices.delete(requestId);
    }
  }

  respond(requestId: string, response: BoundaryChoiceResponse): boolean {
    const pending = this.pendingChoices.get(requestId);
    if (!pending) {
      return false;
    }
    if (Date.now() >= pending.expiresAt || !isValidBoundaryChoiceResponse(pending, response)) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingChoices.delete(requestId);
    this.createGrantContextFromResponse(pending, response);
    pending.resolve(response);
    return true;
  }

  async execute(toolCall: ModelToolCall): Promise<ModelToolResult> {
    if (!this.canExpose()) {
      return createErrorResult(toolCall, "当前不是受控增强模式，无法请求用户边界确认。");
    }
    if (!BOUNDARY_TOOL_NAMES.has(toolCall.name)) {
      return createErrorResult(toolCall, `未知的边界确认工具：${toolCall.name}。`);
    }

    const normalized = normalizeBoundaryChoiceArguments(toolCall.arguments);
    if (!normalized.ok) {
      return createErrorResult(toolCall, normalized.message);
    }

    const context = this.getContext();
    if (typeof context.tabId !== "number" || !context.origin) {
      return createErrorResult(toolCall, "当前页面授权上下文无效，无法请求用户边界确认。");
    }

    const requestId = `boundary-${toolCall.id}-${Date.now()}`;
    const expiresAt = Date.now() + normalized.expiresInMs;
    const request: BrowserControlBoundaryChoiceRequestMessage = {
      type: BROWSER_CONTROL_BOUNDARY_CHOICE_REQUEST_MESSAGE_TYPE,
      requestId,
      question: normalized.question,
      reason: normalized.reason,
      choices: normalized.choices,
      allowMultiple: normalized.allowMultiple,
      expiresAt,
    };

    const scopeKey = normalizeBoundaryScopeKey(toolCall.arguments);
    const response = await this.waitForUserChoice(request, normalized.expiresInMs, {
      toolCallId: toolCall.id,
      scopeKey,
      choices: normalized.choices,
      allowMultiple: normalized.allowMultiple,
      context: {
        tabId: context.tabId,
        origin: context.origin,
      },
      expiresAt,
    });
    if (response.selectedChoiceIds.length === 0 && response.otherText) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: `用户选择了其他边界：${response.otherText}\n请根据用户补充重新提出更明确的边界确认，或放弃该操作。`,
      };
    }
    if (response.selectedChoiceIds.length === 0) {
      return createErrorResult(toolCall, "用户未授权本次边界请求。");
    }

    const responseSelectedIds = normalized.allowMultiple ? response.selectedChoiceIds : response.selectedChoiceIds.slice(0, 1);
    const responseSelectedChoices = normalized.choices.filter((choice) => responseSelectedIds.includes(choice.id));
    const responseGrants = Array.from(new Set(responseSelectedChoices.flatMap((choice) => choice.grants)));
    if (responseGrants.length > 0 && !scopeKey) {
      return createErrorResult(toolCall, "边界确认缺少目标工具绑定，无法生成可消费的一次性授权。请带 targetToolName 和 targetToolArguments 重新请求用户确认。");
    }

    const selectedChoices = this.grantContext?.id === requestId
      ? normalized.choices.filter((choice) => this.grantContext?.selectedChoiceIds.includes(choice.id))
      : [];
    const grants = this.grantContext?.id === requestId ? this.grantContext.grants : [];
    if (grants.length === 0) {
      return createErrorResult(toolCall, "用户未授权本次边界请求。");
    }

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: [
        "用户已确认本次受控增强边界：",
        `- 选项：${selectedChoices.map((choice) => choice.title).join("、")}`,
        `- 授权：${grants.join("、") || "无"}`,
        `- 有效期至：${new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })}`,
      ].join("\n"),
    };
  }

  private waitForUserChoice(
    request: BrowserControlBoundaryChoiceRequestMessage,
    timeoutMs: number,
    pendingContext: Pick<PendingBoundaryChoice, "toolCallId" | "scopeKey" | "choices" | "allowMultiple" | "context" | "expiresAt">,
  ): Promise<BoundaryChoiceResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingChoices.delete(request.requestId);
        resolve({ selectedChoiceIds: [] });
      }, timeoutMs);
      this.pendingChoices.set(request.requestId, {
        request,
        ...pendingContext,
        resolve,
        timer,
      });
      this.notify(request);
    });
  }

  private createGrantContextFromResponse(pending: PendingBoundaryChoice, response: BoundaryChoiceResponse): void {
    if (response.selectedChoiceIds.length === 0) {
      return;
    }

    const selectedIds = pending.allowMultiple ? response.selectedChoiceIds : response.selectedChoiceIds.slice(0, 1);
    const selectedChoices = pending.choices.filter((choice) => selectedIds.includes(choice.id));
    if (selectedChoices.length === 0) {
      return;
    }
    const grants = Array.from(new Set(selectedChoices.flatMap((choice) => choice.grants)));
    if (grants.length === 0 || !pending.scopeKey) {
      return;
    }

    this.grantContext = {
      id: pending.request.requestId,
      tabId: pending.context.tabId,
      origin: pending.context.origin,
      toolCallId: pending.toolCallId,
      scopeKey: pending.scopeKey,
      grants,
      selectedChoiceIds: selectedChoices.map((choice) => choice.id),
      otherText: response.otherText,
      createdAt: Date.now(),
      expiresAt: pending.expiresAt,
    };
  }
}

function isValidBoundaryChoiceResponse(pending: PendingBoundaryChoice, response: BoundaryChoiceResponse): boolean {
  if (!Array.isArray(response.selectedChoiceIds)) {
    return false;
  }
  if (response.selectedChoiceIds.length === 0) {
    return true;
  }
  if (!pending.allowMultiple && response.selectedChoiceIds.length > 1) {
    return false;
  }
  const choiceIds = new Set(pending.choices.map((choice) => choice.id));
  return response.selectedChoiceIds.every((choiceId) => choiceIds.has(choiceId));
}

function normalizeBoundaryChoiceArguments(args: Record<string, unknown>):
  | { ok: true; question: string; reason: string; choices: BoundaryChoiceOption[]; allowMultiple: boolean; expiresInMs: number }
  | { ok: false; message: string } {
  const question = normalizeText(args.question, 6, MAX_TEXT_LENGTH);
  const reason = normalizeText(args.reason, 1, MAX_TEXT_LENGTH);
  if (!question || !reason) {
    return { ok: false, message: "边界确认问题和原因不能为空。" };
  }
  if (DISALLOWED_TEXT_PATTERN.test(`${question}\n${reason}`)) {
    return { ok: false, message: "边界确认问题包含不允许的高风险意图。" };
  }
  if (!Array.isArray(args.choices) || args.choices.length < 2 || args.choices.length > MAX_CHOICES) {
    return { ok: false, message: "边界确认选项必须包含 2 到 6 项。" };
  }

  const choices: BoundaryChoiceOption[] = [];
  const ids = new Set<string>();
  for (const item of args.choices) {
    if (!item || typeof item !== "object") {
      return { ok: false, message: "边界确认选项格式无效。" };
    }
    const record = item as Record<string, unknown>;
    const id = normalizeChoiceId(record.id);
    const title = normalizeText(record.title, 1, 80);
    const description = normalizeText(record.description, 1, MAX_TEXT_LENGTH);
    const risk = record.risk === "low" || record.risk === "medium" || record.risk === "high" ? record.risk : undefined;
    const grants = normalizeGrants(record.grants);
    if (!id || ids.has(id) || !title || !description || !risk || !grants.ok) {
      return { ok: false, message: "边界确认选项必须包含唯一 id、标题、说明、风险等级和合法授权。" };
    }
    if (DISALLOWED_TEXT_PATTERN.test(`${title}\n${description}`)) {
      return { ok: false, message: "边界确认选项包含不允许的高风险意图。" };
    }
    ids.add(id);
    choices.push({ id, title, description, risk, grants: grants.grants });
  }

  const expiresInMs = typeof args.expiresInMs === "number" && Number.isFinite(args.expiresInMs)
    ? Math.min(Math.max(Math.floor(args.expiresInMs), 10000), MAX_EXPIRES_IN_MS)
    : DEFAULT_EXPIRES_IN_MS;
  return {
    ok: true,
    question,
    reason,
    choices,
    allowMultiple: args.allowMultiple === true,
    expiresInMs,
  };
}

function normalizeText(value: unknown, minLength: number, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    return undefined;
  }
  return trimmed.slice(0, maxLength);
}

function normalizeChoiceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

function normalizeBoundaryScopeKey(args: Record<string, unknown>): string {
  const explicitScopeKey = normalizeScopeKey(args.scopeKey);
  if (explicitScopeKey) {
    return explicitScopeKey;
  }
  const targetToolName = normalizeScopeKey(args.targetToolName);
  if (!targetToolName || !args.targetToolArguments || typeof args.targetToolArguments !== "object" || Array.isArray(args.targetToolArguments)) {
    return "";
  }
  return createBoundaryGrantScopeKey({
    name: targetToolName,
    arguments: args.targetToolArguments as Record<string, unknown>,
  });
}

function normalizeScopeKey(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000 ? value.trim() : "";
}

function normalizeGrants(value: unknown): { ok: true; grants: BrowserAutomationGrant[] } | { ok: false } {
  if (!Array.isArray(value) || value.length > ALLOWED_GRANTS.length) {
    return { ok: false };
  }
  const allowed = new Set(ALLOWED_GRANTS);
  const grants = Array.from(new Set(value.filter((item): item is BrowserAutomationGrant => typeof item === "string" && allowed.has(item as BrowserAutomationGrant))));
  return grants.length === value.length ? { ok: true, grants } : { ok: false };
}

function createErrorResult(toolCall: ModelToolCall, content: string): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}
