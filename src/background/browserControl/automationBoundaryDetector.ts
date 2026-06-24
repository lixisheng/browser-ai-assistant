import type { ModelToolResult } from "../../shared/models/types";
import type { BrowserAutomationGrant } from "../../shared/toolAuthorization";

export interface AutomationBoundaryConfirmationRequest {
  question: string;
  reason: string;
  choices: Array<{
    id: string;
    title: string;
    description: string;
    risk: "low" | "medium" | "high";
    grants: BrowserAutomationGrant[];
  }>;
  allowMultiple: boolean;
  expiresInMs: number;
}

export type AutomationBoundaryConfirmation = (request: AutomationBoundaryConfirmationRequest) => Promise<string | undefined>;

interface BoundarySignal {
  id: string;
  label: string;
  reason: string;
  grants: BrowserAutomationGrant[];
  risk: "low" | "medium" | "high";
}

const REDACTED_PATTERNS = [/\[已脱敏]/, /\[REDACTED]/i, /Redacted:\s*true/i];
const TRUNCATED_PATTERNS = [/Truncated:\s*true/i, /已截断/, /\[TRUNCATED]/i, /truncated/i];
const REPLAY_CONFIRMATION_PATTERNS = [/发送请求重放前必须先通过用户边界确认/];
const REPLAY_SANDBOX_BOUNDARY_PATTERNS = [
  /请求重放.*只允许/,
  /请求重放.*拒绝/,
  /请求重放.*过期/,
  /请求重放.*不属于当前页面/,
  /请求重放.*不存在/,
  /请求重放.*单轮最多/,
  /请求重放.*敏感 Header/,
  /请求重放.*不允许携带请求体/,
  /请求重放.*尚未发送/,
  /请求包含敏感 Header/,
  /请求体超过请求重放沙箱大小上限/,
];
const JS_CONTEXT_PATTERNS = [
  /需要 allowSameOriginFetch=true/,
  /同源补位失败/,
  /同源 JS 补位/,
  /Source Map 不包含 sourcesContent/,
  /Source Map .*?(读取|只允许|拒绝|超过|缺少|无效|不可用|失败|超时|被浏览器拒绝)/,
  /inline Source Map .*?(只接受|超过|无效|失败)/,
  /本阶段不主动拉取原始源码文件/,
];
const RUNTIME_BOUNDARY_PATTERNS = [
  /运行时只读分析未授权/,
  /运行时路径只允许安全的点号路径/,
  /运行时路径不能只指向/,
  /运行时路径包含高风险字段/,
  /完全访问授权仍处于后续阶段预留状态/,
  /当前浏览器自动化模式不允许执行 runtime\.\*/,
];
const SENSITIVE_FIELD_PATTERNS = [
  /\b(?:Authorization|Cookie|Set-Cookie|Proxy-Authorization)\s*:/i,
  /"(?:token|access[_-]?token|refresh[_-]?token|secret|password|passwd|session|csrf|xsrf)"\s*:/i,
  /\b(?:token|access[_-]?token|refresh[_-]?token|secret|password|passwd|session|csrf|xsrf)=/i,
  /凭据/,
  /敏感字段/,
];

export async function applyAutomationBoundaryConfirmation(
  result: ModelToolResult,
  confirmBoundary?: AutomationBoundaryConfirmation,
): Promise<ModelToolResult> {
  const signals = detectAutomationBoundarySignals(result.content);
  if (signals.length === 0) {
    return result;
  }

  let confirmation: string | undefined;
  try {
    confirmation = await confirmBoundary?.(createBoundaryConfirmationRequest(signals));
  } catch (error) {
    console.error("受控增强边界确认失败", error);
  }
  return {
    ...result,
    content: [
      result.content,
      confirmation,
      createBoundaryHint(signals, Boolean(confirmation)),
    ].filter(Boolean).join("\n\n"),
  };
}

