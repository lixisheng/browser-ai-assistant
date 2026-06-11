import {
  BROWSER_CONTROL_DETACHED_MESSAGE_TYPE,
  BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE,
  getBrowserControlTabUrl,
  isBrowserControlRestrictedUrl,
  type BrowserControlMessage,
  type BrowserControlResponse,
} from "../shared/browserControl";
import type { ModelToolCall, ModelToolResult } from "../shared/models/types";

type Debuggee = chrome.debugger.Debuggee;
type ChromeApi = typeof chrome;
type DebuggerDetachReason = `${chrome.debugger.DetachReason}`;
type BrowserControlDetachedReason = "canceled_by_user" | "target_closed" | "tab_removed" | "disabled_by_user" | "unknown";
type BrowserControlTabInfo = { title: string; url: string };

interface SnapshotFormatBudget {
  lines: string[];
  visitedNodeIds: Set<string>;
  nodeCount: number;
  characterCount: number;
  truncated: boolean;
}

interface AccessibilityProperty {
  name?: string;
  value?: {
    value?: unknown;
  };
}

interface AccessibilityNode {
  nodeId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: {
    value?: unknown;
  };
  name?: {
    value?: unknown;
  };
  value?: {
    value?: unknown;
  };
  properties?: AccessibilityProperty[];
  childIds?: string[];
}

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const SNAPSHOT_MAX_LENGTH = 20_000;
const SNAPSHOT_MAX_DEPTH = 50;
const SNAPSHOT_MAX_NODE_COUNT = 1_000;
const SNAPSHOT_EMPTY_TEXT = "未读取到可访问节点。";
const SNAPSHOT_TRUNCATED_TEXT = "快照内容过长，已停止继续展开。";
const BROWSER_SNAPSHOT_DISABLED_MESSAGE = "浏览器控制未开启，无法读取页面快照。请先在顶部浏览器控制按钮中显式开启。";
const BROWSER_SNAPSHOT_FAILED_MESSAGE = "读取页面快照失败，请确认当前页面仍可访问后重试。";
const SKIPPED_AX_ROLES = new Set(["none", "generic", "section", "paragraph", "StaticText", "InlineTextBox"]);

function getChromeApi(): ChromeApi | undefined {
  return globalThis.chrome;
}

export class BrowserDebuggerConnection {
  private currentTabId: number | undefined;
  private attached = false;
  private detachListenersInstalled = false;

  constructor(private readonly chromeApi: ChromeApi | undefined = getChromeApi()) {}

