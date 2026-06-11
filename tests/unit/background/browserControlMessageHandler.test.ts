import { describe, expect, it, vi } from "vitest";
import {
  BrowserControlManager,
  BrowserDebuggerConnection,
  handleBrowserControlMessage,
  handleBrowserControlTabRemoved,
} from "../../../src/background/browserControlMessageHandler";
import { BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE, isBrowserControlRestrictedUrl } from "../../../src/shared/browserControl";

function createChromeMock(options: { url?: string; attachError?: string; detachError?: string; sendCommandError?: string; delayAttach?: boolean } = {}) {
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
      sendCommand: vi.fn((_debuggee: chrome.debugger.Debuggee, _method: string, _params: unknown, callback: (result?: unknown) => void) => {
        chromeMock.runtime.lastError = options.sendCommandError ? { message: options.sendCommandError } : undefined;
        callback({});
        chromeMock.runtime.lastError = undefined;
      }),
      onDetach: {
        addListener: vi.fn((listener: (source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`) => void) => detachListeners.push(listener)),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: options.url ?? "https://example.com/" })),
      query: vi.fn(async () => [{ id: 7, url: options.url ?? "https://example.com/" }]),
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
});