export function detectAutomationBoundarySignals(content: string): BoundarySignal[] {
  const signals: BoundarySignal[] = [];
  appendSignalIfMatch(signals, content, {
    id: "redacted_sensitive_fields",
    label: "脱敏或敏感字段",
    reason: "工具结果包含脱敏标记、敏感字段名或敏感字段摘要。",
    grants: ["include_sensitive_field_in_current_tool_result", "write_sensitive_result_to_chat_once"],
    risk: "medium",
  }, [...REDACTED_PATTERNS, ...SENSITIVE_FIELD_PATTERNS]);
  appendSignalIfMatch(signals, content, {
    id: "truncated_summary",
    label: "截断摘要",
    reason: "工具结果已被截断，继续分析可能需要用户确认是否扩展摘要深度或上下文范围。",
    grants: ["expand_runtime_summary_depth", "expand_js_or_sourcemap_context"],
    risk: "medium",
  }, TRUNCATED_PATTERNS);
  appendSignalIfMatch(signals, content, {
    id: "request_replay_confirmation",
    label: "请求重放发送确认",
    reason: "工具结果涉及请求重放草案或发送动作，必须由用户逐次确认边界。",
    grants: ["send_single_confirmed_replay_request_without_credentials"],
    risk: "medium",
  }, [...REPLAY_CONFIRMATION_PATTERNS, ...REPLAY_SANDBOX_BOUNDARY_PATTERNS]);
  appendSignalIfMatch(signals, content, {
    id: "js_or_sourcemap_context_expansion",
    label: "JS/Source Map 上下文扩展",
    reason: "工具结果提示需要读取更多同源 JS、Source Map 或原始上下文。",
    grants: ["expand_js_or_sourcemap_context"],
    risk: "medium",
  }, JS_CONTEXT_PATTERNS);
  appendSignalIfMatch(signals, content, {
    id: "runtime_or_full_access_boundary",
    label: "Runtime 或完全访问边界",
    reason: "工具结果触达运行时高风险路径、完全访问占位或当前模式不允许的能力边界。",
    grants: ["expand_runtime_summary_depth"],
    risk: "high",
  }, RUNTIME_BOUNDARY_PATTERNS);
  return signals;
}

function createBoundaryConfirmationRequest(signals: BoundarySignal[]): AutomationBoundaryConfirmationRequest {
  const labels = signals.map((signal) => signal.label).join("、");
  return {
    question: `允许处理${labels}吗？`,
    reason: "本轮需要用户确认后才可继续。",
    choices: [
      ...signals.slice(0, 4).map((signal) => ({
        id: `allow_${signal.id}`,
        title: `允许${signal.label}`,
        description: "仅本轮生效，不保存长期权限。",
        risk: signal.risk,
        grants: signal.grants,
      })),
      {
        id: "keep_current_boundary",
        title: "不允许",
        description: "保持当前脱敏或受限结果。",
        risk: "low",
        grants: [],
      },
    ],
    allowMultiple: signals.length > 1,
    expiresInMs: 120000,
  };
}

function createBoundaryHint(signals: BoundarySignal[], confirmed: boolean): string {
  return [
    "## 受控增强权限边界提示",
    `检测到：${signals.map((signal) => signal.label).join("、")}。`,
    confirmed
      ? "用户已经完成本轮边界确认；继续分析时必须严格遵守上方确认结果，不得推断、还原、请求或输出未确认的敏感原文。"
      : "如果当前处于受控增强模式，下一步必须先调用 boundary_request_user_choice 主动询问用户；在用户确认前，不得继续执行依赖该边界的分析、请求重放、上下文扩展或运行时扩展。",
  ].join("\n");
}

function appendSignalIfMatch(signals: BoundarySignal[], content: string, signal: BoundarySignal, patterns: RegExp[]): void {
  if (signals.some((item) => item.id === signal.id)) {
    return;
  }
  if (patterns.some((pattern) => pattern.test(content))) {
    signals.push(signal);
  }
}
