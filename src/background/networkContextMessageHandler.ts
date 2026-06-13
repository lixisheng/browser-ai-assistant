import type { NetworkRequestDetail, NetworkRequestMeta } from "../shared/types";
import { redactNetworkRequestDetail, redactNetworkRequestMeta } from "../shared/networkContext";

export interface NetworkContextGetSnapshotMessage {
  type: "networkContext.getSnapshot";
  tabId?: number;
}

export interface NetworkContextGetDetailsMessage {
  type: "networkContext.getDetails";
  tabId?: number;
  requestIds: unknown;
}

export type NetworkContextMessage = NetworkContextGetSnapshotMessage | NetworkContextGetDetailsMessage;

type NetworkContextSnapshotResponse =
  | {
      ok: true;
      tabId: number;
      requests: NetworkRequestMeta[];
    }
  | {
      ok: false;
      message: string;
    };

type NetworkContextDetailsResponse =
  | {
      ok: true;
      details: NetworkRequestDetail[];
    }
  | {
      ok: false;
      message: string;
    };

interface NetworkTabChangeInfo {
  status?: string;
}

interface DevtoolsConnection {
  tabId: number;
  port: chrome.runtime.Port;
  requests: unknown;
  refreshing?: boolean;
  disconnected?: boolean;
  disconnectCleanupTimer?: ReturnType<typeof setTimeout>;
}

const DEVTOOLS_UNAVAILABLE_MESSAGE = "请先打开当前标签页 DevTools，并刷新页面后再使用 Network 上下文";
const DEVTOOLS_REFRESHING_MESSAGE = "当前标签页正在刷新，请等待页面加载完成并产生 Network 请求后再使用 Network 上下文";
const DEVTOOLS_DETAIL_TIMEOUT_MESSAGE = "读取 Network 请求详情超时，请确认 DevTools Network 仍处于打开状态";
const DEVTOOLS_DETAIL_SEND_FAILED_MESSAGE = "读取 Network 请求详情失败，请确认 DevTools Network 仍处于打开状态";
const DEVTOOLS_DETAIL_INVALID_REQUEST_IDS_MESSAGE = "Network 请求详情参数无效，请重新选择请求后再试";
const DEVTOOLS_INVALID_RESPONSE_MESSAGE = "DevTools Network 返回数据无效，请刷新页面后重试";
const DEVTOOLS_DISCONNECT_GRACE_MS = 5000;
const DEVTOOLS_DETAIL_REQUEST_TIMEOUT_MS = 30000;
const MAX_DETAIL_REQUEST_IDS = 500;
const MAX_DETAIL_REQUEST_ID_LENGTH = 512;
const connectionsByTabId = new Map<number, DevtoolsConnection>();
const pendingDetailRequests = new Map<
  string,
  {
    resolve: (response: NetworkContextDetailsResponse) => void;
    timeoutTimer: ReturnType<typeof setTimeout>;
  }
>();
let preferredTabId: number | undefined;

export function setPreferredNetworkContextTabId(tabId: number | undefined): void {
  preferredTabId = tabId;
}

export async function handleNetworkContextMessage(message: NetworkContextMessage): Promise<NetworkContextSnapshotResponse | NetworkContextDetailsResponse> {
  const connection = await resolveDevtoolsConnection(message.tabId);
  if (!connection) {
    return { ok: false, message: createDevtoolsUnavailableMessage(message.tabId) };
  }

  if (message.type === "networkContext.getSnapshot") {
    if (connection.refreshing) {
      return { ok: false, message: DEVTOOLS_REFRESHING_MESSAGE };
    }

    const requests = sanitizeNetworkSnapshot(connection.requests);
    if (!requests) {
      return { ok: false, message: DEVTOOLS_INVALID_RESPONSE_MESSAGE };
    }

    return { ok: true, tabId: connection.tabId, requests };
  }

  const normalizedRequestIds = normalizeDetailRequestIds(message.requestIds);
  if (!normalizedRequestIds) {
    return { ok: false, message: DEVTOOLS_DETAIL_INVALID_REQUEST_IDS_MESSAGE };
  }

  if (normalizedRequestIds.length === 0) {
    return { ok: true, details: [] };
  }

  return requestDetailsFromDevtools(connection, normalizedRequestIds);
}

export function handleNetworkDevtoolsPort(port: chrome.runtime.Port): void {
  if (port.name !== "network.devtools") {
    return;
  }

  let registeredTabId: number | undefined;

  port.onMessage.addListener((message: unknown) => {
    if (!isRecord(message)) {
      return;
    }

    if (message.type === "networkContext.devtoolsConnected" || message.type === "networkContext.snapshotUpdated") {
      if (typeof message.tabId !== "number") {
        return;
      }

      registeredTabId = message.tabId;
      const previousConnection = connectionsByTabId.get(message.tabId);
      if (previousConnection?.disconnectCleanupTimer) {
        clearTimeout(previousConnection.disconnectCleanupTimer);
      }
      connectionsByTabId.set(message.tabId, {
        tabId: message.tabId,
        port,
        requests: message.requests,
        refreshing: false,
      });
      return;
    }

    if (message.type !== "networkContext.detailsResponse" || typeof message.rpcId !== "string") {
      return;
    }

    const pendingRequest = pendingDetailRequests.get(message.rpcId);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeoutTimer);
    pendingDetailRequests.delete(message.rpcId);
    pendingRequest.resolve(sanitizeNetworkDetailsResponse(message.response));
  });

  port.onDisconnect.addListener(() => {
    if (registeredTabId !== undefined) {
      markConnectionDisconnected(registeredTabId, port);
    }
  });
}

