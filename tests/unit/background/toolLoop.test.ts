import { describe, expect, it, vi } from "vitest";
import { runModelToolLoop } from "../../../src/background/toolCalling/toolLoop";
import type { ModelRequestMessage, ModelToolExecutor, ModelToolRegistryEntry } from "../../../src/shared/models/types";

const baseMessages: ModelRequestMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "读取页面",
    createdAt: 1,
    modelId: "model-1",
    endpointType: "openai_chat",
    streamMode: false,
    systemPrompt: "你是网页助手",
    contextPrompt: "",
    contextMode: "text",
  },
];

const tool: ModelToolRegistryEntry = {
  id: "page.read_context",
  name: "read_page_context",
  description: "读取当前页面上下文",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string" },
    },
    required: ["mode"],
    additionalProperties: false,
  },
};

describe("通用模型工具循环", () => {
  it("没有工具调用时直接返回最终文本", async () => {
    const requestModel = vi.fn().mockResolvedValue({
      ok: true,
      content: "最终回答",
    });
    const executeTool = vi.fn<ModelToolExecutor>();

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      executeTool,
    });

    expect(result).toEqual({ ok: true, content: "最终回答", thinking: undefined });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("存在最终模型请求时，没有工具调用也重新请求最终回复", async () => {
    const requestModel = vi.fn().mockResolvedValue({
      ok: true,
      content: "工具决策阶段回答",
    });
    const requestFinalModel = vi.fn().mockResolvedValue({
      ok: true,
      content: "最终流式回答",
    });
    const executeTool = vi.fn<ModelToolExecutor>();

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      requestFinalModel,
      executeTool,
    });

    expect(result).toEqual({ ok: true, content: "最终流式回答", thinking: undefined });
    expect(requestFinalModel).toHaveBeenCalledWith(baseMessages);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("存在最终模型请求时会先跑完多轮工具决策再请求最终回复", async () => {
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [{ id: "call-1", name: "read_page_context", arguments: { mode: "text" } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [{ id: "call-2", name: "read_page_context", arguments: { mode: "all" } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "工具决策完成",
      });
    const requestFinalModel = vi.fn().mockResolvedValue({
      ok: true,
      content: "最终流式回答",
    });
    const executeTool: ModelToolExecutor = vi.fn(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: `工具结果：${call.id}`,
    }));

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      requestFinalModel,
      executeTool,
    });

    expect(result).toEqual({ ok: true, content: "最终流式回答", thinking: undefined });
    expect(requestModel).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(requestFinalModel).toHaveBeenCalledTimes(1);
    expect(requestFinalModel).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "工具结果：call-1" }),
        expect.objectContaining({ role: "tool", toolCallId: "call-2", content: "工具结果：call-2" }),
      ]),
    );
  });

  it("工具调用后执行已启用工具并回灌结果继续请求", async () => {
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [{ id: "call-1", name: "read_page_context", arguments: { mode: "text" } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "页面标题是示例",
      });
    const executeTool: ModelToolExecutor = vi.fn(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: "页面标题：示例",
    }));

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      executeTool,
    });

    expect(result).toEqual({ ok: true, content: "页面标题是示例", thinking: undefined });
    expect(executeTool).toHaveBeenCalledWith({ id: "call-1", name: "read_page_context", arguments: { mode: "text" } }, tool);
    expect(requestModel).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", toolCalls: expect.any(Array) }),
        expect.objectContaining({ role: "tool", toolCallId: "call-1", content: "页面标题：示例" }),
      ]),
    );
  });

  it("同一轮多个搜索工具结果会合并附件而不是互相覆盖", async () => {
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [
          { id: "call-1", name: "read_page_context", arguments: { mode: "text" } },
          { id: "call-2", name: "read_page_context", arguments: { mode: "all" } },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "已合并搜索结果",
      });
    const executeTool: ModelToolExecutor = vi.fn(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: `搜索结果：${call.id}`,
      webSearchContextAttachment: {
        provider: "tavily" as const,
        query: call.id === "call-1" ? "关键词 A" : "关键词 B",
        answer: call.id === "call-1" ? "答案 A" : "答案 B",
        results: [
          {
            title: call.id === "call-1" ? "结果 A" : "结果 B",
            url: call.id === "call-1" ? "https://example.com/a" : "https://example.com/b",
            content: call.id === "call-1" ? "内容 A" : "内容 B",
          },
        ],
        createdAt: call.id === "call-1" ? 1 : 2,
        truncated: call.id === "call-2",
      },
    }));

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      executeTool,
    });

    expect(result).toMatchObject({
      ok: true,
      content: "已合并搜索结果",
      webSearchContextAttachment: {
        provider: "tavily",
        query: "关键词 A；关键词 B",
        answer: "答案 A\n\n答案 B",
        createdAt: 2,
        truncated: true,
      },
    });
    expect(result.ok && result.webSearchContextAttachment?.results.map((item) => item.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("工具未启用时不执行并把中文错误回灌给模型", async () => {
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [{ id: "call-1", name: "read_page_context", arguments: { mode: "text" } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "我无法读取页面",
      });
    const executeTool = vi.fn<ModelToolExecutor>();

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: [],
      requestModel,
      executeTool,
    });

    expect(result).toEqual({ ok: true, content: "我无法读取页面", thinking: undefined });
    expect(executeTool).not.toHaveBeenCalled();
    expect(requestModel).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-1",
          content: "工具 read_page_context 未启用，已拒绝执行。",
          isError: true,
        }),
      ]),
    );
  });

  it("工具未注册时不执行并把中文错误回灌给模型", async () => {
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [{ id: "call-1", name: "unknown_tool", arguments: { mode: "text" } }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "没有可用工具。",
      });
    const executeTool = vi.fn<ModelToolExecutor>();

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      executeTool,
    });

    expect(result).toEqual({ ok: true, content: "没有可用工具。", thinking: undefined });
    expect(executeTool).not.toHaveBeenCalled();
    expect(requestModel).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-1",
          content: "工具 unknown_tool 未注册，已拒绝执行。",
          isError: true,
        }),
      ]),
    );
  });

  it("工具参数非法时不执行并回灌错误", async () => {
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: "",
        toolCalls: [{ id: "call-1", name: "read_page_context", arguments: [], parseError: "工具参数必须是对象" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "参数错误",
      });
    const executeTool = vi.fn<ModelToolExecutor>();

    await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      executeTool,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(requestModel).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: "工具 read_page_context 参数无效：工具参数必须是对象",
          isError: true,
        }),
      ]),
    );
  });

  it("超过最大循环次数时返回中文失败", async () => {
    const requestModel = vi.fn().mockResolvedValue({
      ok: true,
      content: "",
      toolCalls: [{ id: "call-1", name: "read_page_context", arguments: { mode: "text" } }],
    });
    const executeTool: ModelToolExecutor = vi.fn(async (call) => ({
      toolCallId: call.id,
      name: call.name,
      content: "页面标题：示例",
    }));

    const result = await runModelToolLoop({
      initialMessages: baseMessages,
      tools: [tool],
      enabledToolIds: ["page.read_context"],
      requestModel,
      executeTool,
      maxIterations: 1,
    });

    expect(result).toEqual({ ok: false, message: "工具调用超过最大轮次，已停止本次请求。" });
  });
});