  get attachedTabId(): number | undefined {
    return this.attached ? this.currentTabId : undefined;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  installDetachListener(onDetach: (tabId: number, reason: DebuggerDetachReason) => void): void {
    if (this.detachListenersInstalled || !this.chromeApi?.debugger?.onDetach?.addListener) {
      return;
    }

    this.detachListenersInstalled = true;
    this.chromeApi.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== this.currentTabId) {
        return;
      }

      const detachedTabId = this.currentTabId;
      this.attached = false;
      this.currentTabId = undefined;
      if (detachedTabId) {
        onDetach(detachedTabId, reason);
      }
    });
  }

  async attach(tabId: number, shouldContinue: () => boolean = () => true): Promise<BrowserControlResponse> {
    if (this.attached && this.currentTabId === tabId) {
      return { ok: true, attached: true, tabId, message: "浏览器控制已连接当前标签页。" };
    }

    if (this.attached) {
      await this.detach();
    }

    const chromeApi = this.chromeApi;
    if (!chromeApi?.debugger?.attach) {
      return { ok: false, message: "当前浏览器不支持调试器接口，无法开启浏览器控制。" };
    }

    const debuggee: Debuggee = { tabId };
    const attached = await new Promise<BrowserControlResponse>((resolve) => {
      chromeApi.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION, () => {
        const lastError = chromeApi.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, message: normalizeDebuggerError(lastError.message) });
          return;
        }

        this.attached = true;
        this.currentTabId = tabId;
        resolve({ ok: true, attached: true, tabId, message: "浏览器控制已开启，Chrome 会显示正在调试提示。" });
      });
    });

    if (!attached.ok) {
      return attached;
    }

    if (!shouldContinue()) {
      await this.detach(tabId);
      return { ok: true, attached: false, message: "浏览器控制已关闭。" };
    }

    const domainResult = await this.enableRequiredDomains();
    if (!domainResult.ok) {
      await this.detach();
      return domainResult;
    }

    if (!shouldContinue()) {
      await this.detach(tabId);
      return { ok: true, attached: false, message: "浏览器控制已关闭。" };
    }

    return attached;
  }

  async detach(tabId = this.currentTabId): Promise<void> {
    const chromeApi = this.chromeApi;
    if (!this.attached || !tabId || !chromeApi?.debugger?.detach) {
      this.attached = false;
      this.currentTabId = undefined;
      return;
    }

    try {
      await new Promise<void>((resolve) => {
        chromeApi.debugger.detach({ tabId }, () => {
          const lastError = chromeApi.runtime.lastError;
          // 关闭或外部断开时读取 lastError，避免 Chrome 抛出未消费的 runtime 错误。
          void lastError?.message;
          resolve();
        });
      });
    } finally {
      // tab 已关闭或用户取消调试时，Chrome 可能拒绝 detach；本地状态仍必须立即清理，避免留下假连接。
      this.attached = false;
      this.currentTabId = undefined;
    }
  }

  private async enableRequiredDomains(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.sendCommand("Runtime.enable");
      await this.sendCommand("Page.enable");
      await this.sendCommand("DOM.enable");
      await this.sendCommand("Accessibility.enable");
      return { ok: true };
    } catch {
      return { ok: false, message: "浏览器调试会话初始化失败，请关闭浏览器控制后重试。" };
    }
  }

  async getFullAccessibilityTree(): Promise<unknown> {
    return this.sendCommand("Accessibility.getFullAXTree");
  }

  private async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const chromeApi = this.chromeApi;
    const currentTabId = this.currentTabId;
    if (!this.attached || !currentTabId || !chromeApi?.debugger?.sendCommand) {
      throw new Error("debugger 未连接");
    }

    return new Promise((resolve, reject) => {
      chromeApi.debugger.sendCommand({ tabId: currentTabId }, method, params, (result) => {
        const lastError = chromeApi.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(result);
      });
    });
  }
}

export class BrowserControlSnapshotManager {
  private snapshotVersion = 0;
  private lastPageIdentity = "";
  private readonly uidToBackendNodeId = new Map<string, number>();
  private readonly uidToAxNode = new Map<string, AccessibilityNode>();
  private readonly backendNodeIdToUid = new Map<number, string>();

  constructor(
    private readonly connection: BrowserDebuggerConnection,
    private readonly getTabInfo: () => Promise<BrowserControlTabInfo>,
  ) {}

  getBackendNodeId(uid: string): number | undefined {
    return this.uidToBackendNodeId.get(uid);
  }

  getAXNode(uid: string): AccessibilityNode | undefined {
    return this.uidToAxNode.get(uid);
  }

  async takeSnapshot(): Promise<string> {
    const response = await this.connection.getFullAccessibilityTree();
    const nodes = normalizeAccessibilityNodes(response);
    const tabInfo = await this.getTabInfo();
    this.resetUidCacheIfPageChanged(createPageIdentity(tabInfo));
    const body = this.formatSnapshot(nodes);
    const content = [
      "# 浏览器页面快照",
      `页面标题：${tabInfo.title || "无标题"}`,
      `页面 URL：${tabInfo.url || "未知"}`,
      "",
      body || SNAPSHOT_EMPTY_TEXT,
    ].join("\n");

    return truncateSnapshot(content);
  }

  private formatSnapshot(nodes: AccessibilityNode[]): string {
    this.snapshotVersion += 1;
    this.uidToBackendNodeId.clear();
    this.uidToAxNode.clear();

    if (!nodes.length) {
      this.backendNodeIdToUid.clear();
      return SNAPSHOT_EMPTY_TEXT;
    }

    const nodeById = new Map<string, AccessibilityNode>();
    for (const node of nodes) {
      if (node.nodeId) {
        nodeById.set(node.nodeId, node);
      }
    }

    const root = nodes.find((node) => getAxValue(node.role) === "RootWebArea") ?? nodes[0];
    const seenBackendNodeIds = new Set<number>();
    const budget: SnapshotFormatBudget = {
      lines: [],
      visitedNodeIds: new Set(),
      nodeCount: 0,
      characterCount: 0,
      truncated: false,
    };
    this.formatNode(root, nodeById, 0, seenBackendNodeIds, { value: 0 }, budget);

    for (const backendNodeId of Array.from(this.backendNodeIdToUid.keys())) {
      if (!seenBackendNodeIds.has(backendNodeId)) {
        this.backendNodeIdToUid.delete(backendNodeId);
      }
    }

    return budget.lines.join("\n") || SNAPSHOT_EMPTY_TEXT;
  }

