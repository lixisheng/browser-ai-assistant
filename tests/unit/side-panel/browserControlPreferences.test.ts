import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../src/side-panel/state/appStore";
import { clearDatabase, getAppSetting, saveAppSetting } from "../../../src/shared/storage/repositories";

describe("浏览器控制全局运行态", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    useAppStore.getState().reset();
    await clearDatabase();
  });

  it("启动后默认关闭且不从聊天偏好恢复", async () => {
    await saveAppSetting({
      key: "chatPreferences",
      value: {
        systemPrompt: "全局提示",
        browserControlEnabled: true,
        temperature: 0.4,
        maxTokens: 2048,
      },
      updatedAt: 1,
    });

    await useAppStore.getState().loadChannelConfig();

    expect(useAppStore.getState().browserControlEnabled).toBe(false);
  });

  it("开启和关闭全局浏览器控制时同步通知 background", async () => {
    const sendMessage = vi.fn((message: { type: string; enabled?: boolean }, callback: (response: unknown) => void) => {
      callback({ ok: true, attached: message.enabled === true, message: "ok" });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await useAppStore.getState().setBrowserControlEnabled(true);
    await useAppStore.getState().setBrowserControlEnabled(false);

    expect(sendMessage).toHaveBeenNthCalledWith(1, { type: "browserControl.setEnabled", enabled: true }, expect.any(Function));
    expect(sendMessage).toHaveBeenNthCalledWith(2, { type: "browserControl.setEnabled", enabled: false }, expect.any(Function));
    expect(await getAppSetting("chatPreferences")).toBeUndefined();
  });

  it("自动化模式只走临时 runtime 消息且不持久化", async () => {
    const sendMessage = vi.fn((message: { type: string; mode?: string }, callback: (response: unknown) => void) => {
      callback({ ok: true, attached: true, tabId: 7, message: "ok" });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    useAppStore.setState({ browserControlEnabled: true });

    await useAppStore.getState().setBrowserAutomationMode("controlled_enhanced");
    await useAppStore.getState().setBrowserAutomationMode("normal_restricted");

    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      type: "browserControl.setAutomationMode",
      mode: "controlled_enhanced",
      reason: "用户在输入区切换浏览器自动化模式。",
    }, expect.any(Function));
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "browserControl.setAutomationMode",
      mode: "normal_restricted",
      reason: "用户在输入区切换浏览器自动化模式。",
    }, expect.any(Function));
    expect(await getAppSetting("chatPreferences")).toBeUndefined();
  });

  it("关闭或外部断开浏览器控制会清理增强模式和边界确认", async () => {
    const sendMessage = vi.fn((message: { type: string; enabled?: boolean }, callback: (response: unknown) => void) => {
      callback({ ok: true, attached: message.enabled === true, message: "ok" });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    useAppStore.setState({
      browserControlEnabled: true,
      browserAutomationMode: "controlled_enhanced",
      pendingBoundaryChoice: {
        type: "browserControl.boundaryChoiceRequest",
        requestId: "boundary-1",
        question: "是否允许？",
        reason: "测试",
        choices: [],
        allowMultiple: false,
        expiresAt: Date.now() + 1000,
      },
    });

    await useAppStore.getState().setBrowserControlEnabled(false);
    expect(useAppStore.getState().browserAutomationMode).toBe("normal_restricted");
    expect(useAppStore.getState().pendingBoundaryChoice).toBeUndefined();

    useAppStore.setState({ browserControlEnabled: true, browserAutomationMode: "controlled_enhanced" });
    useAppStore.getState().markBrowserControlDetached();
    expect(useAppStore.getState().browserControlEnabled).toBe(false);
    expect(useAppStore.getState().browserAutomationMode).toBe("normal_restricted");
  });

  it("background 拒绝开启时回滚全局浏览器控制运行态", async () => {
    const sendMessage = vi.fn((_message: { type: string; enabled?: boolean }, callback: (response: unknown) => void) => {
      callback({ ok: false, message: "当前页面无法开启浏览器控制" });
      return undefined;
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await useAppStore.getState().setBrowserControlEnabled(true);

    expect(useAppStore.getState().browserControlEnabled).toBe(false);
    expect(useAppStore.getState().failure?.message).toBe("当前页面无法开启浏览器控制");
  });
});
