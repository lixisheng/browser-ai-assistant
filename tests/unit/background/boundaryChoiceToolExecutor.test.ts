import { describe, expect, it, vi } from "vitest";
import { BoundaryChoiceToolExecutor } from "../../../src/background/browserControl/boundaryChoiceToolExecutor";
import type { BrowserControlBoundaryChoiceRequestMessage } from "../../../src/shared/browserControl";
import type { ModelToolCall } from "../../../src/shared/models/types";
import { createBoundaryGrantScopeKey } from "../../../src/shared/toolAuthorization";

function createToolCall(argumentsValue: Record<string, unknown>): ModelToolCall {
  return {
    id: "call-boundary",
    name: "boundary_request_user_choice",
    arguments: argumentsValue,
  };
}

function createRequestArguments(): Record<string, unknown> {
  return {
    question: "是否允许本轮只发送一个不携带凭据的请求重放草案？",
    reason: "需要验证已采集接口在无登录凭据时的响应结构是否一致。",
    choices: [
      {
        id: "send_once",
        title: "发送一次无凭据重放",
        description: "只允许发送当前草案一次，不携带 Cookie、Authorization 或页面上下文凭据。",
        risk: "medium",
        grants: ["send_single_confirmed_replay_request_without_credentials"],
      },
      {
        id: "summary_only",
        title: "只保留脱敏草案",
        description: "不发送网络请求，只把脱敏草案回灌给模型继续分析。",
        risk: "low",
        grants: [],
      },
    ],
    allowMultiple: false,
    expiresInMs: 30000,
    scopeKey: "replay_send_request\u0000draft-1",
  };
}

describe("受控增强边界确认执行器", () => {
  it("用户选择 AI 提供的动态选项后生成一次性授权", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );

    const resultPromise = executor.execute(createToolCall(createRequestArguments()));
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());
    expect(pendingRequest).toMatchObject({
      question: "是否允许本轮只发送一个不携带凭据的请求重放草案？",
      allowMultiple: false,
      choices: expect.arrayContaining([expect.objectContaining({ id: "send_once" })]),
    });

    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["send_once"] })).toBe(true);
    expect(executor.getCurrentGrantContext()).toMatchObject({
      tabId: 7,
      origin: "https://example.com",
      scopeKey: "replay_send_request\u0000draft-1",
      grants: ["send_single_confirmed_replay_request_without_credentials"],
      selectedChoiceIds: ["send_once"],
    });
    const result = await resultPromise;

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("用户已确认本次受控增强边界");
    expect(executor.getCurrentGrantContext()).toMatchObject({
      tabId: 7,
      origin: "https://example.com",
      scopeKey: "replay_send_request\u0000draft-1",
      grants: ["send_single_confirmed_replay_request_without_credentials"],
      selectedChoiceIds: ["send_once"],
    });
  });

  it("用户填写其他不会直接授权，而是回灌给模型重新确认", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );

    const resultPromise = executor.execute(createToolCall(createRequestArguments()));
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());
    executor.respond(pendingRequest!.requestId, { selectedChoiceIds: [], otherText: "只允许查看草案，不允许发送请求" });
    const result = await resultPromise;

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("用户选择了其他边界");
    expect(executor.getCurrentGrantContext()).toBeUndefined();
  });

  it("清理一次性授权不会解除等待中的用户边界确认", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );
    let settled = false;

    const resultPromise = executor.execute(createToolCall(createRequestArguments())).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());

    executor.clearGrantContext();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["summary_only"] })).toBe(true);
    const result = await resultPromise;
    expect(result).toMatchObject({
      isError: true,
      content: "用户未授权本次边界请求。",
    });
    expect(executor.getCurrentGrantContext()).toBeUndefined();
  });

  it("伪造未知选项或违反单选约束时不会解除等待确认", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );

    const resultPromise = executor.execute(createToolCall(createRequestArguments()));
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());

    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["unknown"] })).toBe(false);
    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["send_once", "summary_only"] })).toBe(false);
    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["send_once"] })).toBe(true);
    const result = await resultPromise;

    expect(result.isError).toBeUndefined();
    expect(executor.getCurrentGrantContext()).toMatchObject({
      selectedChoiceIds: ["send_once"],
      grants: ["send_single_confirmed_replay_request_without_credentials"],
    });
  });

  it("AI 主动询问时可通过目标工具和参数绑定后续真实放行边界", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );
    const targetToolCall = {
      name: "network_get_request_details",
      arguments: { requestIds: ["req-1"] },
    };

    const resultPromise = executor.execute(createToolCall({
      ...createRequestArguments(),
      scopeKey: undefined,
      targetToolName: targetToolCall.name,
      targetToolArguments: targetToolCall.arguments,
    }));
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());
    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["send_once"] })).toBe(true);
    await resultPromise;

    expect(executor.getCurrentGrantContext()).toMatchObject({
      scopeKey: createBoundaryGrantScopeKey(targetToolCall),
    });
  });

  it("目标工具绑定兼容点号 ID 和下划线工具名", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );
    const targetArguments = { requestIds: ["req-1"] };

    const resultPromise = executor.execute(createToolCall({
      ...createRequestArguments(),
      scopeKey: undefined,
      targetToolName: "network.get_request_details",
      targetToolArguments: targetArguments,
    }));
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());
    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["send_once"] })).toBe(true);
    await resultPromise;

    expect(executor.getCurrentGrantContext()).toMatchObject({
      scopeKey: createBoundaryGrantScopeKey({
        name: "network_get_request_details",
        arguments: targetArguments,
      }),
    });
  });

  it("AI 主动询问缺少目标工具绑定时不会生成无法消费的假授权", async () => {
    let pendingRequest: BrowserControlBoundaryChoiceRequestMessage | undefined;
    const executor = new BoundaryChoiceToolExecutor(
      vi.fn((request) => {
        pendingRequest = request;
      }),
      () => ({ tabId: 7, origin: "https://example.com", enhanced: true }),
    );

    const resultPromise = executor.execute(createToolCall({
      ...createRequestArguments(),
      scopeKey: undefined,
    }));
    await vi.waitFor(() => expect(pendingRequest).toBeDefined());
    expect(executor.respond(pendingRequest!.requestId, { selectedChoiceIds: ["send_once"] })).toBe(true);
    const result = await resultPromise;

    expect(result).toMatchObject({
      isError: true,
      content: "边界确认缺少目标工具绑定，无法生成可消费的一次性授权。请带 targetToolName 和 targetToolArguments 重新请求用户确认。",
    });
    expect(executor.getCurrentGrantContext()).toBeUndefined();
  });

  it("非受控增强模式和高风险意图会 fail closed", async () => {
    const disabledExecutor = new BoundaryChoiceToolExecutor(vi.fn(), () => ({ tabId: 7, origin: "https://example.com", enhanced: false }));
    await expect(disabledExecutor.execute(createToolCall(createRequestArguments()))).resolves.toMatchObject({
      isError: true,
      content: "当前不是受控增强模式，无法请求用户边界确认。",
    });

    const executor = new BoundaryChoiceToolExecutor(vi.fn(), () => ({ tabId: 7, origin: "https://example.com", enhanced: true }));
    await expect(executor.execute(createToolCall({
      ...createRequestArguments(),
      question: "是否允许对当前站点执行批量扫描并尝试绕过风控限制？",
    }))).resolves.toMatchObject({
      isError: true,
      content: "边界确认问题包含不允许的高风险意图。",
    });
  });
});
