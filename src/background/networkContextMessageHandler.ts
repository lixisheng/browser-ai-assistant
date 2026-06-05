import type { NetworkRequestDetail, NetworkRequestMeta } from "../shared/types";

export interface NetworkContextGetSnapshotMessage {
  type: "networkContext.getSnapshot";
  tabId?: number;
}

export interface NetworkContextGetDetailsMessage {
  type: "networkContext.getDetails";
  tabId?: number;
  requestIds: string[];
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

type DevtoolsPortMessage =
  | {
      type: "networkContext.devtoolsConnected";
      tabId: number;
      requests: NetworkRequestMeta[];
    }
  | {
      type: "networkContext.snapshotUpdated";
      tabId: number;
      requests: NetworkRequestMeta[];
    }
  | {
      type: "networkContext.detailsResponse";
      rpcId: string;
      response: NetworkContextDetailsResponse;
    };

interface NetworkTabChangeInfo {
  status?: string;
}

interface DevtoolsConnection {
  tabId: number;
  port: chrome.runtime.Port;
  requests: NetworkRequestMeta[];
  refreshing?: boolean;
  disconnected?: boolean;
  disconnectCleanupTimer?: ReturnType<typeof setTimeout>;
}

const DEVTOOLS_UNAVAILABLE_MESSAGE = "请先打开当前标签页 DevTools，并刷新页面后再使用 Network 上下文";
const DEVTOOLS_REFRESHING_MESSAGE = "当前标签页正在刷新，请等待页面加载完成并产生 Network 请求后再使用 Network 上下文";
const DEVTOOLS_DETAIL_TIMEOUT_MESSAGE = "读取 Network 请求详情超时，请确认 DevTools Network 仍处于打开状态";
const DEVTOOLS_DETAIL_SEND_FAILED_MESSAGE = "读取 Network 请求详情失败，请确认 DevTools Network 仍处于打开状态";
const DEVTOOLS_DISCONNECT_GRACE_MS = 5000;
const DEVTOOLS_DETAIL_REQUEST_TIMEOUT_MS = 30000;
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

    return { ok: true, tabId: connection.tabId, requests: connection.requests };
  }

  if (message.requestIds.length === 0) {
    return { ok: true, details: [] };
  }

  return requestDetailsFromDevtools(connection, message.requestIds);
}

export function handleNetworkDevtoolsPort(port: chrome.runtime.Port): void {
  if (port.name !== "network.devtools") {
    return;
  }

  let registeredTabId: number | undefined;

  port.onMessage.addListener((message: DevtoolsPortMessage) => {
    if (message.type === "networkContext.devtoolsConnected" || message.type === "networkContext.snapshotUpdated") {
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

    const pendingRequest = pendingDetailRequests.get(message.rpcId);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeoutTimer);
    pendingDetailRequests.delete(message.rpcId);
    pendingRequest.resolve(message.response);
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

function createDevtoolsUnavailableMessage(requestedTabId: number | undefined): string {
  const connectedTabIds = Array.from(connectionsByTabId.keys());
  if (connectedTabIds.length === 0) {
    return DEVTOOLS_UNAVAILABLE_MESSAGE;
  }

  const targetTabText = requestedTabId ?? preferredTabId;
  return `${DEVTOOLS_UNAVAILABLE_MESSAGE}（当前绑定标签页：${targetTabText ?? "未知"}；已连接 DevTools 标签页：${connectedTabIds.join("、")}）`;
}
