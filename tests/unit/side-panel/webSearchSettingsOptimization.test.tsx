import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPreferenceDrawer } from "../../../src/side-panel/components/ChatPreferenceDrawer";
import { SettingsPanel } from "../../../src/side-panel/components/SettingsPanel";
import { useAppStore } from "../../../src/side-panel/state/appStore";
import { clearDatabase } from "../../../src/shared/storage/repositories";
import type { ChatSession, ModelProvider, ProviderModel } from "../../../src/shared/types";

function createProvider(partial: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "provider-1",
    name: "测试渠道",
    endpointType: "openai_chat",
    endpointUrl: "https://api.example.com",
    apiKey: "sk-test",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function createModel(partial: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "model-1",
    providerId: "provider-1",
    displayName: "测试模型",
    modelId: "gpt-test",
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: "你是网页助手",
    isTitleModel: false,
    supportsVision: false,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function createSession(partial: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "测试会话",
    archived: false,
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...partial,
  };
}

describe("网络搜索设置优化", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    useAppStore.getState().reset();
    await clearDatabase();
  });

  it("模型渠道点击展开后再次点击同一渠道会折叠配置", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      providers: [createProvider()],
      models: [createModel()],
    });

    render(<SettingsPanel />);

    expect(screen.queryByRole("region", { name: "当前渠道详情" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /测试渠道/ }));
    expect(screen.getByRole("region", { name: "当前渠道详情" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "渠道模型" })).toBeInTheDocument();
    expect(screen.getByLabelText("默认对话模型")).toBeInTheDocument();
    expect(screen.getByLabelText("AI 标题生成模型")).toBeInTheDocument();
    expect(screen.getByText("gpt-test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /测试渠道/ }));
    expect(screen.queryByRole("region", { name: "当前渠道详情" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "渠道模型" })).toBeInTheDocument();
    expect(screen.getByLabelText("默认对话模型")).toBeInTheDocument();
    expect(screen.getByLabelText("AI 标题生成模型")).toBeInTheDocument();
    expect(screen.getByText("gpt-test")).toBeInTheDocument();
  });

  it("模型渠道从空列表异步加载后会自动选中真实渠道", async () => {
    const user = userEvent.setup();
    const addProvider = vi.fn(() => createProvider({ id: "provider-created", name: "误建渠道" }));
    const addModel = vi.fn();
    useAppStore.setState({
      providers: [],
      models: [],
      addProvider,
      addModel,
    });

    render(<SettingsPanel />);
    expect(screen.getByText("默认渠道")).toBeInTheDocument();

    useAppStore.setState({
      providers: [createProvider()],
      models: [createModel()],
    });

    expect(await screen.findByRole("button", { name: /测试渠道/ })).toBeInTheDocument();
    expect(screen.queryByText("默认渠道")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加模型" }));
    expect(addProvider).not.toHaveBeenCalled();
    expect(addModel).toHaveBeenCalledWith("provider-1");
  });

  it("网络搜索配置与渠道模型配置是渠道管理下的同级 section", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      providers: [createProvider()],
      models: [createModel()],
    });

    render(<SettingsPanel />);

    await user.click(screen.getByRole("button", { name: /测试渠道/ }));

    const channelManagement = screen.getByRole("region", { name: "渠道管理" });
    const webSearchSection = screen.getByRole("region", { name: "网络搜索配置" });
    const modelSection = screen.getByRole("region", { name: "渠道模型" });

    expect(webSearchSection.parentElement).toBe(channelManagement);
    expect(modelSection.parentElement).toBe(channelManagement);
    expect(modelSection).not.toContainElement(webSearchSection);
  });

  it("网络搜索配置可以设置 Tavily 参数并切换 API Key 明文显示", async () => {
    const user = userEvent.setup();
    const updateWebSearchSettings = vi.fn(async (updates) => {
      useAppStore.setState((state) => ({
        webSearchSettings: {
          ...state.webSearchSettings,
          ...updates,
          tavily: {
            ...state.webSearchSettings.tavily,
            ...updates.tavily,
          },
        },
      }));
    });
    useAppStore.setState({
      updateWebSearchSettings,
      webSearchSettings: {
        provider: "tavily",
        tavily: {
          apiKeysText: "tvly-secret",
          apiKeyStrategy: "round_robin",
          includeAnswer: "basic",
          includeRawContent: false,
          maxResults: 5,
        },
        updatedAt: 1,
      },
    });

    render(<SettingsPanel />);

    const apiKeyInput = screen.getByLabelText("Tavily API Key");
    expect(apiKeyInput).toHaveAttribute("type", "password");
    const showButton = screen.getByRole("button", { name: "显示 Tavily API Key 明文" });
    expect(showButton.querySelector(".tavily-api-key-visibility-icon-closed")).toBeInTheDocument();
    expect(showButton).not.toHaveTextContent("◎");
    expect(showButton).not.toHaveTextContent("◉");

    await user.click(showButton);
    expect(apiKeyInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隐藏 Tavily API Key 明文" }).querySelector(".tavily-api-key-visibility-icon-open")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Tavily 综合答案" }), "advanced");
    expect(updateWebSearchSettings).toHaveBeenLastCalledWith({
      tavily: expect.objectContaining({ includeAnswer: "advanced" }),
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Tavily 原始内容" }), "markdown");
    expect(updateWebSearchSettings).toHaveBeenLastCalledWith({
      tavily: expect.objectContaining({ includeRawContent: "markdown" }),
    });

    const maxResultsInput = screen.getByRole("spinbutton", { name: "全局 Tavily 最大结果数" });
    fireEvent.change(maxResultsInput, { target: { value: "12" } });
    expect(updateWebSearchSettings).toHaveBeenLastCalledWith({
      tavily: expect.objectContaining({ maxResults: 12 }),
    });
  });

  it("当前聊天设置可以覆盖 Tavily 参数并恢复继承全局", async () => {
    const user = userEvent.setup();
    const updateActiveSessionChatPreferences = vi.fn(async (updates) => {
      useAppStore.setState((state) => ({
        chatSessions: state.chatSessions.map((session) =>
          session.id === state.activeSessionId
            ? {
                ...session,
                chatPreferenceOverrides: {
                  ...session.chatPreferenceOverrides,
                  ...updates,
                },
              }
            : session,
        ),
      }));
    });
    useAppStore.setState((state) => ({
      activeSessionId: "session-1",
      chatSessions: [
        createSession({
          chatPreferenceOverrides: {
            webSearchIncludeAnswer: "advanced",
            webSearchIncludeRawContent: "markdown",
            webSearchMaxResults: 8,
          },
        }),
      ],
      webSearchSettings: {
        ...state.webSearchSettings,
        tavily: {
          ...state.webSearchSettings.tavily,
          includeAnswer: "basic",
          includeRawContent: false,
          maxResults: 5,
        },
      },
      updateActiveSessionChatPreferences,
    }));

    render(<ChatPreferenceDrawer open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "当前聊天 Tavily 综合答案" })).toHaveDisplayValue("深入答案");
    expect(screen.getByRole("combobox", { name: "当前聊天 Tavily 原始内容" })).toHaveDisplayValue("Markdown");
    expect(screen.getByRole("spinbutton", { name: "当前聊天 Tavily 最大结果数" })).toHaveDisplayValue("8");

    await user.selectOptions(screen.getByRole("combobox", { name: "当前聊天 Tavily 综合答案" }), "false");
    expect(updateActiveSessionChatPreferences).toHaveBeenLastCalledWith({ webSearchIncludeAnswer: false });

    await user.selectOptions(screen.getByRole("combobox", { name: "当前聊天 Tavily 原始内容" }), "text");
    expect(updateActiveSessionChatPreferences).toHaveBeenLastCalledWith({ webSearchIncludeRawContent: "text" });

    const maxResultsInput = screen.getByRole("spinbutton", { name: "当前聊天 Tavily 最大结果数" });
    await user.clear(maxResultsInput);
    await user.type(maxResultsInput, "10");
    expect(updateActiveSessionChatPreferences).toHaveBeenLastCalledWith({ webSearchMaxResults: 10 });

    await user.click(screen.getByRole("button", { name: "恢复当前聊天网络搜索设置为全局默认" }));
    expect(updateActiveSessionChatPreferences).toHaveBeenLastCalledWith({
      webSearchPolicy: undefined,
      webSearchIncludeAnswer: undefined,
      webSearchIncludeRawContent: undefined,
      webSearchMaxResults: undefined,
    });
  });
});