  private formatNode(
    node: AccessibilityNode | undefined,
    nodeById: Map<string, AccessibilityNode>,
    depth: number,
    seenBackendNodeIds: Set<number>,
    uidCounter: { value: number },
    budget: SnapshotFormatBudget,
  ): void {
    if (!node || budget.truncated) {
      return;
    }

    if (node.nodeId && budget.visitedNodeIds.has(node.nodeId)) {
      return;
    }
    if (node.nodeId) {
      budget.visitedNodeIds.add(node.nodeId);
    }

    if (depth >= SNAPSHOT_MAX_DEPTH) {
      this.appendSnapshotLine(`${"  ".repeat(SNAPSHOT_MAX_DEPTH)}- 节点层级过深，已停止继续展开。`, budget);
      return;
    }

    const interesting = isInterestingAxNode(node);

    if (interesting) {
      const parts = this.createNodeParts(node, seenBackendNodeIds, uidCounter);
      if (parts.length) {
        this.appendSnapshotLine(`${"  ".repeat(depth)}- ${parts.join(" ")}`, budget);
      }
    }

    for (const childId of node.childIds ?? []) {
      this.formatNode(nodeById.get(childId), nodeById, depth + (interesting ? 1 : 0), seenBackendNodeIds, uidCounter, budget);
      if (budget.truncated) {
        return;
      }
    }
  }

  private createNodeParts(node: AccessibilityNode, seenBackendNodeIds: Set<number>, uidCounter: { value: number }): string[] {
    const parts: string[] = [];
    if (typeof node.backendDOMNodeId === "number") {
      const uid = this.resolveUid(node.backendDOMNodeId, uidCounter);
      this.uidToBackendNodeId.set(uid, node.backendDOMNodeId);
      this.uidToAxNode.set(uid, node);
      seenBackendNodeIds.add(node.backendDOMNodeId);
      parts.push(`uid=${uid}`);
    }

    const role = getAxValue(node.role);
    const name = getAxValue(node.name);
    const value = getAxValue(node.value);
    if (role) {
      parts.push(role);
    }
    if (name) {
      parts.push(JSON.stringify(name));
    }
    if (value && value !== name) {
      parts.push(`value=${JSON.stringify(value)}`);
    }

    for (const property of node.properties ?? []) {
      if (!property.name || !["checked", "disabled", "expanded", "selected", "focused", "required"].includes(property.name)) {
        continue;
      }
      const propertyValue = getAxValue(property.value);
      if (propertyValue !== "") {
        parts.push(`${property.name}=${JSON.stringify(propertyValue)}`);
      }
    }

    return parts;
  }

  private resolveUid(backendNodeId: number, uidCounter: { value: number }): string {
    const existingUid = this.backendNodeIdToUid.get(backendNodeId);
    if (existingUid) {
      return existingUid;
    }

    uidCounter.value += 1;
    const uid = `${this.snapshotVersion}_${uidCounter.value}`;
    this.backendNodeIdToUid.set(backendNodeId, uid);
    return uid;
  }

  private appendSnapshotLine(line: string, budget: SnapshotFormatBudget): void {
    if (budget.nodeCount >= SNAPSHOT_MAX_NODE_COUNT || budget.characterCount + line.length > SNAPSHOT_MAX_LENGTH) {
      if (!budget.truncated) {
        budget.lines.push(`${"  ".repeat(Math.min(SNAPSHOT_MAX_DEPTH, 1))}- ${SNAPSHOT_TRUNCATED_TEXT}`);
        budget.truncated = true;
      }
      return;
    }

    budget.lines.push(line);
    budget.nodeCount += 1;
    budget.characterCount += line.length + 1;
  }

  private resetUidCacheIfPageChanged(pageIdentity: string): void {
    if (this.lastPageIdentity && this.lastPageIdentity !== pageIdentity) {
      this.backendNodeIdToUid.clear();
    }

    this.lastPageIdentity = pageIdentity;
  }
}

