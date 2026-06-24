export type BrowserAutomationMode = "normal_restricted" | "controlled_enhanced" | "full_access";

export type ToolAuthorizationMode = "normal" | "runtime_readonly" | "controlled_enhanced" | "full_access";

export type ToolRiskCapability =
  | "browser_control"
  | "network_read"
  | "runtime_readonly"
  | "controlled_enhanced"
  | "request_replay"
  | "boundary_choice"
  | "full_access";

export type BrowserAutomationGrant =
  | "include_sensitive_field_in_current_tool_result"
  | "send_single_confirmed_replay_request_without_credentials"
  | "expand_runtime_summary_depth"
  | "expand_js_or_sourcemap_context"
  | "write_sensitive_result_to_chat_once";

export interface ToolAuthorizationContext {
  mode: ToolAuthorizationMode;
  tabId?: number;
  origin?: string;
  createdAt: number;
  expiresAt?: number;
  reason?: string;
}

export interface BoundaryGrantContext {
  id: string;
  tabId: number;
  origin: string;
  toolCallId: string;
  scopeKey: string;
  grants: BrowserAutomationGrant[];
  selectedChoiceIds: string[];
  otherText?: string;
  createdAt: number;
  expiresAt: number;
}

export const NORMAL_TOOL_AUTHORIZATION_CONTEXT: ToolAuthorizationContext = {
  mode: "normal",
  createdAt: 0,
};

export function isRuntimeReadonlyAuthorized(context: ToolAuthorizationContext, tabId: number | undefined, now = Date.now()): boolean {
  if (typeof tabId !== "number") {
    return false;
  }

  if (context.mode !== "runtime_readonly" && context.mode !== "controlled_enhanced") {
    return false;
  }

  if (context.expiresAt !== undefined && context.expiresAt <= now) {
    return false;
  }

  return context.tabId === tabId;
}

export function isFullAccessAuthorized(context: ToolAuthorizationContext, tabId: number | undefined, now = Date.now()): boolean {
  if (typeof tabId !== "number") {
    return false;
  }

  if (context.mode !== "full_access") {
    return false;
  }

  if (context.expiresAt !== undefined && context.expiresAt <= now) {
    return false;
  }

  return context.tabId === tabId;
}

export function isControlledEnhancedAuthorized(context: ToolAuthorizationContext, tabId: number | undefined, now = Date.now()): boolean {
  if (typeof tabId !== "number") {
    return false;
  }

  if (context.mode !== "controlled_enhanced") {
    return false;
  }

  if (context.expiresAt !== undefined && context.expiresAt <= now) {
    return false;
  }

  return context.tabId === tabId;
}

export function getOriginFromUrl(urlRaw: string): string | undefined {
  try {
    const url = new URL(urlRaw);
    return url.origin;
  } catch {
    return undefined;
  }
}

export function createBoundaryGrantScopeKey(input: { name: string; arguments: Record<string, unknown> }): string {
  return `${normalizeBoundaryScopeToolName(input.name)}\u0000${stableStringify(normalizeBoundaryScopeArguments(input.arguments))}`;
}

function normalizeBoundaryScopeToolName(name: string): string {
  return name.replace(/\./g, "_");
}

function normalizeBoundaryScopeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const { scopeKey: _scopeKey, ...rest } = args;
  return rest;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
