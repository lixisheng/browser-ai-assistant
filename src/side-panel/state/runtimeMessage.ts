export async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return {
      ok: false,
      message: "当前环境不支持插件后台请求",
    } as T;
  }

  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (response: T) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(response);
    };

    try {
      // 兼容 Chrome 回调形态与测试环境中的 Promise 形态，避免不同运行时丢失 lastError。
      const maybePromise = globalThis.chrome.runtime.sendMessage(message, (response: T) => {
        const runtimeError = globalThis.chrome?.runtime?.lastError?.message;
        if (runtimeError) {
          finish({
            ok: false,
            message: runtimeError,
          } as T);
          return;
        }

        finish(response);
      }) as Promise<T> | undefined;

      if (maybePromise && typeof maybePromise.then === "function") {
        void maybePromise.then(finish).catch((error) => {
          finish({
            ok: false,
            message: error instanceof Error ? error.message : "插件后台请求失败",
          } as T);
        });
      }
    } catch (error) {
      finish({
        ok: false,
        message: error instanceof Error ? error.message : "插件后台请求失败",
      } as T);
    }
  });
}
