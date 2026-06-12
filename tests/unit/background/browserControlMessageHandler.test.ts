import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "../../../src/shared/models/types";
import {
  BrowserControlManager,
  BrowserDebuggerConnection,
  handleBrowserControlMessage,
  handleBrowserControlTabRemoved,
} from "../../../src/background/browserControlMessageHandler";
import { BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE, isBrowserControlRestrictedUrl } from "../../../src/shared/browserControl";

function createToolCall(argumentsValue: Record<string, unknown> = {}): ModelToolCall {
  return {
    id: "call-1",
    name: "take_snapshot",
    arguments: argumentsValue,
  };
}

function createNamedToolCall(name: string, argumentsValue: Record<string, unknown> = {}): ModelToolCall {
  return {
    id: "call-1",
    name,
    arguments: argumentsValue,
  };
}

function createChromeMock(options: {
  url?: string;
  title?: string;
  attachError?: string;
  detachError?: string;
  sendCommandError?: string;
  sendCommandErrorMethod?: string;
  sendCommandResults?: Record<string, unknown>;
  tabGetError?: boolean;
  delayAttach?: boolean;
  axNodes?: unknown[];
} = {}) {
  const detachListeners: Array<(source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const attachCallbacks: Array<() => void> = [];
  const chromeMock = {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      sendMessage: vi.fn((_message: unknown, callback?: () => void) => callback?.()),
    },
    debugger: {
      attach: vi.fn((_debuggee: chrome.debugger.Debuggee, _version: string, callback: () => void) => {
        if (options.delayAttach) {
          attachCallbacks.push(() => {
            chromeMock.runtime.lastError = options.attachError ? { message: options.attachError } : undefined;
            callback();
            chromeMock.runtime.lastError = undefined;
          });
          return;
        }

        chromeMock.runtime.lastError = options.attachError ? { message: options.attachError } : undefined;
        callback();
        chromeMock.runtime.lastError = undefined;
      }),
      detach: vi.fn((_debuggee: chrome.debugger.Debuggee, callback: () => void) => {
        chromeMock.runtime.lastError = options.detachError ? { message: options.detachError } : undefined;
        callback();
        chromeMock.runtime.lastError = undefined;
      }),
      sendCommand: vi.fn((_debuggee: chrome.debugger.Debuggee, method: string, _params: unknown, callback: (result?: unknown) => void) => {
        chromeMock.runtime.lastError = options.sendCommandError && (!options.sendCommandErrorMethod || options.sendCommandErrorMethod === method)
          ? { message: options.sendCommandError }
          : undefined;
        callback(options.sendCommandResults?.[method] ?? (method === "Accessibility.getFullAXTree" ? { nodes: options.axNodes ?? [] } : {}));
        chromeMock.runtime.lastError = undefined;
      }),
      onDetach: {
        addListener: vi.fn((listener: (source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`) => void) => detachListeners.push(listener)),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (options.tabGetError) {
          throw new Error("tab closed");
        }
        return { id: tabId, title: options.title ?? "示例页面", url: options.url ?? "https://example.com/" };
      }),
      query: vi.fn(async () => [{ id: 7, title: options.title ?? "示例页面", url: options.url ?? "https://example.com/" }]),
      onRemoved: {
        addListener: vi.fn((listener: (tabId: number) => void) => tabRemovedListeners.push(listener)),
      },
    },
  } as unknown as typeof chrome & {
    runtime: { lastError?: { message: string }; sendMessage: ReturnType<typeof vi.fn> };
    debugger: {
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
      sendCommand: ReturnType<typeof vi.fn>;
      onDetach: { addListener: ReturnType<typeof vi.fn> };
    };
    tabs: {
      get: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
    };
    detachListeners: typeof detachListeners;
    tabRemovedListeners: typeof tabRemovedListeners;
    attachCallbacks: typeof attachCallbacks;
  };

  chromeMock.detachListeners = detachListeners;
  chromeMock.tabRemovedListeners = tabRemovedListeners;
  chromeMock.attachCallbacks = attachCallbacks;
  return chromeMock;
}

describe("浏览器控制地基", () => {
  it("识别浏览器和扩展受限页面", () => {
    expect(isBrowserControlRestrictedUrl("chrome://settings")).toBe(true);
    expect(isBrowserControlRestrictedUrl("edge://extensions")).toBe(true);
    expect(isBrowserControlRestrictedUrl("about:blank")).toBe(true);
    expect(isBrowserControlRestrictedUrl("chrome-extension://abc/index.html")).toBe(true);
    expect(isBrowserControlRestrictedUrl("view-source:https://example.com")).toBe(true);
    expect(isBrowserControlRestrictedUrl("https://chromewebstore.google.com/detail/abc")).toBe(true);
    expect(isBrowserControlRestrictedUrl("https://example.com")).toBe(false);
  });

  it("开启浏览器控制时连接当前普通网页并启用必要 domain", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const response = await manager.setEnabled(true, 9);

    expect(response).toMatchObject({ ok: true, attached: true, tabId: 9 });
    expect(chromeMock.debugger.attach).toHaveBeenCalledWith({ tabId: 9 }, "1.3", expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Runtime.enable", {}, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Page.enable", {}, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "DOM.enable", {}, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Accessibility.enable", {}, expect.any(Function));
  });

  it("底层调试连接运行时拒绝未允许的 CDP 方法", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);

    await connection.attach(9);
    await expect((connection as unknown as { sendCommand: (method: string) => Promise<unknown> }).sendCommand("Network.getAllCookies")).rejects.toThrow(
      "浏览器控制不允许调用该 CDP 方法。",
    );
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalledWith({ tabId: 9 }, "Network.getAllCookies", {}, expect.any(Function));
  });

  it("受限页面不会 attach debugger", async () => {
    const chromeMock = createChromeMock({ url: "chrome://settings" });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const response = await manager.setEnabled(true, 9);

    expect(response).toEqual({ ok: false, message: "当前页面属于浏览器或扩展受限页面，无法开启浏览器控制。请切换到普通网页后重试。" });
    expect(chromeMock.debugger.attach).not.toHaveBeenCalled();
  });

  it("attach 失败后不会留下目标标签页状态", async () => {
    const chromeMock = createChromeMock({ attachError: "Another debugger is already attached" });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const response = await manager.setEnabled(true, 9);
    handleBrowserControlTabRemoved(9, manager);

    expect(response).toEqual({ ok: false, message: "当前标签页已被其他调试器占用，请关闭其他调试会话后重试。" });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chromeMock.debugger.detach).not.toHaveBeenCalled();
  });

  it("关闭浏览器控制时立即 detach", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const response = await manager.setEnabled(false);

    expect(response).toEqual({ ok: true, attached: false, message: "浏览器控制已关闭。" });
    expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "browserControl.detached", tabId: 9, reason: "disabled_by_user" },
      expect.any(Function),
    );
  });

  it("快速开启后立即关闭时不会被延迟 attach 重新连接", async () => {
    const chromeMock = createChromeMock({ delayAttach: true });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const enablePromise = manager.setEnabled(true, 9);
    await vi.waitFor(() => expect(chromeMock.attachCallbacks).toHaveLength(1));
    const disableResponse = await manager.setEnabled(false);
    chromeMock.attachCallbacks[0]?.();
    const enableResponse = await enablePromise;

    expect(disableResponse).toEqual({ ok: true, attached: false, message: "浏览器控制已关闭。" });
    expect(enableResponse).toEqual({ ok: true, attached: false, message: "浏览器控制已关闭。" });
    expect(connection.isAttached).toBe(false);
    expect(connection.attachedTabId).toBeUndefined();
    expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("detach 失败时仍清理本地连接状态", async () => {
    const chromeMock = createChromeMock({ detachError: "No target with given id found" });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const response = await manager.setEnabled(false);

    expect(response).toEqual({ ok: true, attached: false, message: "浏览器控制已关闭。" });
    expect(connection.isAttached).toBe(false);
    expect(connection.attachedTabId).toBeUndefined();
  });

  it("外部取消调试时传递 onDetach reason 并清理连接状态", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const onDetach = vi.fn();
    connection.installDetachListener(onDetach);

    await connection.attach(9);
    chromeMock.detachListeners[0]?.({ tabId: 9 }, "canceled_by_user");

    expect(onDetach).toHaveBeenCalledWith(9, "canceled_by_user");
    expect(connection.isAttached).toBe(false);
    expect(connection.attachedTabId).toBeUndefined();
  });

  it("外部取消调试时通知侧边栏回滚浏览器控制运行态", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    chromeMock.detachListeners[0]?.({ tabId: 9 }, "canceled_by_user");

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "browserControl.detached", tabId: 9, reason: "canceled_by_user" },
      expect.any(Function),
    );
  });

  it("启用必要调试 domain 失败时自动 detach 并返回中文错误", async () => {
    const chromeMock = createChromeMock({ sendCommandError: "Runtime.enable failed" });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const response = await manager.setEnabled(true, 9);

    expect(response).toEqual({ ok: false, message: "浏览器调试会话初始化失败，请关闭浏览器控制后重试。" });
    expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function));
    expect(connection.isAttached).toBe(false);
  });

  it("标签页关闭时清理当前调试连接", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    handleBrowserControlTabRemoved(9, manager);

    expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 9 }, expect.any(Function));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      { type: "browserControl.detached", tabId: 9, reason: "tab_removed" },
      expect.any(Function),
    );
  });

  it("runtime 消息会转发到浏览器控制管理器", async () => {
    const manager = {
      setEnabled: vi.fn(async () => ({ ok: true as const, attached: true, tabId: 8, message: "已开启" })),
    } as unknown as BrowserControlManager;

    const response = await handleBrowserControlMessage(
      { type: BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE, enabled: true },
      { tab: { id: 8 } as chrome.tabs.Tab },
      manager,
    );

    expect(manager.setEnabled).toHaveBeenCalledWith(true, 8);
    expect(response).toEqual({ ok: true, attached: true, tabId: 8, message: "已开启" });
  });

  it("已连接时读取 Accessibility Tree 并格式化为带 UID 的页面快照", async () => {
    const chromeMock = createChromeMock({
      title: "登录页",
      url: "https://example.com/login",
      axNodes: [
        {
          nodeId: "1",
          role: { value: "RootWebArea" },
          name: { value: "登录页" },
          childIds: ["2"],
        },
        {
          nodeId: "2",
          role: { value: "button" },
          name: { value: "提交" },
          backendDOMNodeId: 101,
        },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.takeSnapshot(createToolCall());

    expect(result).toMatchObject({
      toolCallId: "call-1",
      name: "take_snapshot",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("页面标题：登录页");
    expect(result.content).toContain("页面 URL：https://example.com/login");
    expect(result.content).toContain("uid=");
    expect(result.content).toContain("button");
    expect(result.content).toContain("提交");
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Accessibility.getFullAXTree", {}, expect.any(Function));
    expect(chromeMock.debugger.sendCommand.mock.calls.filter((call) => call[1] === "DOM.enable")).toHaveLength(1);
    expect(chromeMock.debugger.sendCommand.mock.calls.filter((call) => call[1] === "Accessibility.enable")).toHaveLength(1);
  });

  it("格式化快照时限制 AX Tree 深度，避免极端页面递归过深", async () => {
    const axNodes = Array.from({ length: 60 }, (_, index) => ({
      nodeId: String(index + 1),
      role: { value: index === 0 ? "RootWebArea" : "group" },
      name: { value: index === 59 ? "过深节点" : `节点 ${index + 1}` },
      backendDOMNodeId: index + 100,
      childIds: index < 59 ? [String(index + 2)] : [],
    }));
    const chromeMock = createChromeMock({ axNodes });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.takeSnapshot(createToolCall());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("节点 1");
    expect(result.content).toContain("节点层级过深，已停止继续展开。");
    expect(result.content).not.toContain("过深节点");
  });

  it("页面稳定时相同 backendDOMNodeId 尽量复用 UID", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 101 },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const first = await manager.takeSnapshot(createToolCall());
    const second = await manager.takeSnapshot(createToolCall());
    const firstUid = first.content.match(/uid=([^\s]+)/)?.[1];
    const secondUid = second.content.match(/uid=([^\s]+)/)?.[1];

    expect(firstUid).toBeTruthy();
    expect(secondUid).toBe(firstUid);
  });

  it("页面 URL 变化后清理旧 UID 映射避免跨页面复用", async () => {
    const chromeMock = createChromeMock({
      url: "https://example.com/page-a",
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "页面 A" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "提交 A" }, backendDOMNodeId: 101 },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const first = await manager.takeSnapshot(createToolCall());
    chromeMock.tabs.get.mockResolvedValue({ id: 9, title: "页面 B", url: "https://example.com/page-b" });
    chromeMock.debugger.sendCommand.mockImplementation((_debuggee: chrome.debugger.Debuggee, method: string, _params: unknown, callback: (result?: unknown) => void) => {
      callback(method === "Accessibility.getFullAXTree"
        ? {
            nodes: [
              { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "页面 B" }, childIds: ["2"] },
              { nodeId: "2", role: { value: "button" }, name: { value: "提交 B" }, backendDOMNodeId: 101 },
            ],
          }
        : {});
    });
    const second = await manager.takeSnapshot(createToolCall());
    const firstUid = first.content.match(/uid=([^\s]+)/)?.[1];
    const secondUid = second.content.match(/uid=([^\s]+)/)?.[1];

    expect(firstUid).toBeTruthy();
    expect(secondUid).toBeTruthy();
    expect(secondUid).not.toBe(firstUid);
    expect(second.content).toContain("页面 URL：https://example.com/page-b");
  });

  it("重复 childIds 只展开一次，避免异常 AX DAG 放大快照", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2", "2", "2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "重复按钮" }, backendDOMNodeId: 101 },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.takeSnapshot(createToolCall());

    expect(result.isError).toBeUndefined();
    expect(result.content.match(/重复按钮/g)).toHaveLength(1);
  });

  it("未开启浏览器控制时拒绝执行页面快照且不自动 attach", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const result = await manager.takeSnapshot(createToolCall());

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "take_snapshot",
      content: "浏览器控制未开启，无法读取页面快照。请先在顶部浏览器控制按钮中显式开启。",
      isError: true,
    });
    expect(chromeMock.debugger.attach).not.toHaveBeenCalled();
  });

  it("空 Accessibility Tree 返回明确中文空状态", async () => {
    const chromeMock = createChromeMock({ axNodes: [] });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.takeSnapshot(createToolCall());

    expect(result.content).toContain("未读取到可访问节点");
    expect(result.isError).toBeUndefined();
  });

  it("快照读取失败时返回固定中文错误", async () => {
    const chromeMock = createChromeMock({ sendCommandError: "Protocol error: sensitive stack", sendCommandErrorMethod: "Accessibility.getFullAXTree" });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.takeSnapshot(createToolCall());

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "take_snapshot",
      content: "读取页面快照失败，请确认当前页面仍可访问后重试。",
      isError: true,
    });
    expect(result.content).not.toContain("sensitive stack");
  });

  it("读取目标标签页信息失败时返回固定中文错误", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 101 },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    chromeMock.tabs.get.mockRejectedValueOnce(new Error("tab closed"));
    const result = await manager.takeSnapshot(createToolCall());

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "take_snapshot",
      content: "读取页面快照失败，请确认当前页面仍可访问后重试。",
      isError: true,
    });
  });

  it("未开启浏览器控制时拒绝阶段三操作工具且不自动 attach", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    const clickResult = await manager.executeBrowserTool(createNamedToolCall("click", { uid: "1_1" }));
    const fillResult = await manager.executeBrowserTool(createNamedToolCall("fill", { uid: "1_1", value: "你好" }));
    const pressKeyResult = await manager.executeBrowserTool(createNamedToolCall("press_key", { key: "Enter" }));
    const waitForResult = await manager.executeBrowserTool(createNamedToolCall("wait_for", { text: ["完成"] }));

    expect(clickResult.content).toBe("浏览器控制未开启，无法执行浏览器操作。请先在顶部浏览器控制按钮中显式开启。");
    expect(fillResult.content).toBe("浏览器控制未开启，无法执行浏览器操作。请先在顶部浏览器控制按钮中显式开启。");
    expect(pressKeyResult.content).toBe("浏览器控制未开启，无法执行浏览器操作。请先在顶部浏览器控制按钮中显式开启。");
    expect(waitForResult.content).toBe("浏览器控制未开启，无法执行浏览器操作。请先在顶部浏览器控制按钮中显式开启。");
    expect(clickResult.isError).toBe(true);
    expect(fillResult.isError).toBe(true);
    expect(pressKeyResult.isError).toBe(true);
    expect(waitForResult.isError).toBe(true);
    expect(chromeMock.debugger.attach).not.toHaveBeenCalled();
  });

  it("click 使用 UID 解析 DOM 节点并优先发送真实鼠标事件", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 101 },
      ],
      sendCommandResults: {
        "DOM.resolveNode": { object: { objectId: "object-101" } },
        "DOM.getBoxModel": { model: { content: [0, 10, 20, 10, 20, 30, 0, 30] } },
        "Runtime.callFunctionOn": { result: { value: true } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const snapshot = await manager.takeSnapshot(createToolCall());
    const uid = snapshot.content.match(/uid=([^\s]+)/)?.[1] ?? "";
    const result = await manager.executeBrowserTool(createNamedToolCall("click", { uid }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "click",
      content: `已点击元素 ${uid}。`,
    });
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "DOM.resolveNode", { backendNodeId: 101 }, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 }, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 }, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 }, expect.any(Function));
  });

  it("click 真实鼠标事件失败时走受控 JS fallback", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 101 },
      ],
    });
    chromeMock.debugger.sendCommand.mockImplementation((_debuggee: chrome.debugger.Debuggee, method: string, params: { functionDeclaration?: string }, callback: (result?: unknown) => void) => {
      chromeMock.runtime.lastError = method === "DOM.getBoxModel" ? { message: "No layout object" } : undefined;
      if (method === "Accessibility.getFullAXTree") {
        callback({
          nodes: [
            { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
            { nodeId: "2", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 101 },
          ],
        });
      } else if (method === "DOM.resolveNode") {
        callback({ object: { objectId: "object-101" } });
      } else {
        callback({});
      }
      chromeMock.runtime.lastError = undefined;
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const snapshot = await manager.takeSnapshot(createToolCall());
    const uid = snapshot.content.match(/uid=([^\s]+)/)?.[1] ?? "";
    const result = await manager.executeBrowserTool(createNamedToolCall("click", { uid }));

    expect(result.content).toBe(`已点击元素 ${uid}。`);
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "object-101",
        functionDeclaration: expect.stringContaining("mousedown"),
      }),
      expect.any(Function),
    );
  });

  it("fill 对文本输入使用聚焦、清空和 Input.insertText", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "textbox" }, name: { value: "用户名" }, backendDOMNodeId: 101 },
      ],
      sendCommandResults: {
        "DOM.resolveNode": { object: { objectId: "object-101" } },
        "Runtime.callFunctionOn": { result: { value: { tagName: "INPUT", isContentEditable: false, type: "text", role: "" } } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const snapshot = await manager.takeSnapshot(createToolCall());
    const uid = snapshot.content.match(/uid=([^\s]+)/)?.[1] ?? "";
    const result = await manager.executeBrowserTool(createNamedToolCall("fill", { uid, value: "张三" }));

    expect(result.content).toBe(`已填写元素 ${uid}。`);
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Input.insertText", { text: "张三" }, expect.any(Function));
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyDown", key: "Backspace" }),
      expect.any(Function),
    );
  });

  it("fill 对 checkbox/radio/switch 只接受 true 或 false", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "checkbox" }, name: { value: "同意" }, backendDOMNodeId: 101 },
      ],
      sendCommandResults: {
        "DOM.resolveNode": { object: { objectId: "object-101" } },
        "Runtime.callFunctionOn": { result: { value: { tagName: "INPUT", isContentEditable: false, type: "checkbox", role: "" } } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const snapshot = await manager.takeSnapshot(createToolCall());
    const uid = snapshot.content.match(/uid=([^\s]+)/)?.[1] ?? "";
    const invalid = await manager.executeBrowserTool(createNamedToolCall("fill", { uid, value: "yes" }));
    const valid = await manager.executeBrowserTool(createNamedToolCall("fill", { uid, value: "true" }));

    expect(invalid).toEqual({
      toolCallId: "call-1",
      name: "fill",
      content: "复选框、单选框和开关只能填写 true 或 false。",
      isError: true,
    });
    expect(valid.content).toBe(`已填写元素 ${uid}。`);
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "object-101",
        arguments: [{ value: true }],
        functionDeclaration: expect.stringContaining("aria-checked"),
        userGesture: true,
      }),
      expect.any(Function),
    );
  });

  it("press_key 只允许白名单按键和常见组合键", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const valid = await manager.executeBrowserTool(createNamedToolCall("press_key", { key: "Ctrl+Enter" }));
    const invalid = await manager.executeBrowserTool(createNamedToolCall("press_key", { key: "F13" }));

    expect(valid.content).toBe("已按下按键 Ctrl+Enter。");
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyDown", key: "Control" }),
      expect.any(Function),
    );
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyDown", key: "Enter", modifiers: 2 }),
      expect.any(Function),
    );
    expect(invalid).toEqual({
      toolCallId: "call-1",
      name: "press_key",
      content: "按键 F13 不在允许列表中。",
      isError: true,
    });
  });

  it("wait_for 等待页面文本并限制 timeout 上限", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Runtime.evaluate": { result: { value: "完成" } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.executeBrowserTool(createNamedToolCall("wait_for", { text: ["完成"], timeout: 60000 }));

    expect(result.content).toBe("已等待到页面文本：完成。");
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 9 },
      "Runtime.evaluate",
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
        expression: expect.stringContaining("30000"),
      }),
      expect.any(Function),
    );
  });

  it("成功操作 includeSnapshot 时追加最新快照，失败时不追加", async () => {
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["2"] },
        { nodeId: "2", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 101 },
      ],
      sendCommandResults: {
        "DOM.resolveNode": { object: { objectId: "object-101" } },
        "DOM.getBoxModel": { model: { content: [0, 10, 20, 10, 20, 30, 0, 30] } },
        "Runtime.callFunctionOn": { result: { value: true } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const snapshot = await manager.takeSnapshot(createToolCall());
    const uid = snapshot.content.match(/uid=([^\s]+)/)?.[1] ?? "";
    const success = await manager.executeBrowserTool(createNamedToolCall("click", { uid, includeSnapshot: true }));
    const failure = await manager.executeBrowserTool(createNamedToolCall("click", { uid: "bad", includeSnapshot: true }));

    expect(success.content).toContain("已点击元素");
    expect(success.content).toContain("## 最新页面快照");
    expect(success.content).toContain("页面标题：示例页面");
    expect(failure.isError).toBe(true);
    expect(failure.content).not.toContain("## 最新页面快照");
    expect(failure.content).toContain("请重新调用 take_snapshot");
  });
});
