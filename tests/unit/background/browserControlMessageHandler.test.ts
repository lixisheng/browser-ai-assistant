import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "../../../src/shared/models/types";
import {
  BrowserControlManager,
  BrowserDebuggerConnection,
  handleBrowserControlMessage,
  handleBrowserControlTabRemoved,
} from "../../../src/background/browserControlMessageHandler";
import {
  BROWSER_CONTROL_RUNTIME_READONLY_CHANGED_MESSAGE_TYPE,
  BROWSER_CONTROL_SET_ENABLED_MESSAGE_TYPE,
  BROWSER_CONTROL_SET_RUNTIME_READONLY_MESSAGE_TYPE,
  isBrowserControlRestrictedUrl,
} from "../../../src/shared/browserControl";

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
  tabs?: Array<chrome.tabs.Tab & { id: number }>;
  createdTab?: chrome.tabs.Tab & { id: number };
  attachError?: string;
  detachError?: string;
  sendCommandError?: string;
  sendCommandErrorMethod?: string;
  sendCommandResults?: Record<string, unknown>;
  tabGetError?: boolean;
  delayAttach?: boolean;
  axNodes?: unknown[];
  detachOnRemove?: boolean;
} = {}) {
  const detachListeners: Array<(source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`) => void> = [];
  const eventListeners: Array<(source: chrome.debugger.Debuggee, method: string, params?: Record<string, unknown>) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const attachCallbacks: Array<() => void> = [];
  const tabs = options.tabs ?? [
    {
      id: 7,
      title: options.title ?? "示例页面",
      url: options.url ?? "https://example.com/",
      active: true,
      windowId: 1,
      groupId: -1,
    } as chrome.tabs.Tab & { id: number },
  ];
  const createdTab = options.createdTab ?? ({
    id: 11,
    title: "新页面",
    url: "https://example.com/new",
    active: true,
    windowId: 1,
    groupId: -1,
  } as chrome.tabs.Tab & { id: number });
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
      onEvent: {
        addListener: vi.fn((listener: (source: chrome.debugger.Debuggee, method: string, params?: Record<string, unknown>) => void) => eventListeners.push(listener)),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (options.tabGetError) {
          throw new Error("tab closed");
        }
        return tabs.find((tab) => tab.id === tabId) ?? { id: tabId, title: options.title ?? "示例页面", url: options.url ?? "https://example.com/", windowId: 1 };
      }),
      query: vi.fn(async (queryInfo?: chrome.tabs.QueryInfo) => {
        if (queryInfo && "groupId" in queryInfo && typeof queryInfo.groupId === "number") {
          return tabs.filter((tab) => tab.groupId === queryInfo.groupId);
        }
        if (queryInfo?.active) {
          return tabs.filter((tab) => tab.active);
        }
        return tabs;
      }),
      create: vi.fn(async (createProperties: chrome.tabs.CreateProperties) => {
        const tab = {
          ...createdTab,
          url: createProperties.url ?? createdTab.url,
          active: createProperties.active ?? true,
        };
        tabs.push(tab);
        return tab;
      }),
      update: vi.fn(async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
        const tab = tabs.find((item) => item.id === tabId) ?? createdTab;
        Object.assign(tab, updateProperties);
        return tab;
      }),
      remove: vi.fn(async (tabId: number) => {
        const index = tabs.findIndex((tab) => tab.id === tabId);
        if (index >= 0) {
          tabs.splice(index, 1);
        }
        if (options.detachOnRemove) {
          detachListeners[0]?.({ tabId }, "target_closed");
        }
      }),
      group: vi.fn(async () => 3),
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
      onEvent: { addListener: ReturnType<typeof vi.fn> };
    };
    tabs: {
      get: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
      group?: ReturnType<typeof vi.fn>;
    };
    detachListeners: typeof detachListeners;
    eventListeners: typeof eventListeners;
    tabRemovedListeners: typeof tabRemovedListeners;
    attachCallbacks: typeof attachCallbacks;
    tabsState: typeof tabs;
  };

  chromeMock.detachListeners = detachListeners;
  chromeMock.eventListeners = eventListeners;
  chromeMock.tabRemovedListeners = tabRemovedListeners;
  chromeMock.attachCallbacks = attachCallbacks;
  chromeMock.tabsState = tabs;
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
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 9 }, "Network.enable", {}, expect.any(Function));
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

  it("允许读取单个 Network 响应体但仍拒绝 Cookie 类 CDP 方法", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Network.getResponseBody": { body: "{}", base64Encoded: false },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);

    await connection.attach(9);

    await expect(connection.getResponseBody("req-1")).resolves.toEqual({ body: "{}", base64Encoded: false });
    await expect((connection as unknown as { sendCommand: (method: string) => Promise<unknown> }).sendCommand("Network.getAllCookies")).rejects.toThrow(
      "浏览器控制不允许调用该 CDP 方法。",
    );
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

  it("运行时只读授权消息会转发到浏览器控制管理器", async () => {
    const manager = {
      setRuntimeReadonlyEnabled: vi.fn(() => ({ ok: true as const, attached: true, tabId: 8, message: "已开启" })),
    } as unknown as BrowserControlManager;

    const response = await handleBrowserControlMessage(
      { type: BROWSER_CONTROL_SET_RUNTIME_READONLY_MESSAGE_TYPE, enabled: true, reason: "测试" },
      { tab: { id: 8 } as chrome.tabs.Tab },
      manager,
    );

    expect(manager.setRuntimeReadonlyEnabled).toHaveBeenCalledWith(true, "测试");
    expect(response).toEqual({ ok: true, attached: true, tabId: 8, message: "已开启" });
  });

  it("普通模式默认允许 runtime 只读工具使用固定 Runtime.evaluate", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Runtime.evaluate": { result: { value: [{ path: "__APP_CONFIG__", exists: true, value: { entries: [["safe", { value: "ok" }]] } }] } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const result = await manager.executeRuntimeReadTool(createNamedToolCall("runtime_inspect_globals", { paths: ["window.__APP_CONFIG__"] }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("运行时全局摘要");
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Runtime.evaluate",
      expect.objectContaining({
        awaitPromise: false,
        returnByValue: true,
        expression: expect.stringContaining("__APP_CONFIG__"),
      }),
      expect.any(Function),
    );
  });

  it("切换受控页面会保留用户选择的受控增强模式并清理一次性授权", async () => {
    const chromeMock = createChromeMock({
      tabs: [
        { id: 7, title: "页面 A", url: "https://example.com/a", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
        { id: 8, title: "页面 B", url: "https://example.com/b", active: false, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    expect(manager.setAutomationMode("controlled_enhanced")).toMatchObject({ ok: true });
    await manager.executeBrowserTool(createNamedToolCall("select_page", { index: 2 }));

    expect(manager.canExposeRuntimeReadTool()).toBe(true);
    expect(manager.canExposeBoundaryChoiceTool()).toBe(true);
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "browserControl.automationModeChanged", mode: "controlled_enhanced" }),
      expect.any(Function),
    );
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "browserControl.automationModeChanged", mode: "normal_restricted" }),
      expect.any(Function),
    );
  });

  it("受控增强模式下执行 Network 工具遇到脱敏字段会主动触发权限边界确认", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Network.getResponseBody": { body: "{\"token\":\"secret\",\"password\":\"123456\",\"ok\":true}", base64Encoded: false },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);
    chromeMock.runtime.sendMessage.mockImplementation((message: unknown, callback?: () => void) => {
      if ((message as { type?: string }).type === "browserControl.boundaryChoiceRequest") {
        manager.respondBoundaryChoice((message as { requestId: string }).requestId, { selectedChoiceIds: ["allow_redacted_sensitive_fields"] });
      }
      callback?.();
      return undefined;
    });

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("controlled_enhanced");
    chromeMock.eventListeners.forEach((listener) => {
      listener({ tabId: 7 }, "Network.requestWillBeSent", {
        requestId: "req-1",
        type: "XHR",
        request: {
          url: "https://example.com/api/user?token=secret",
          method: "GET",
          headers: { Authorization: "Bearer secret" },
        },
      });
      listener({ tabId: 7 }, "Network.responseReceived", {
        requestId: "req-1",
        type: "XHR",
        response: {
          status: 200,
          statusText: "OK",
          mimeType: "application/json",
          headers: { "Content-Type": "application/json" },
        },
      });
    });

    const result = await manager.executeNetworkTool(createNamedToolCall("network_get_request_details", { requestIds: ["req-1"] }));

    const boundaryChoiceCall = chromeMock.runtime.sendMessage.mock.calls.find(([message]) =>
      (message as { type?: string }).type === "browserControl.boundaryChoiceRequest");
    expect(boundaryChoiceCall?.[0]).toEqual(expect.objectContaining({
      type: "browserControl.boundaryChoiceRequest",
      question: expect.stringContaining("允许处理"),
    }));
    expect(result.content).toContain("\"password\":\"123456\"");
    expect(result.toolAttachments?.[0]).toMatchObject({
      redacted: false,
      requests: [expect.objectContaining({
        responseBody: "{\"token\":\"secret\",\"password\":\"123456\",\"ok\":true}",
        redacted: false,
      })],
    });
  });

  it("完全访问模式会暴露 full_access 工具并在切回普通模式后立即失效", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Runtime.evaluate": { result: { value: { cookie: "sid=secret", password: "123456" } } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    expect(manager.canExposeFullAccessTool()).toBe(false);

    expect(manager.setAutomationMode("full_access")).toMatchObject({ ok: true });
    expect(manager.canExposeFullAccessTool()).toBe(true);

    const result = await manager.executeFullAccessTool(createNamedToolCall("full_access_execute_script", { script: "document.cookie" }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("sid=secret");
    expect(result.content).toContain("123456");

    manager.setAutomationMode("normal_restricted");
    expect(manager.canExposeFullAccessTool()).toBe(false);
    await expect(manager.executeFullAccessTool(createNamedToolCall("full_access_execute_script", { script: "document.cookie" }))).resolves.toMatchObject({
      isError: true,
      content: "当前不是完全访问模式，已拒绝执行 full_access.* 工具。",
    });
  });

  it("完全访问模式下普通 Network 详情附件也保持原文", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Network.getResponseBody": { body: "{\"token\":\"secret\",\"password\":\"123456\"}", base64Encoded: false },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("full_access");
    chromeMock.eventListeners.forEach((listener) => {
      listener({ tabId: 7 }, "Network.requestWillBeSent", {
        requestId: "req-raw",
        type: "XHR",
        request: {
          url: "https://example.com/api/login?token=secret",
          method: "POST",
          headers: { Authorization: "Bearer secret" },
          postData: "{\"password\":\"123456\"}",
        },
      });
      listener({ tabId: 7 }, "Network.responseReceived", {
        requestId: "req-raw",
        type: "XHR",
        response: {
          status: 200,
          statusText: "OK",
          mimeType: "application/json",
          headers: { "Set-Cookie": "sid=secret" },
        },
      });
    });

    const result = await manager.executeNetworkTool(createNamedToolCall("network_get_request_details", { requestIds: ["req-raw"] }));

    expect(result.content).toContain("secret");
    expect(result.content).toContain("123456");
    expect(result.toolAttachments?.[0]).toMatchObject({
      kind: "network",
      redacted: false,
      fullAccess: true,
      requests: [expect.objectContaining({
        url: "https://example.com/api/login?token=secret",
        requestBody: "{\"password\":\"123456\"}",
        responseBody: "{\"token\":\"secret\",\"password\":\"123456\"}",
        redacted: false,
      })],
    });
  });

  it("完全访问模式下等待 Network 请求生成的附件也保持原文", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("full_access");
    chromeMock.eventListeners.forEach((listener) => {
      listener({ tabId: 7 }, "Network.requestWillBeSent", {
        requestId: "req-wait",
        type: "XHR",
        request: {
          url: "https://example.com/api/login?token=secret",
          method: "POST",
          headers: { Authorization: "Bearer secret" },
          postData: "{\"password\":\"123456\"}",
        },
      });
      listener({ tabId: 7 }, "Network.responseReceived", {
        requestId: "req-wait",
        type: "XHR",
        response: {
          status: 401,
          statusText: "Unauthorized",
          mimeType: "application/json",
          headers: { "Set-Cookie": "sid=secret" },
        },
      });
    });

    const result = await manager.executeNetworkTool(createNamedToolCall("network_wait_for_requests", { urlIncludes: "/api/login" }));

    expect(result.content).toContain("token=secret");
    expect(result.toolAttachments?.[0]).toMatchObject({
      kind: "network",
      redacted: false,
      fullAccess: true,
      requests: [expect.objectContaining({
        url: "https://example.com/api/login?token=secret",
        requestHeaders: [expect.objectContaining({ name: "Authorization", value: "Bearer secret" })],
        requestBody: "{\"password\":\"123456\"}",
        redacted: false,
      })],
    });
  });

  it("完全访问模式下 JS 同源上下文扩展直接放行且不触发边界确认", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("full_access");
    chromeMock.eventListeners.forEach((listener) => {
      listener({ tabId: 7 }, "Network.requestWillBeSent", {
        requestId: "script-1",
        type: "Script",
        request: {
          url: "https://example.com/app.js",
          method: "GET",
          headers: {},
        },
      });
      listener({ tabId: 7 }, "Network.responseReceived", {
        requestId: "script-1",
        type: "Script",
        response: {
          status: 200,
          statusText: "OK",
          mimeType: "application/javascript",
          headers: { "Content-Type": "application/javascript" },
        },
      });
    });

    const result = await manager.executeJsSourceTool(createNamedToolCall("js_search_sources", {
      keywords: ["api"],
      urls: ["https://example.com/app.js"],
    }));

    expect(result.content).not.toContain("需要 allowSameOriginFetch=true");
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "browserControl.boundaryChoiceRequest" }),
      expect.any(Function),
    );
  });

  it("受控增强确认 JS 上下文扩展后会立即重跑并启用同源补位", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);
    chromeMock.runtime.sendMessage.mockImplementation((message: unknown, callback?: () => void) => {
      if ((message as { type?: string }).type === "browserControl.boundaryChoiceRequest") {
        manager.respondBoundaryChoice((message as { requestId: string }).requestId, { selectedChoiceIds: ["allow_js_or_sourcemap_context_expansion"] });
      }
      callback?.();
      return undefined;
    });

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("controlled_enhanced");
    const result = await manager.executeJsSourceTool(createNamedToolCall("js_search_sources", {
      keywords: ["api"],
      urls: ["https://example.com/app.js"],
    }));

    expect(result.content).not.toContain("需要 allowSameOriginFetch=true");
    expect(result.content).not.toContain("用户已确认本次受控增强边界");
  });

  it("受控增强确认 Runtime 摘要扩展后会使用更大摘要参数重跑并消费授权", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Runtime.evaluate": { result: { value: { long: Array.from({ length: 40 }, (_, index) => [`k${index}`, { value: index }]), truncated: true } } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);
    chromeMock.runtime.sendMessage.mockImplementation((message: unknown, callback?: () => void) => {
      if ((message as { type?: string }).type === "browserControl.boundaryChoiceRequest") {
        manager.respondBoundaryChoice((message as { requestId: string }).requestId, { selectedChoiceIds: ["allow_truncated_summary"] });
      }
      callback?.();
      return undefined;
    });

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("controlled_enhanced");
    await manager.executeRuntimeReadTool(createNamedToolCall("runtime_inspect_globals", { paths: ["window.__APP_CONFIG__"], maxDepth: 1, limit: 1 }));

    const runtimeEvaluateCalls = chromeMock.debugger.sendCommand.mock.calls.filter((call) => call[1] === "Runtime.evaluate");
    expect(runtimeEvaluateCalls.length).toBeGreaterThanOrEqual(2);
    expect(runtimeEvaluateCalls.at(-1)?.[2]).toEqual(expect.objectContaining({
      expression: expect.stringContaining("const maxDepth = 4"),
    }));
    expect(runtimeEvaluateCalls.at(-1)?.[2]).toEqual(expect.objectContaining({
      expression: expect.stringContaining("const limit = 30"),
    }));
  });

  it("已有请求重放授权时 send 只发送一次并立即消费授权", async () => {
    const fetchMock = vi.fn(async () => new Response("{\"ok\":true}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);
    chromeMock.runtime.sendMessage.mockImplementation((message: unknown, callback?: () => void) => {
      if ((message as { type?: string }).type === "browserControl.boundaryChoiceRequest") {
        const request = message as { requestId: string; choices?: Array<{ id: string; grants: string[] }> };
        const allowChoiceId = request.choices?.find((choice) => choice.grants.length > 0)?.id ?? "";
        manager.respondBoundaryChoice(request.requestId, { selectedChoiceIds: [allowChoiceId] });
      }
      callback?.();
      return undefined;
    });

    await manager.setEnabled(true, 7);
    manager.setAutomationMode("controlled_enhanced");
    chromeMock.eventListeners.forEach((listener) => {
      listener({ tabId: 7 }, "Network.requestWillBeSent", {
        requestId: "req-1",
        type: "XHR",
        request: {
          url: "https://example.com/api/items",
          method: "GET",
          headers: { Accept: "application/json" },
        },
      });
    });
    const prepareResult = await manager.executeReplayTool(createNamedToolCall("replay_prepare_request", { requestId: "req-1" }));
    const draftId = prepareResult.content.match(/draftId：(\S+)/)?.[1];
    expect(draftId).toBeTruthy();

    const sendResult = await manager.executeReplayTool(createNamedToolCall("replay_send_request", { draftId }));

    expect(sendResult.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const secondSend = await manager.executeReplayTool(createNamedToolCall("replay_send_request", { draftId }));
    expect(secondSend.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
    const uid = snapshot.content.match(/uid=([0-9_]+)/)?.[1] ?? "";
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

  it("开启浏览器控制后把当前窗口所有可控标签页加入后台受控列表", async () => {
    const chromeMock = createChromeMock({
      tabs: [
        { id: 9, title: "任务页", url: "https://example.com/", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
        { id: 10, title: "同窗口页面", url: "https://example.com/other", active: false, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
        { id: 11, title: "受限页面", url: "chrome://settings", active: false, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.executeBrowserTool(createNamedToolCall("list_pages"));

    expect(result.content).toContain("1. 当前 任务页");
    expect(result.content).toContain("2. 同窗口页面");
    expect(result.content).not.toContain("受限页面");
    expect(chromeMock.tabs.group).not.toHaveBeenCalled();
  });

  it("new_page 新建页面并加入后台受控列表", async () => {
    const chromeMock = createChromeMock({
      tabs: [{ id: 9, title: "任务页", url: "https://example.com/", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number }],
      createdTab: { id: 12, title: "新页面", url: "https://example.com/new", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.executeBrowserTool(createNamedToolCall("new_page", { url: "https://example.com/new" }));

    expect(result.content).toContain("已新建并切换到新页面");
    expect(result.content).not.toContain("12");
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: "https://example.com/new", active: true, windowId: 1 });
    expect(chromeMock.tabs.group).not.toHaveBeenCalled();
    expect(connection.attachedTabId).toBe(12);
  });

  it("后台受控列表保留 new_page 页面", async () => {
    const chromeMock = createChromeMock({
      tabs: [{ id: 9, title: "任务页", url: "https://example.com/", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number }],
      createdTab: { id: 12, title: "新页面", url: "https://example.com/new", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const newPageResult = await manager.executeBrowserTool(createNamedToolCall("new_page", { url: "https://example.com/new" }));
    const result = await manager.executeBrowserTool(createNamedToolCall("list_pages"));

    expect(newPageResult.content).not.toContain("12");
    expect(result.content).toContain("1. 任务页");
    expect(result.content).toContain("2. 当前 新页面");
    expect(connection.attachedTabId).toBe(12);
  });

  it("list_pages 只列出后台受控列表内页面并使用一基 index", async () => {
    const chromeMock = createChromeMock({
      tabs: [
        { id: 9, title: "任务页 A", url: "https://example.com/a", active: true, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
        { id: 99, title: "受限页", url: "chrome://settings", active: false, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
      ],
      createdTab: { id: 10, title: "任务页 B", url: "https://example.com/b", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    await manager.executeBrowserTool(createNamedToolCall("new_page", { url: "https://example.com/b", background: true }));
    const result = await manager.executeBrowserTool(createNamedToolCall("list_pages"));

    expect(result.content).toContain("1. 当前 任务页 A");
    expect(result.content).toContain("2. 任务页 B");
    expect(result.content).not.toContain("受限页");
    expect(chromeMock.tabs.query).not.toHaveBeenCalledWith({ groupId: 4 });
  });

  it("目标页原本属于用户分组时不修改用户标签组", async () => {
    const chromeMock = createChromeMock({
      tabs: [
        { id: 9, title: "任务页", url: "https://example.com/task", active: true, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
        { id: 99, title: "用户同组页", url: "https://outside.example/", active: false, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.executeBrowserTool(createNamedToolCall("list_pages"));

    expect(result.content).toContain("1. 当前 任务页");
    expect(result.content).toContain("2. 用户同组页");
    expect(chromeMock.tabs.group).not.toHaveBeenCalled();
  });

  it("select_page 只能切换到后台受控列表内页面", async () => {
    const chromeMock = createChromeMock({
      tabs: [
        { id: 9, title: "任务页 A", url: "https://example.com/a", active: true, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
      ],
      createdTab: { id: 10, title: "任务页 B", url: "https://example.com/b", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    await manager.executeBrowserTool(createNamedToolCall("new_page", { url: "https://example.com/b", background: true }));
    const result = await manager.executeBrowserTool(createNamedToolCall("select_page", { index: 2 }));

    expect(result.content).toContain("已切换到页面 2");
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(10, { active: true });
    expect(connection.attachedTabId).toBe(10);
  });

  it("close_page 拒绝关闭后台受控列表之外的页面 index", async () => {
    const chromeMock = createChromeMock({
      tabs: [{ id: 9, title: "任务页 A", url: "https://example.com/a", active: true, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number }],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 9);
    const result = await manager.executeBrowserTool(createNamedToolCall("close_page", { index: 2 }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "close_page",
      content: "页面 index 不在当前浏览器控制任务范围内。",
      isError: true,
    });
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
  });

  it("close_page 关闭当前页触发 debugger detach 时仍切换到剩余受控页", async () => {
    const chromeMock = createChromeMock({
      detachOnRemove: true,
      tabs: [
        { id: 9, title: "任务页 A", url: "https://example.com/a", active: true, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
      ],
      createdTab: { id: 10, title: "任务页 B", url: "https://example.com/b", active: true, windowId: 1, groupId: -1 } as chrome.tabs.Tab & { id: number },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const onDetach = vi.fn();
    const manager = new BrowserControlManager(connection, chromeMock, onDetach);

    await manager.setEnabled(true, 9);
    await manager.executeBrowserTool(createNamedToolCall("new_page", { url: "https://example.com/b", background: true }));
    const result = await manager.executeBrowserTool(createNamedToolCall("close_page", { index: 1 }));

    expect(result.content).toContain("已关闭当前受控页面 1");
    expect(result.content).toContain("并切换到页面 1");
    expect(connection.attachedTabId).toBe(10);
    expect(onDetach).not.toHaveBeenCalled();
  });

  it("navigate_page 拒绝受限或非 http URL", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const result = await manager.executeBrowserTool(createNamedToolCall("navigate_page", { action: "goto", url: "chrome://settings" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "navigate_page",
      content: "导航 URL 属于浏览器或扩展受限页面，已拒绝执行。",
      isError: true,
    });
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalledWith({ tabId: 7 }, "Page.navigate", expect.anything(), expect.any(Function));
  });

  it("navigate_page 非 goto 动作拒绝携带 url 参数", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const result = await manager.executeBrowserTool(createNamedToolCall("navigate_page", { action: "reload", url: "https://example.com/ignored" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "navigate_page",
      content: "navigate_page 只有 goto 动作可以携带 URL。",
      isError: true,
    });
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalledWith({ tabId: 7 }, "Page.reload", expect.anything(), expect.any(Function));
  });

  it("页面工具底层调试错误不会透出原始错误详情", async () => {
    const chromeMock = createChromeMock({
      sendCommandError: "Cannot access https://secret.example/?token=abc",
      sendCommandErrorMethod: "Page.reload",
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const result = await manager.executeBrowserTool(createNamedToolCall("navigate_page", { action: "reload" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "navigate_page",
      content: "浏览器调试命令执行失败，请确认当前页面仍可访问后重试。",
      isError: true,
    });
    expect(result.content).not.toContain("secret.example");
    expect(result.content).not.toContain("token=abc");
  });

  it("new_page 后台打开时拒绝 includeSnapshot 避免误读当前页快照", async () => {
    const chromeMock = createChromeMock();
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const result = await manager.executeBrowserTool(createNamedToolCall("new_page", { url: "https://example.com/new", background: true, includeSnapshot: true }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "new_page",
      content: "new_page 在后台打开页面时不能同时请求 includeSnapshot。",
      isError: true,
    });
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it("navigate_page 支持后退前进且无历史项时返回中文错误", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Page.getNavigationHistory": { currentIndex: 0, entries: [{ id: 1, url: "https://example.com/" }] },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const result = await manager.executeBrowserTool(createNamedToolCall("navigate_page", { action: "back" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "navigate_page",
      content: "当前页面没有可后退的历史记录。",
      isError: true,
    });
  });

  it("页面跳转和切换时会清理 JS 索引，避免旧页面源码残留", async () => {
    const chromeMock = createChromeMock({
      tabs: [
        { id: 7, title: "页面 A", url: "https://example.com/a", active: true, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
        { id: 8, title: "页面 B", url: "https://example.com/b", active: false, windowId: 1, groupId: 4 } as chrome.tabs.Tab & { id: number },
      ],
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    chromeMock.eventListeners[0]?.({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: "js-1",
      request: { url: "https://example.com/app.js", method: "GET" },
      type: "Script",
      timestamp: 1,
    });
    chromeMock.eventListeners[0]?.({ tabId: 7 }, "Network.responseReceived", {
      requestId: "js-1",
      type: "Script",
      timestamp: 2,
      response: { status: 200, mimeType: "application/javascript" },
    });
    chromeMock.eventListeners[0]?.({ tabId: 7 }, "Network.loadingFinished", {
      requestId: "js-1",
      timestamp: 3,
    });
    chromeMock.debugger.sendCommand.mockImplementation((_debuggee: chrome.debugger.Debuggee, method: string, _params: unknown, callback: (result?: unknown) => void) => {
      callback(method === "Network.getResponseBody"
        ? { body: "function sign(){ return 'old'; }", base64Encoded: false }
        : method === "Accessibility.getFullAXTree"
          ? { nodes: [] }
          : {});
    });
    const beforeSwitch = await manager.executeJsSourceTool(createNamedToolCall("js_search_sources", { keywords: ["sign"] }));
    expect(beforeSwitch.toolAttachments?.[0]).toBeDefined();

    await manager.executeBrowserTool(createNamedToolCall("select_page", { index: 2 }));
    const afterSwitch = await manager.executeJsSourceTool(createNamedToolCall("js_search_sources", { keywords: ["sign"] }));

    expect(afterSwitch.content).toContain("未找到匹配的 JS 源码片段");
  });

  it("JS 弹窗出现时等待用户手动处理并把确认结果追加到工具结果", async () => {
    const chromeMock = createChromeMock({
      sendCommandResults: {
        "Runtime.evaluate": { result: { value: "完成" } },
      },
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const resultPromise = manager.executeBrowserTool(createNamedToolCall("wait_for", { text: ["完成"] }));
    chromeMock.eventListeners[0]?.({ tabId: 7 }, "Page.javascriptDialogOpening", { type: "confirm", message: "确定继续吗？" });
    chromeMock.eventListeners[0]?.({ tabId: 7 }, "Page.javascriptDialogClosed", { result: true });
    const result = await resultPromise;

    expect(result.content).toContain("已等待到页面文本：完成。");
    expect(result.content).toContain("检测到网页弹窗：confirm「确定继续吗？」");
    expect(result.content).toContain("用户已确认");
  });

  it("动作 includeSnapshot 在稳定等待后读取最新快照", async () => {
    const callOrder: string[] = [];
    const chromeMock = createChromeMock({
      axNodes: [
        { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["button"] },
        { nodeId: "button", role: { value: "button" }, name: { value: "打开" }, backendDOMNodeId: 101 },
      ],
    });
    chromeMock.debugger.sendCommand.mockImplementation((_debuggee: chrome.debugger.Debuggee, method: string, _params: unknown, callback: (result?: unknown) => void) => {
      callOrder.push(method);
      callback(method === "Accessibility.getFullAXTree"
        ? { nodes: [
            { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "示例页面" }, childIds: ["button"] },
            { nodeId: "button", role: { value: "button" }, name: { value: "打开" }, backendDOMNodeId: 101 },
          ] }
        : method === "DOM.resolveNode"
          ? { object: { objectId: "node-101" } }
          : method === "DOM.getBoxModel"
            ? { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } }
            : method === "Runtime.callFunctionOn"
              ? { result: { value: true } }
              : {});
    });
    const connection = new BrowserDebuggerConnection(chromeMock);
    const manager = new BrowserControlManager(connection, chromeMock);

    await manager.setEnabled(true, 7);
    const snapshot = await manager.takeSnapshot(createToolCall());
    const uid = snapshot.content.match(/uid=([^\s]+)/)?.[1] ?? "";
    callOrder.length = 0;

    const result = await manager.executeBrowserTool(createNamedToolCall("click", { uid, includeSnapshot: true }));

    expect(result.isError).toBeFalsy();
    const stableWaitIndex = callOrder.indexOf("Runtime.evaluate");
    const snapshotIndex = callOrder.indexOf("Accessibility.getFullAXTree");
    expect(stableWaitIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(stableWaitIndex);
  });
});
