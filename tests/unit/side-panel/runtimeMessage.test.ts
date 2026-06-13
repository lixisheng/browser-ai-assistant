import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRuntimeMessage } from "../../../src/side-panel/state/runtimeMessage";

describe("sendRuntimeMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("当前环境不支持插件后台请求时返回中文错误", async () => {
    vi.stubGlobal("chrome", undefined);

    await expect(sendRuntimeMessage<{ ok: false; message: string }>({ type: "demo" })).resolves.toEqual({
      ok: false,
      message: "当前环境不支持插件后台请求",
    });
  });

  it("Promise 形态 sendMessage 拒绝且没有 Error 消息时返回中文兜底", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(() => Promise.reject("failed")),
      },
    });

    await expect(sendRuntimeMessage<{ ok: false; message: string }>({ type: "demo" })).resolves.toEqual({
      ok: false,
      message: "插件后台请求失败",
    });
  });

  it("callback 形态 sendMessage 抛出非 Error 异常时返回中文兜底", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(() => {
          throw "failed";
        }),
      },
    });

    await expect(sendRuntimeMessage<{ ok: false; message: string }>({ type: "demo" })).resolves.toEqual({
      ok: false,
      message: "插件后台请求失败",
    });
  });
});