export class BrowserControlManager {
  private targetTabId: number | undefined;
  private desiredEnabled = false;
  private operationVersion = 0;
  private readonly snapshotManager: BrowserControlSnapshotManager;

  constructor(
    private readonly connection = new BrowserDebuggerConnection(),
    private readonly chromeApi: ChromeApi | undefined = getChromeApi(),
  ) {
    this.snapshotManager = new BrowserControlSnapshotManager(this.connection, () => this.getTargetTabInfo());
    this.connection.installDetachListener((tabId, reason) => {
      this.targetTabId = undefined;
      this.desiredEnabled = false;
      this.notifyDetached(tabId, normalizeDetachReason(reason));
    });
  }

  handleTabRemoved(tabId: number): void {
    if (tabId !== this.targetTabId && tabId !== this.connection.attachedTabId) {
      return;
    }

    this.targetTabId = undefined;
    this.notifyDetached(tabId, "tab_removed");
    void this.connection.detach(tabId).catch(() => {
      // 标签页关闭期间 detach 只是尽力清理；异常不能冒泡成未处理 Promise。
    });
  }

  async setEnabled(enabled: boolean, tabId?: number): Promise<BrowserControlResponse> {
    this.desiredEnabled = enabled;
    const operationVersion = ++this.operationVersion;

    if (!enabled) {
      const detachedTabId = tabId ?? this.connection.attachedTabId;
      await this.connection.detach();
      this.targetTabId = undefined;
      this.notifyDetached(detachedTabId, "disabled_by_user");
      return { ok: true, attached: false, message: "浏览器控制已关闭。" };
    }

    const tabResult = await this.resolveTargetTab(tabId);
    if (!this.isCurrentEnableOperation(operationVersion)) {
      this.targetTabId = undefined;
      return { ok: true, attached: false, message: "浏览器控制已关闭。" };
    }

    if (!tabResult.ok) {
      this.targetTabId = undefined;
      return tabResult;
    }

    this.targetTabId = tabResult.tab.id;
    const attachResult = await this.connection.attach(tabResult.tab.id, () => this.isCurrentEnableOperation(operationVersion));
    if (!this.isCurrentEnableOperation(operationVersion)) {
      await this.connection.detach(tabResult.tab.id);
      this.targetTabId = undefined;
      return { ok: true, attached: false, message: "浏览器控制已关闭。" };
    }

    if (!attachResult.ok) {
      this.targetTabId = undefined;
    }

    return attachResult;
  }

  canExposeTakeSnapshotTool(): boolean {
    return this.desiredEnabled && this.connection.isAttached && Boolean(this.connection.attachedTabId);
  }

  async takeSnapshot(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const extraKeys = Object.keys(toolCall.arguments);
    if (extraKeys.length > 0) {
      return createBrowserToolErrorResult(toolCall, "浏览器页面快照工具不接受任何参数。");
    }

    if (!this.canExposeTakeSnapshotTool()) {
      return createBrowserToolErrorResult(toolCall, BROWSER_SNAPSHOT_DISABLED_MESSAGE);
    }

    try {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: await this.snapshotManager.takeSnapshot(),
      };
    } catch {
      return createBrowserToolErrorResult(toolCall, BROWSER_SNAPSHOT_FAILED_MESSAGE);
    }
  }

  private async resolveTargetTab(tabId?: number): Promise<{ ok: true; tab: chrome.tabs.Tab & { id: number } } | { ok: false; message: string }> {
    try {
      const tab = typeof tabId === "number" && tabId > 0
        ? await this.chromeApi?.tabs.get(tabId)
        : await this.getActiveTab();

      if (!tab?.id) {
        return { ok: false, message: "未找到可控制的当前标签页，请先打开普通网页。" };
      }

      const url = getBrowserControlTabUrl(tab);
      if (!url) {
        return { ok: false, message: "当前标签页没有可控制的页面地址，请先打开普通网页。" };
      }

      if (isBrowserControlRestrictedUrl(url)) {
        return { ok: false, message: "当前页面属于浏览器或扩展受限页面，无法开启浏览器控制。请切换到普通网页后重试。" };
      }

      return { ok: true, tab: tab as chrome.tabs.Tab & { id: number } };
    } catch {
      return { ok: false, message: "读取当前标签页失败，请确认页面仍然打开后重试。" };
    }
  }

  private async getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await (this.chromeApi?.tabs.query({ active: true, currentWindow: true }) ?? Promise.resolve([]));
    return tab;
  }

  private async getTargetTabInfo(): Promise<BrowserControlTabInfo> {
    const tabId = this.connection.attachedTabId ?? this.targetTabId;
    if (!tabId) {
      return { title: "", url: "" };
    }

    const tab = await this.chromeApi?.tabs.get(tabId);
    return {
      title: typeof tab?.title === "string" ? tab.title : "",
      url: getBrowserControlTabUrl(tab),
    };
  }

  private isCurrentEnableOperation(operationVersion: number): boolean {
    return this.desiredEnabled && this.operationVersion === operationVersion;
  }

  private notifyDetached(tabId: number | undefined, reason: BrowserControlDetachedReason): void {
    // Side Panel 的浏览器控制按钮是全局运行态；用户点击 Chrome 顶部“取消”不会经过前端，所以必须广播状态失效事件。
    this.chromeApi?.runtime?.sendMessage?.({
      type: BROWSER_CONTROL_DETACHED_MESSAGE_TYPE,
      tabId,
      reason,
    }, () => {
      const lastError = this.chromeApi?.runtime?.lastError;
      // Side Panel 未打开时广播可能没有接收者，读取 lastError 避免 MV3 runtime 噪声。
      void lastError?.message;
    });
  }
}