export function handleNetworkTabUpdated(tabId: number, changeInfo: NetworkTabChangeInfo): void {
  const connection = connectionsByTabId.get(tabId);
  if (!connection) {
    return;
  }

  if (changeInfo.status === "loading") {
    connection.refreshing = true;
    connection.requests = [];
    return;
  }

  if (changeInfo.status === "complete") {
    connection.refreshing = false;
  }
}

async function getActiveTabId(): Promise<number | undefined> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.id;
}

async function resolveDevtoolsConnection(tabId: number | undefined): Promise<DevtoolsConnection | undefined> {
  if (tabId !== undefined) {
    return connectionsByTabId.get(tabId);
  }

  if (preferredTabId !== undefined) {
    const preferredConnection = connectionsByTabId.get(preferredTabId);
    if (preferredConnection) {
      return preferredConnection;
    }
  }

  const activeTabId = await getActiveTabId();
  if (activeTabId !== undefined) {
    const activeConnection = connectionsByTabId.get(activeTabId);
    if (activeConnection) {
      return activeConnection;
    }
  }

  return undefined;
}

function requestDetailsFromDevtools(connection: DevtoolsConnection, requestIds: string[]): Promise<NetworkContextDetailsResponse> {
  if (connection.disconnected) {
    return Promise.resolve({ ok: false, message: DEVTOOLS_UNAVAILABLE_MESSAGE });
  }

  const rpcId = `network-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    const timeoutTimer = setTimeout(() => {
      pendingDetailRequests.delete(rpcId);
      resolve({ ok: false, message: DEVTOOLS_DETAIL_TIMEOUT_MESSAGE });
    }, DEVTOOLS_DETAIL_REQUEST_TIMEOUT_MS);
    pendingDetailRequests.set(rpcId, { resolve, timeoutTimer });
    try {
      connection.port.postMessage({
        type: "networkContext.getDetails",
        rpcId,
        requestIds,
      });
    } catch {
      clearTimeout(timeoutTimer);
      pendingDetailRequests.delete(rpcId);
      resolve({ ok: false, message: DEVTOOLS_DETAIL_SEND_FAILED_MESSAGE });
    }
  });
}

function markConnectionDisconnected(tabId: number, port: chrome.runtime.Port): void {
  const connection = connectionsByTabId.get(tabId);
  if (!connection || connection.port !== port) {
    return;
  }

  connection.disconnected = true;
  connection.disconnectCleanupTimer = setTimeout(() => {
    const latestConnection = connectionsByTabId.get(tabId);
    if (latestConnection === connection && latestConnection.disconnected) {
      connectionsByTabId.delete(tabId);
    }
  }, DEVTOOLS_DISCONNECT_GRACE_MS);
}

function sanitizeNetworkSnapshot(requests: unknown): NetworkRequestMeta[] | undefined {
  if (!Array.isArray(requests) || !requests.every(isNetworkRequestMeta)) {
    return undefined;
  }

  return requests.map(redactNetworkRequestMeta);
}

function sanitizeNetworkDetailsResponse(response: unknown): NetworkContextDetailsResponse {
  if (!isRecord(response)) {
    return { ok: false, message: DEVTOOLS_INVALID_RESPONSE_MESSAGE };
  }

  if (response.ok === false && typeof response.message === "string") {
    return { ok: false, message: response.message };
  }

  if (response.ok !== true || !Array.isArray(response.details) || !response.details.every(isNetworkRequestDetail)) {
    return { ok: false, message: DEVTOOLS_INVALID_RESPONSE_MESSAGE };
  }

  return {
    ok: true,
    details: response.details.map(redactNetworkRequestDetail),
  };
}

function normalizeDetailRequestIds(requestIds: unknown): string[] | undefined {
  if (!Array.isArray(requestIds) || requestIds.length > MAX_DETAIL_REQUEST_IDS) {
    return undefined;
  }

  const normalizedIds = requestIds.map((requestId) => (typeof requestId === "string" ? requestId.trim() : ""));
  if (normalizedIds.some((requestId) => !requestId || requestId.length > MAX_DETAIL_REQUEST_ID_LENGTH)) {
    return undefined;
  }

  return normalizedIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNetworkRequestMeta(value: unknown): value is NetworkRequestMeta {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    typeof value.method === "string" &&
    isOptionalHeaderArray(value.requestHeaders) &&
    isOptionalHeaderArray(value.responseHeaders) &&
    (value.requestBody === undefined || typeof value.requestBody === "string")
  );
}

function isNetworkRequestDetail(value: unknown): value is NetworkRequestDetail {
  if (!isNetworkRequestMeta(value) || !isRecord(value)) {
    return false;
  }

  return (
    (value.responseBody === undefined || typeof value.responseBody === "string") &&
    typeof value.truncated === "boolean" &&
    typeof value.redacted === "boolean"
  );
}

function isOptionalHeaderArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((header) => isRecord(header) && typeof header.name === "string" && typeof header.value === "string"));
}

function createDevtoolsUnavailableMessage(requestedTabId: number | undefined): string {
  const connectedTabIds = Array.from(connectionsByTabId.keys());
  if (connectedTabIds.length === 0) {
    return DEVTOOLS_UNAVAILABLE_MESSAGE;
  }

  const targetTabText = requestedTabId ?? preferredTabId;
  return `${DEVTOOLS_UNAVAILABLE_MESSAGE}（当前绑定标签页：${targetTabText ?? "未知"}；已连接 DevTools 标签页：${connectedTabIds.join("、")}）`;
}
