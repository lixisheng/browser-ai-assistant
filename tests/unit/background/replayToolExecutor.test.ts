import { describe, expect, it, vi } from "vitest";
import { ReplayToolExecutor } from "../../../src/background/browserControl/replayToolExecutor";
import type { ModelToolCall } from "../../../src/shared/models/types";
import type { NetworkRequestDetail, NetworkRequestMeta } from "../../../src/shared/types";
import type { BoundaryGrantContext } from "../../../src/shared/toolAuthorization";
import { createBoundaryGrantScopeKey } from "../../../src/shared/toolAuthorization";

function createToolCall(name: string, argumentsValue: Record<string, unknown>): ModelToolCall {
  return {
    id: `call-${name}`,
    name,
    arguments: argumentsValue,
  };
}

function createMeta(overrides: Partial<NetworkRequestMeta> = {}): NetworkRequestMeta {
  return {
    id: "req-1",
    url: "https://example.com/api/items?page=1",
    method: "GET",
    status: 200,
    requestHeaders: [{ name: "Accept", value: "application/json" }],
    ...overrides,
  };
}

function createGrant(overrides: Partial<BoundaryGrantContext> = {}): BoundaryGrantContext {
  const scopeKey = overrides.scopeKey ?? createBoundaryGrantScopeKey(createToolCall("replay_send_request", { draftId: "draft-placeholder" }));
  return {
    id: "grant-1",
    tabId: 7,
    origin: "https://example.com",
    toolCallId: "call-boundary",
    scopeKey,
    grants: ["send_single_confirmed_replay_request_without_credentials"],
    selectedChoiceIds: ["send_once"],
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
    ...overrides,
  };
}

function createExecutor(options: {
  meta?: NetworkRequestMeta;
  grant?: BoundaryGrantContext;
  getGrant?: () => BoundaryGrantContext | undefined;
  fetcher?: typeof fetch;
  origin?: string;
  enabled?: boolean;
} = {}): ReplayToolExecutor {
  const meta = options.meta ?? createMeta();
  const recorder = {
    isEnabled: options.enabled ?? true,
    getRawRequestMeta: vi.fn((requestId: string) => (requestId === meta.id ? meta : undefined)),
    getDetails: vi.fn(async (): Promise<NetworkRequestDetail[]> => [{
      ...meta,
      responseBody: "{\"ok\":true}",
      truncated: false,
      redacted: false,
    }]),
  };
  const fetcher = options.fetcher ?? vi.fn(async () => new Response("{\"ok\":true}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  return new ReplayToolExecutor(
    recorder,
    fetcher,
    () => ({ tabId: 7, origin: options.origin ?? "https://example.com", enhanced: true, grant: options.getGrant?.() ?? options.grant }),
  );
}

async function prepareDraft(executor: ReplayToolExecutor): Promise<string> {
  const result = await executor.execute(createToolCall("replay_prepare_request", { requestId: "req-1" }));
  expect(result.isError).toBeUndefined();
  const match = result.content.match(/draftId：(\S+)/);
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

describe("请求重放沙箱执行器", () => {
  it("prepare 只生成草案且未确认时不能发送", async () => {
    const fetcher = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const executor = createExecutor({ fetcher });

    const draftId = await prepareDraft(executor);
    const sendResult = await executor.execute(createToolCall("replay_send_request", { draftId }));

    expect(sendResult).toMatchObject({
      isError: true,
      content: "发送请求重放前必须先通过用户边界确认。",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("拒绝危险 method、敏感 header 和跨当前 origin 目标", async () => {
    await expect(createExecutor({ meta: createMeta({ method: "DELETE" }) }).execute(createToolCall("replay_prepare_request", { requestId: "req-1" }))).resolves.toMatchObject({
      isError: true,
      content: "请求重放沙箱 v1 只允许 GET、HEAD 和受限 POST。",
    });
    await expect(createExecutor({ meta: createMeta({ requestHeaders: [{ name: "Authorization", value: "Bearer secret" }] }) }).execute(createToolCall("replay_prepare_request", { requestId: "req-1" }))).resolves.toMatchObject({
      isError: true,
      content: "请求包含敏感 Header，受控增强模式下拒绝重放。",
    });
    await expect(createExecutor({ meta: createMeta({ url: "https://other.example/api" }) }).execute(createToolCall("replay_prepare_request", { requestId: "req-1" }))).resolves.toMatchObject({
      isError: true,
      content: "请求重放 v1 只允许当前受控页面同源目标。",
    });
    await expect(createExecutor({ meta: createMeta({ requestHeaders: [{ name: "x-api-key", value: "secret" }] }) }).execute(createToolCall("replay_prepare_request", { requestId: "req-1" }))).resolves.toMatchObject({
      isError: true,
      content: "请求包含敏感 Header，受控增强模式下拒绝重放。",
    });
    await expect(createExecutor({ meta: createMeta({ url: "https://example.com/api?token=secret" }) }).execute(createToolCall("replay_prepare_request", { requestId: "req-1" }))).resolves.toMatchObject({
      isError: true,
      content: "请求重放沙箱拒绝包含敏感 query 字段的请求。",
    });
    await expect(createExecutor({
      meta: createMeta({
        method: "POST",
        requestHeaders: [{ name: "Content-Type", value: "application/json" }],
        requestBody: "{\"password\":\"123456\"}",
      }),
    }).execute(createToolCall("replay_prepare_request", { requestId: "req-1" }))).resolves.toMatchObject({
      isError: true,
      content: "请求重放沙箱拒绝包含敏感 body 字段的请求。",
    });
  });

  it("授权后发送请求必须由 background fetch 且不携带凭据", async () => {
    const fetcher = vi.fn(async () => new Response("{\"token\":\"secret\",\"ok\":true}", {
      status: 200,
      headers: { "content-type": "application/json", "x-trace-id": "abc" },
    })) as unknown as typeof fetch;
    let grant: BoundaryGrantContext | undefined;
    const executor = createExecutor({ fetcher, getGrant: () => grant });

    const draftId = await prepareDraft(executor);
    grant = createGrant({ scopeKey: createBoundaryGrantScopeKey(createToolCall("replay_send_request", { draftId })) });
    const sendResult = await executor.execute(createToolCall("replay_send_request", { draftId }));

    expect(sendResult.isError).toBeUndefined();
    expect(sendResult.content).toContain("请求重放已完成");
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com/api/items?page=1",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "manual",
      }),
    );
    expect(sendResult.content).not.toContain("secret");
  });

  it("发送时保留重复 Header 且只跟随一次同源重定向", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      if (String(url).endsWith("/api/items?page=1")) {
        expect(headers.get("x-repeat")).toBe("one, two");
        return new Response(null, {
          status: 302,
          headers: { location: "/api/redirected" },
        });
      }
      return new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    let grant: BoundaryGrantContext | undefined;
    const executor = createExecutor({
      fetcher,
      getGrant: () => grant,
      meta: createMeta({
        requestHeaders: [
          { name: "x-repeat", value: "one" },
          { name: "x-repeat", value: "two" },
        ],
      }),
    });

    const draftId = await prepareDraft(executor);
    grant = createGrant({ scopeKey: createBoundaryGrantScopeKey(createToolCall("replay_send_request", { draftId })) });
    const sendResult = await executor.execute(createToolCall("replay_send_request", { draftId }));

    expect(sendResult.isError).toBeUndefined();
    expect(sendResult.content).toContain("- 重定向：是");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith("https://example.com/api/redirected", expect.objectContaining({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    }));
  });
});