function createBrowserToolErrorResult(toolCall: ModelToolCall, content: string): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}

function normalizeAccessibilityNodes(response: unknown): AccessibilityNode[] {
  if (!response || typeof response !== "object" || !("nodes" in response) || !Array.isArray(response.nodes)) {
    return [];
  }

  return response.nodes.filter((node): node is AccessibilityNode => Boolean(node && typeof node === "object"));
}

function isInterestingAxNode(node: AccessibilityNode): boolean {
  const role = getAxValue(node.role);
  const name = getAxValue(node.name);
  const value = getAxValue(node.value);
  if (node.ignored && !name && !value) {
    return false;
  }

  if (typeof node.backendDOMNodeId === "number") {
    return true;
  }

  if (!role && !name && !value) {
    return false;
  }

  return !SKIPPED_AX_ROLES.has(role);
}

function getAxValue(source: { value?: unknown } | undefined): string {
  if (source?.value === undefined || source.value === null) {
    return "";
  }

  return String(source.value).trim();
}

function createPageIdentity(tabInfo: BrowserControlTabInfo): string {
  return `${tabInfo.url}\n${tabInfo.title}`;
}

function truncateSnapshot(content: string): string {
  if (content.length <= SNAPSHOT_MAX_LENGTH) {
    return content;
  }

  return `${content.slice(0, SNAPSHOT_MAX_LENGTH)}\n\n[快照内容过长，已截断。请基于已显示结构继续分析，必要时让用户缩小页面范围。]`;
}

export const browserControlManager = new BrowserControlManager();

export type { BrowserControlMessage, BrowserControlResponse };

export async function handleBrowserControlMessage(
  message: BrowserControlMessage,
  sender?: chrome.runtime.MessageSender,
  manager = browserControlManager,
): Promise<BrowserControlResponse> {
  if (message.type !== BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE) {
    return { ok: false, message: "未知的浏览器控制请求。" };
  }

  const tabId = message.tabId ?? sender?.tab?.id;
  return manager.setEnabled(message.enabled, tabId);
}

export function handleBrowserControlTabRemoved(tabId: number, manager = browserControlManager): void {
  manager.handleTabRemoved(tabId);
}

function normalizeDebuggerError(message = ""): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("restricted") || normalized.includes("cannot access") || normalized.includes("webui")) {
    return "当前页面属于浏览器受限页面，无法开启浏览器控制。请切换到普通网页后重试。";
  }

  if (normalized.includes("another debugger") || normalized.includes("already attached")) {
    return "当前标签页已被其他调试器占用，请关闭其他调试会话后重试。";
  }

  return "Chrome 拒绝开启调试会话，请确认当前页面可被扩展控制后重试。";
}

function normalizeDetachReason(reason: DebuggerDetachReason | undefined): BrowserControlDetachedReason {
  if (reason === "canceled_by_user" || reason === "target_closed") {
    return reason;
  }

  return "unknown";
}
