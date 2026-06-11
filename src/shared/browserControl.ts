export const BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE = "browserControl.setEnabled";
export const BROWSER_CONTROL_DETACHED_MESSAGE_TYPE = "browserControl.detached";

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

export type BrowserControlMessage = BrowserControlSetEnabledMessage;
export type BrowserControlRuntimeEvent = BrowserControlDetachedMessage;

export type BrowserControlResponse =
  | {
      ok: true;
      attached: boolean;
      tabId?: number;
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
