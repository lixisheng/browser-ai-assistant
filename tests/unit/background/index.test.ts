import { describe, expect, it, vi, beforeEach } from "vitest";

type Listener<T extends (...args: never[]) => void> = T;

function createChromeMock() {
  const installedListeners: Array<Listener<() => void>> = [];
  const actionListeners: Array<Listener<(tab: chrome.tabs.Tab) => void>> = [];
  const commandListeners: Array<Listener<(command: string) => void>> = [];
  const contextListeners: Array<Listener<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>> = [];

  return {
    installedListeners,
    actionListeners,
    commandListeners,
    contextListeners,
    chrome: {
      runtime: {
        onInstalled: {
          addListener: vi.fn((listener: Listener<() => void>) => installedListeners.push(listener)),
        },
        onMessage: {
          addListener: vi.fn(),
        },
      },
      contextMenus: {
        create: vi.fn(),
        onClicked: {
          addListener: vi.fn((listener: Listener<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>) =>
            contextListeners.push(listener),
          ),
        },
      },
      sidePanel: {
        open: vi.fn().mockResolvedValue(undefined),
      },
      action: {
        onClicked: {
          addListener: vi.fn((listener: Listener<(tab: chrome.tabs.Tab) => void>) => actionListeners.push(listener)),
        },
      },
      commands: {
        onCommand: {
          addListener: vi.fn((listener: Listener<(command: string) => void>) => commandListeners.push(listener)),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7 }]),
      },
    },
  };
}

describe("background 入口", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("安装时创建打开侧边栏的右键菜单", async () => {
    const mock = createChromeMock();
    vi.stubGlobal("chrome", mock.chrome);

    await import("../../../src/background/index");
    mock.installedListeners[0]();

    expect(mock.chrome.contextMenus.create).toHaveBeenCalledWith({
      id: "open-side-panel",
      title: "打开 AI 助手",
      contexts: ["page"],
    });
  });

  it("支持插件图标、快捷键和右键菜单打开侧边栏", async () => {
    const mock = createChromeMock();
    vi.stubGlobal("chrome", mock.chrome);

    await import("../../../src/background/index");

    mock.actionListeners[0]({ id: 3 } as chrome.tabs.Tab);
    await mock.commandListeners[0]("open-side-panel");
    await mock.contextListeners[0]({ menuItemId: "open-side-panel" } as chrome.contextMenus.OnClickData, {
      id: 9,
    } as chrome.tabs.Tab);

    expect(mock.chrome.sidePanel.open).toHaveBeenNthCalledWith(1, { tabId: 3 });
    expect(mock.chrome.sidePanel.open).toHaveBeenNthCalledWith(2, { tabId: 7 });
    expect(mock.chrome.sidePanel.open).toHaveBeenNthCalledWith(3, { tabId: 9 });
  });

  it("注册渠道模型列表和模型测试消息处理器", async () => {
    const mock = createChromeMock();
    vi.stubGlobal("chrome", mock.chrome);

    await import("../../../src/background/index");

    expect(mock.chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });
});
