import { describe, expect, it, vi } from "vitest";
import { BrowserControlActionExecutor } from "../../../src/background/browserControl/actions";
import type { ModelToolCall } from "../../../src/shared/models/types";

function createToolCall(name: string, args: Record<string, unknown>): ModelToolCall {
  return {
    id: "call-1",
    name,
    arguments: args,
  };
}

describe("浏览器控制动作执行器", () => {
  it("拒绝执行动作模块白名单之外的 CDP 方法", async () => {
    const connection = {
      resolveNodeByBackendId: vi.fn(async () => ({ object: { objectId: "object-1" } })),
      scrollIntoViewIfNeeded: vi.fn(),
      getBoxModel: vi.fn(),
      callFunctionOn: vi.fn(async () => ({ result: { value: { tagName: "INPUT", type: "text", role: "", isContentEditable: false } } })),
      evaluate: vi.fn(async () => {
        throw new Error("不应允许的 CDP 方法");
      }),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    };
    const snapshot = {
      getBackendNodeId: vi.fn(() => 101),
      takeSnapshot: vi.fn(async () => "页面快照"),
    };
    const executor = new BrowserControlActionExecutor(connection, snapshot);

    const result = await executor.execute(createToolCall("fill", { uid: "1_1", value: "张三" }));

    expect(result.isError).toBeUndefined();
    expect(connection.evaluate).not.toHaveBeenCalled();
  });

  it("click 命中检测确认元素被遮挡时不走 JS fallback", async () => {
    const connection = {
      resolveNodeByBackendId: vi.fn(async () => ({ object: { objectId: "object-1" } })),
      scrollIntoViewIfNeeded: vi.fn(),
      getBoxModel: vi.fn(async () => ({ model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } })),
      callFunctionOn: vi.fn(async () => ({ result: { value: false } })),
      evaluate: vi.fn(),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    };
    const snapshot = {
      getBackendNodeId: vi.fn(() => 101),
      takeSnapshot: vi.fn(async () => "页面快照"),
    };
    const executor = new BrowserControlActionExecutor(connection, snapshot);

    const result = await executor.execute(createToolCall("click", { uid: "1_1" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "click",
      content: "元素当前被遮挡，无法安全点击。请重新调用 take_snapshot 获取最新页面状态后再继续。",
      isError: true,
    });
    expect(connection.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(connection.callFunctionOn).toHaveBeenCalledTimes(1);
  });

  it("fill 空字符串表示清空输入框，并通过受控 JS 兜底清理残留值", async () => {
    const connection = {
      resolveNodeByBackendId: vi.fn(async () => ({ object: { objectId: "object-1" } })),
      scrollIntoViewIfNeeded: vi.fn(),
      getBoxModel: vi.fn(),
      callFunctionOn: vi.fn(async () => ({ result: { value: { tagName: "INPUT", type: "text", role: "", isContentEditable: false } } })),
      evaluate: vi.fn(),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    };
    const snapshot = {
      getBackendNodeId: vi.fn(() => 101),
      takeSnapshot: vi.fn(async () => "页面快照"),
    };
    const executor = new BrowserControlActionExecutor(connection, snapshot);

    const result = await executor.execute(createToolCall("fill", { uid: "1_1", value: "" }));

    expect(result.content).toBe("已填写元素 1_1。");
    expect(connection.callFunctionOn).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: "object-1",
        functionDeclaration: expect.stringContaining("this.value = \"\""),
      }),
    );
    expect(connection.insertText).not.toHaveBeenCalled();
  });

  it("fill select 未匹配到 option 时返回错误而不是假成功", async () => {
    const connection = {
      resolveNodeByBackendId: vi.fn(async () => ({ object: { objectId: "object-1" } })),
      scrollIntoViewIfNeeded: vi.fn(),
      getBoxModel: vi.fn(),
      callFunctionOn: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { tagName: "SELECT", type: "", role: "", isContentEditable: false } } })
        .mockResolvedValueOnce({ result: { value: false } }),
      evaluate: vi.fn(),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    };
    const snapshot = {
      getBackendNodeId: vi.fn(() => 101),
      takeSnapshot: vi.fn(async () => "页面快照"),
    };
    const executor = new BrowserControlActionExecutor(connection, snapshot);

    const result = await executor.execute(createToolCall("fill", { uid: "1_1", value: "不存在选项" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "fill",
      content: "下拉框中没有匹配的选项：不存在选项。",
      isError: true,
    });
  });

  it("press_key 遇到非法组合键时不先发送修饰键", async () => {
    const connection = {
      resolveNodeByBackendId: vi.fn(),
      scrollIntoViewIfNeeded: vi.fn(),
      getBoxModel: vi.fn(),
      callFunctionOn: vi.fn(),
      evaluate: vi.fn(),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    };
    const snapshot = {
      getBackendNodeId: vi.fn(() => 101),
      takeSnapshot: vi.fn(async () => "页面快照"),
    };
    const executor = new BrowserControlActionExecutor(connection, snapshot);

    const result = await executor.execute(createToolCall("press_key", { key: "Ctrl+F13" }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "press_key",
      content: "按键 Ctrl+F13 不在允许列表中。",
      isError: true,
    });
    expect(connection.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("wait_for 拒绝非字符串文本项并且不执行页面脚本", async () => {
    const connection = {
      resolveNodeByBackendId: vi.fn(),
      scrollIntoViewIfNeeded: vi.fn(),
      getBoxModel: vi.fn(),
      callFunctionOn: vi.fn(),
      evaluate: vi.fn(async () => ({ result: { value: "完成" } })),
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    };
    const snapshot = {
      getBackendNodeId: vi.fn(() => 101),
      takeSnapshot: vi.fn(async () => "页面快照"),
    };
    const executor = new BrowserControlActionExecutor(connection, snapshot);

    const result = await executor.execute(createToolCall("wait_for", { text: ["完成", 123] }));

    expect(result).toEqual({
      toolCallId: "call-1",
      name: "wait_for",
      content: "wait_for 的 text 只能包含非空字符串。",
      isError: true,
    });
    expect(connection.evaluate).not.toHaveBeenCalled();
  });
});
