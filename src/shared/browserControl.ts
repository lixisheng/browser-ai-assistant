export const BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE = "browserControl.setEnabled";
export const BROWSER_CONTROL_DETACHED_MESSAGE_TYPE = "browserControl.detached";
import type { BrowserAutomationGrant, BrowserAutomationMode } from "./toolAuthorization";

export const BROWSER_CONTROL_SET_RUNTIME_READONLY_MESSAGE_TYPE = "browserControl.setRuntimeReadonly";
export const BROWSER_CONTROL_RUNTIME_READONLY_CHANGED_MESSAGE_TYPE = "browserControl.runtimeReadonlyChanged";
export const BROWSER_CONTROL_SET_AUTOMATION_MODE_MESSAGE_TYPE = "browserControl.setAutomationMode";
export const BROWSER_CONTROL_AUTOMATION_MODE_CHANGED_MESSAGE_TYPE = "browserControl.automationModeChanged";
export const BROWSER_CONTROL_BOUNDARY_CHOICE_REQUEST_MESSAGE_TYPE = "browserControl.boundaryChoiceRequest";
export const BROWSER_CONTROL_BOUNDARY_CHOICE_RESPOND_MESSAGE_TYPE = "browserControl.boundaryChoiceRespond";

export interface BrowserControlSetEnabledMessage {
  type: typeof BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE;
  enabled: boolean;
  tabId?: number;
}

export interface BrowserControlDetachedMessage {
  type: typeof BROWSER_CONTROL_DETACHED_MESSAGE_TYPE;
  tabId?: number;
  reason: "canceled_by_user" | "target_closed" | "tab_removed" | "disabled_by_user" | "unknown";
}

export interface BrowserControlSetRuntimeReadonlyMessage {
  type: typeof BROWSER_CONTROL_SET_RUNTIME_READONLY_MESSAGE_TYPE;
  enabled: boolean;
  reason?: string;
  // 预留给后续多受控页授权校验；当前阶段 background 只信任已 attach 的当前 tab。
  tabId?: number;
}

export interface BrowserControlRuntimeReadonlyChangedMessage {
  type: typeof BROWSER_CONTROL_RUNTIME_READONLY_CHANGED_MESSAGE_TYPE;
  enabled: boolean;
  tabId?: number;
  expiresAt?: number;
}

export interface BrowserControlSetAutomationModeMessage {
  type: typeof BROWSER_CONTROL_SET_AUTOMATION_MODE_MESSAGE_TYPE;
  mode: BrowserAutomationMode;
  reason?: string;
}

export interface BrowserControlAutomationModeChangedMessage {
  type: typeof BROWSER_CONTROL_AUTOMATION_MODE_CHANGED_MESSAGE_TYPE;
  mode: BrowserAutomationMode;
  tabId?: number;
  expiresAt?: number;
}

export interface BoundaryChoiceOption {
  id: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  grants: BrowserAutomationGrant[];
}

export interface BrowserControlBoundaryChoiceRequestMessage {
  type: typeof BROWSER_CONTROL_BOUNDARY_CHOICE_REQUEST_MESSAGE_TYPE;
  requestId: string;
  question: string;
  reason: string;
  choices: BoundaryChoiceOption[];
  allowMultiple: boolean;
  expiresAt: number;
}

export interface BrowserControlBoundaryChoiceRespondMessage {
  type: typeof BROWSER_CONTROL_BOUNDARY_CHOICE_RESPOND_MESSAGE_TYPE;
  requestId: string;
  selectedChoiceIds: string[];
  otherText?: string;
}

export type BrowserControlMessage =
  | BrowserControlSetEnabledMessage
  | BrowserControlSetRuntimeReadonlyMessage
  | BrowserControlSetAutomationModeMessage
  | BrowserControlBoundaryChoiceRespondMessage;
export type BrowserControlRuntimeEvent =
  | BrowserControlDetachedMessage
  | BrowserControlRuntimeReadonlyChangedMessage
  | BrowserControlAutomationModeChangedMessage
  | BrowserControlBoundaryChoiceRequestMessage;

export type BrowserControlResponse =
  | {
      ok: true;
      attached: boolean;
      tabId?: number;
      expiresAt?: number;
      message: string;
    }
  | {
      ok: false;
      message: string;
    };

const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "view-source:",
];

const RESTRICTED_URL_PREFIXES_EXACT = [
  "https://chromewebstore.google.com",
  "https://chrome.google.com/webstore",
];

export function getBrowserControlTabUrl(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl"> | undefined): string {
  return tab?.url || tab?.pendingUrl || "";
}

export function isBrowserControlRestrictedUrl(urlRaw: string): boolean {
  const url = urlRaw.trim().toLowerCase();
  if (!url) {
    return true;
  }

  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix)) ||
    RESTRICTED_URL_PREFIXES_EXACT.some((prefix) => url.startsWith(prefix));
}
