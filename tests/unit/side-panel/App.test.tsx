import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../../src/side-panel/App";
import { useAppStore } from "../../../src/side-panel/state/appStore";
import { clearDatabase, saveExtractionRule, saveModelProvider, saveProviderModel } from "../../../src/shared/storage/repositories";
import type { ExtractionRule, ModelProvider, ProviderModel } from "../../../src/shared/types";

function createExtractionRule(partial: Partial<ExtractionRule>): ExtractionRule {
  return {
    id: "rule-1",
    alias: "正文区域",
    urlPattern: "https://example.com/.*",
    selectorsText: "main",
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("App", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useAppStore.getState().reset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearDatabase();
  });

  it("渲染侧边栏应用标题", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Browser AI Assistant" })).toBeInTheDocument();
  });

  it("未配置模型时在输入框区域提示用户配置 API Key 并禁用发送", () => {
    render(<App />);

    expect(screen.getByText("请先配置 API Key 后再开始对话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("配置渠道模型后可以按渠道和模型选择并切换流式模式", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "添加示例模型" }));
    await user.selectOptions(screen.getByLabelText("当前模型"), "model-1");
    await user.click(screen.getByLabelText("流式响应"));

    expect(screen.getByDisplayValue("默认渠道 / 默认 OpenAI")).toBeInTheDocument();
    expect(screen.getByLabelText("流式响应")).toBeChecked();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("请求失败时展示重试入口且不保存失败消息", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "模拟失败" }));

    expect(screen.getByText("请求失败，请重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("失败消息")).not.toBeInTheDocument();
  });

  it("设置界面使用设置级 Tab 导航并以窄面板卡片管理渠道模型", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "渠道管理" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "提取规则" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "同步设置" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "界面偏好" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "设置" }).closest("section")?.className).not.toContain("lg:grid-cols");
    expect(screen.getByRole("heading", { name: "设置" }).parentElement?.parentElement).toHaveClass("w-[80%]");
    expect(screen.getByRole("tablist", { name: "设置分类" })).toHaveClass("settings-tabs-scroll", "overflow-x-auto");
    expect(screen.getByRole("tablist", { name: "设置分类" }).className).not.toContain("lg:flex-col");
    expect(screen.queryByLabelText("历史会话")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "模型渠道" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新增渠道" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "添加模型" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "提取规则" }));

    expect(screen.getByRole("button", { name: "新增规则" })).toBeInTheDocument();
    expect(screen.queryByLabelText("CSS/XPath 列表")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "同步设置" }));

    expect(screen.getByText("忘记密钥将无法恢复已加密的同步数据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动备份" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动恢复" })).toBeInTheDocument();
  });

  it("可以在渠道管理中新增多个渠道并为当前渠道添加模型", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "新增渠道" }));
    await user.click(screen.getByRole("button", { name: "新增渠道" }));

    expect(screen.getByRole("button", { name: /新渠道 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新渠道 2/ })).toBeInTheDocument();
    expect(screen.getByDisplayValue("新渠道 2")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("渠道名称"));
    await user.type(screen.getByLabelText("渠道名称"), "OpenRouter");
    await user.click(screen.getByRole("button", { name: "添加模型" }));
    await user.click(screen.getByRole("button", { name: "添加模型" }));

    expect(screen.getByRole("button", { name: /OpenRouter/ })).toBeInTheDocument();
    expect(screen.getAllByText("gpt-4.1-mini").length).toBeGreaterThanOrEqual(2);
  });

  it("可以拉取模型列表、添加远端模型并直接在已添加模型行测试模型连通性", async () => {
    const user = userEvent.setup();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: "",
        truncated: false,
        usedFallback: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        models: [
          { id: "gpt-4.1", displayName: "GPT-4.1" },
          { id: "gpt-4.1-mini", displayName: "GPT-4.1 mini" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        message: "模型测试通过",
      });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "新增渠道" }));
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await user.type(await screen.findByRole("combobox", { name: "搜索模型" }), "mini");

    expect(screen.queryByRole("option", { name: /GPT-4.1 gpt-4.1$/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /GPT-4.1 mini/ }));

    expect(screen.getAllByText("gpt-4.1-mini").length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: /已添加/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("region", { name: "连通性校验" })).not.toBeInTheDocument();

    vi.useFakeTimers();
    const testButton = screen.getByRole("button", { name: "测试模型连通性 gpt-4.1-mini" });
    act(() => {
      fireEvent.click(testButton);
    });

    const testedModelRow = testButton.closest("article");
    expect(testedModelRow).toHaveClass("model-connectivity-card");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testedModelRow).toHaveClass("border-[var(--color-success)]");
    expect(screen.queryByText("连通性正常")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(testedModelRow).not.toHaveClass("border-[var(--color-success)]");
  });

  it("已添加模型列表只展示 model_id 和删除测试操作", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "新增渠道" }));
    await user.click(screen.getByRole("button", { name: "添加模型" }));

    expect(screen.getByText("gpt-4.1-mini")).toBeInTheDocument();
    expect(screen.queryByText("新模型 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试模型连通性 gpt-4.1-mini" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 gpt-4.1-mini" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "连通性校验" })).not.toBeInTheDocument();
  });

  it("模型连通性测试只让当前模型进入等待态，其他模型仍可测试", async () => {
    let resolveFirstTest: (value: { ok: boolean; message: string }) => void = () => undefined;
    const user = userEvent.setup();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: "",
        truncated: false,
        usedFallback: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        models: [
          { id: "gpt-4.1", displayName: "GPT-4.1" },
          { id: "gpt-4.1-mini", displayName: "GPT-4.1 mini" },
        ],
      })
      .mockReturnValueOnce(new Promise<{ ok: boolean; message: string }>((resolve) => {
        resolveFirstTest = resolve;
      }))
      .mockResolvedValueOnce({
        ok: true,
        message: "模型测试通过",
      });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "新增渠道" }));
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await user.click(await screen.findByRole("option", { name: /GPT-4.1.*gpt-4.1$/ }));
    await user.click(screen.getByRole("option", { name: /GPT-4.1 mini/ }));

    await user.click(screen.getByRole("button", { name: "测试模型连通性 gpt-4.1" }));

    expect(screen.getByRole("button", { name: "测试模型连通性 gpt-4.1" })).toHaveTextContent("测试中");
    expect(screen.getByRole("button", { name: "测试模型连通性 gpt-4.1-mini" })).toHaveTextContent("测试");
    expect(screen.getByRole("button", { name: "测试模型连通性 gpt-4.1-mini" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "测试模型连通性 gpt-4.1-mini" }));

    expect(sendMessage).toHaveBeenCalledTimes(4);
    resolveFirstTest({ ok: true, message: "模型测试通过" });
  });

  it("可以删除当前渠道并清理渠道下模型", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "新增渠道" }));
    await user.click(screen.getByRole("button", { name: "添加模型" }));
    await user.click(screen.getByRole("button", { name: "删除渠道" }));

    expect(screen.queryByRole("button", { name: /新渠道 1/ })).not.toBeInTheDocument();
    expect(screen.queryByText("新模型 1")).not.toBeInTheDocument();
  });

  it("启动时从本地存储读取渠道和模型", async () => {
    const provider: ModelProvider = {
      id: "provider-local",
      name: "本地渠道",
      endpointType: "openai_chat",
      endpointUrl: "https://api.example.com/v1/chat/completions",
      apiKey: "sk-local",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const model: ProviderModel = {
      id: "model-local",
      providerId: "provider-local",
      displayName: "本地模型",
      modelId: "gpt-local",
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: "你是网页助手",
      isTitleModel: false,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const user = userEvent.setup();

    await saveModelProvider(provider);
    await saveProviderModel(model);

    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("button", { name: /本地渠道/ })).toBeInTheDocument();
    expect(screen.getAllByText("gpt-local").length).toBeGreaterThan(0);
  });

  it("提取规则列表紧凑展示，命中当前页的规则顶置高亮并点击后展开编辑", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://example.com/article",
      text: "正文内容",
      truncated: false,
      usedFallback: false,
      matchedRuleId: "rule-match",
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });
    await saveExtractionRule(createExtractionRule({ id: "rule-other", alias: "其他站点", urlPattern: "https://other.example.com/.*", sortOrder: 1 }));
    await saveExtractionRule(createExtractionRule({ id: "rule-match", alias: "当前正文", selectorsText: "article\nmain", sortOrder: 2 }));

    render(<App />);
    await screen.findByText("已匹配规则：当前正文");
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("tab", { name: "提取规则" }));

    const ruleButtons = screen.getAllByRole("button", { name: /https:\/\// });
    expect(ruleButtons[0]).toHaveTextContent("当前正文");
    expect(ruleButtons[0].closest("article")).toHaveClass("border-[var(--color-primary)]");
    expect(screen.queryByLabelText("CSS/XPath 列表")).not.toBeInTheDocument();

    await user.click(ruleButtons[0]);

    expect(screen.getByLabelText("规则别名")).toHaveDisplayValue("当前正文");
    expect(screen.getByLabelText("URL 正则")).toHaveDisplayValue("https://example.com/.*");
    expect(screen.getByLabelText("CSS/XPath 列表")).toHaveDisplayValue("article\nmain");
  });

  it("新增提取规则必须显式保存且校验失败不落库", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("tab", { name: "提取规则" }));
    await user.click(screen.getByRole("button", { name: "新增规则" }));

    await user.clear(screen.getByLabelText("URL 正则"));
    fireEvent.change(screen.getByLabelText("URL 正则"), { target: { value: "[" } });
    await user.clear(screen.getByLabelText("CSS/XPath 列表"));
    await user.type(screen.getByLabelText("CSS/XPath 列表"), "main");
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    expect(screen.getByText("URL 正则格式不正确")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("URL 正则"));
    fireEvent.change(screen.getByLabelText("URL 正则"), { target: { value: "https://example\\.com/.*" } });
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    expect(await screen.findByRole("button", { name: /https:\/\/example\\\.com\/\.\*/ })).toBeInTheDocument();
  });

  it("点击 AI 生成后先选择模型，再展示 URL 正则候选并可填充输入框", async () => {
    const user = userEvent.setup();
    const provider: ModelProvider = {
      id: "provider-ai",
      name: "AI 渠道",
      endpointType: "openai_chat",
      endpointUrl: "https://api.example.com/v1/chat/completions",
      apiKey: "sk-ai",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const model: ProviderModel = {
      id: "model-ai",
      providerId: "provider-ai",
      displayName: "AI 模型",
      modelId: "gpt-test",
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: "你是网页助手",
      isTitleModel: false,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        url: "https://example.com/news/123?from=home",
        text: "",
        truncated: false,
        usedFallback: true,
      });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                "https://example\\.com/news/123",
                "https://example\\.com/news/\\d+",
                "https://example\\.com/news/.*",
                "https://example\\.com/.*",
                "https://.*",
              ]),
            },
          },
        ],
      }),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await saveModelProvider(provider);
    await saveProviderModel(model);

    render(<App />);
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("tab", { name: "提取规则" }));
    await user.click(screen.getByRole("button", { name: "新增规则" }));
    await user.type(screen.getByLabelText("CSS/XPath 列表"), "main");
    await user.click(screen.getByRole("button", { name: "AI 生成" }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("选择用于生成的模型")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "AI 渠道 / AI 模型" }));

    expect(await screen.findByRole("button", { name: "https://example\\.com/news/\\d+" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
      }),
    );

    await user.click(screen.getByRole("button", { name: "https://example\\.com/news/\\d+" }));

    expect(screen.getByLabelText("URL 正则")).toHaveDisplayValue("https://example\\.com/news/\\d+");
  });

  it("对话页展示当前页上下文状态、截断提示和可折叠预览", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          url: "https://example.com/article",
          text: "这是一段提取后的页面正文",
          truncated: true,
          usedFallback: false,
          matchedRuleId: "rule-1",
        }),
      },
    });
    await saveExtractionRule(createExtractionRule({ id: "rule-1", alias: "正文规则" }));

    render(<App />);

    expect(await screen.findByText("已匹配规则：正文规则")).toBeInTheDocument();
    expect(screen.getByText("内容已截断，请细化 CSS/XPath")).toBeInTheDocument();
    const summary = screen.getByText("查看上下文");
    expect(summary).toHaveClass("select-none");
    await user.click(summary);

    expect(screen.getByText("这是一段提取后的页面正文")).toBeInTheDocument();
  });
});
