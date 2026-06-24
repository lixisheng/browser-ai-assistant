import { describe, expect, it, vi } from "vitest";
import { FullAccessToolExecutor } from "../../../src/background/browserControl/fullAccessToolExecutor";
import type { ModelToolCall } from "../../../src/shared/models/types";
import type { NetworkRequestDetail } from "../../../src/shared/types";

function createToolCall(name: string, args: Record<string, unknown> = {}): ModelToolCall {
  return { id: `call-${name}`, name, arguments: args };
}

type EvaluateMock = ReturnType<typeof vi.fn<(params: Record<string, unknown>) => Promise<unknown>>>;
type GetDetailsMock = ReturnType<typeof vi.fn<(requestIds: string[], options?: { redacted?: boolean }) => Promise<NetworkRequestDetail[]>>>;
type RevokeMock = ReturnType<typeof vi.fn<() => void>>;

describe("完全访问工具执行器", () => {
  it("非完全访问模式下伪造调用会 fail closed", async () => {
    const executor = new FullAccessToolExecutor(
      { evaluate: vi.fn() },
      { isEnabled: true, getDetails: vi.fn() },
      () => ({ tabId: 7, origin: "https://example.com", fullAccess: false }),
      vi.fn(),
    );

    const result = await executor.execute(createToolCall("full_access_execute_script", { script: "document.cookie" }));

    expect(result).toMatchObject({
      isError: true,
      content: "当前不是完全访问模式，已拒绝执行 full_access.* 工具。",
    });
  });

  it("execute_script 执行任意脚本并返回 Runtime 原始结果", async () => {
    const evaluate = vi.fn(async (_params: Record<string, unknown>) => ({ result: { value: { password: "123456", token: "secret" } } }));
    const executor = createExecutor({ evaluate });

    const result = await executor.execute(createToolCall("full_access_execute_script", {
      script: "({ password: document.querySelector('#password')?.value, token: localStorage.token })",
    }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("123456");
    expect(result.content).toContain("secret");
    expect(evaluate).toHaveBeenCalledWith({
      expression: "({ password: document.querySelector('#password')?.value, token: localStorage.token })",
      awaitPromise: true,
      returnByValue: true,
    });
  });

  it("fetch 默认携带页面凭据并返回原始响应", async () => {
    const evaluate = vi.fn(async (_params: Record<string, unknown>) => ({ result: { value: { status: 200, body: "{\"password\":\"123456\"}" } } }));
    const executor = createExecutor({ evaluate });

    const result = await executor.execute(createToolCall("full_access_fetch", {
      url: "/api/login",
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: "{\"password\":\"123456\"}",
    }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("123456");
    const params = evaluate.mock.calls[0]?.[0] as unknown as { expression: string; awaitPromise: boolean; returnByValue: boolean };
    expect(params.awaitPromise).toBe(true);
    expect(params.returnByValue).toBe(true);
    expect(params.expression).toContain('"credentials":"include"');
    expect(params.expression).toContain('"Authorization":"Bearer secret"');
  });

  it("get_network_details 返回未脱敏 Network 原文", async () => {
    const getDetails = vi.fn(async (_requestIds: string[], _options?: { redacted?: boolean }) => [{
      id: "req-1",
      url: "https://example.com/api?token=secret",
      method: "POST",
      requestHeaders: [{ name: "Authorization", value: "Bearer secret" }],
      requestBody: "{\"password\":\"123456\"}",
      responseBody: "{\"token\":\"secret\"}",
      truncated: false,
      redacted: false,
    }]);
    const executor = createExecutor({ getDetails });

    const result = await executor.execute(createToolCall("full_access_get_network_details", { requestIds: ["req-1"] }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Bearer secret");
    expect(result.content).toContain("\\\"password\\\":\\\"123456\\\"");
    expect(result.toolAttachments?.[0]).toMatchObject({
      kind: "network",
      redacted: false,
      fullAccess: true,
      requests: [expect.objectContaining({
        requestBody: "{\"password\":\"123456\"}",
        responseBody: "{\"token\":\"secret\"}",
        redacted: false,
      })],
    });
    expect(getDetails).toHaveBeenCalledWith(["req-1"], { redacted: false });
  });

  it("read_storage 返回 Cookie 和 Web Storage 原文", async () => {
    const evaluate = vi.fn(async (_params: Record<string, unknown>) => ({
      result: {
        value: {
          cookie: "sid=secret",
          localStorage: { token: "local-token" },
          sessionStorage: { password: "123456" },
        },
      },
    }));
    const executor = createExecutor({ evaluate });

    const result = await executor.execute(createToolCall("full_access_read_storage"));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("sid=secret");
    expect(result.content).toContain("local-token");
    expect(result.content).toContain("123456");
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      expression: expect.stringContaining("document.cookie"),
      returnByValue: true,
    }));
  });

  it("revoke 会撤销完全访问运行态", async () => {
    const revoke = vi.fn();
    const executor = createExecutor({ revoke });

    const result = await executor.execute(createToolCall("full_access_revoke"));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("完全访问模式已撤销");
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("execute_script 参数无效时返回错误", async () => {
    const executor = createExecutor();

    await expect(executor.execute(createToolCall("full_access_execute_script", { script: "" }))).resolves.toMatchObject({
      isError: true,
    });
  });

  it("fetch 在 headers 非对象或多余参数时返回错误", async () => {
    const executor = createExecutor();

    await expect(executor.execute(createToolCall("full_access_fetch", { url: "/api", headers: "bad", extra: true }))).resolves.toMatchObject({
      isError: true,
    });
  });

  it("read_storage 拒绝额外参数", async () => {
    const executor = createExecutor();

    await expect(executor.execute(createToolCall("full_access_read_storage", { extra: true }))).resolves.toMatchObject({
      isError: true,
    });
  });

  it("revoke 拒绝额外参数", async () => {
    const revoke = vi.fn();
    const executor = createExecutor({ revoke });

    await expect(executor.execute(createToolCall("full_access_revoke", { extra: true }))).resolves.toMatchObject({
      isError: true,
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("get_network_details 拒绝过多 requestIds", async () => {
    const getDetails = vi.fn(async () => [] as NetworkRequestDetail[]);
    const executor = createExecutor({ getDetails });
    const requestIds = Array.from({ length: 101 }, (_, index) => `req-${index}`);

    await expect(executor.execute(createToolCall("full_access_get_network_details", { requestIds }))).resolves.toMatchObject({
      isError: true,
    });
    expect(getDetails).not.toHaveBeenCalled();
  });

  it("未知工具名返回错误", async () => {
    const executor = createExecutor();

    await expect(executor.execute(createToolCall("full_access_unknown"))).resolves.toMatchObject({
      isError: true,
    });
  });

  it("recorder 未启用时 canExpose 返回 false", () => {
    const executor = new FullAccessToolExecutor(
      { evaluate: vi.fn() },
      { isEnabled: false, getDetails: vi.fn() },
      () => ({ tabId: 7, origin: "https://example.com", fullAccess: true }),
      vi.fn(),
    );

    expect(executor.canExpose()).toBe(false);
  });
});

function createExecutor(overrides: {
  evaluate?: EvaluateMock;
  getDetails?: GetDetailsMock;
  revoke?: RevokeMock;
} = {}): FullAccessToolExecutor {
  return new FullAccessToolExecutor(
    { evaluate: overrides.evaluate ?? vi.fn(async (_params: Record<string, unknown>) => ({ result: { value: true } })) },
    { isEnabled: true, getDetails: overrides.getDetails ?? vi.fn(async (_requestIds: string[], _options?: { redacted?: boolean }) => [] as NetworkRequestDetail[]) },
    () => ({ tabId: 7, origin: "https://example.com", fullAccess: true }),
    overrides.revoke ?? vi.fn(),
  );
}
