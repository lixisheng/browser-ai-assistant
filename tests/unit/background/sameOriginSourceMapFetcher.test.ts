import { describe, expect, it, vi } from "vitest";
import { SameOriginSourceMapFetcher } from "../../../src/background/browserControl/sameOriginSourceMapFetcher";

function createResponse(input: {
  ok?: boolean;
  status?: number;
  url?: string;
  contentType?: string;
  contentLength?: string;
  body?: string;
  type?: ResponseType;
}): Response {
  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    url: input.url ?? "https://example.com/app.js.map",
    type: input.type ?? "basic",
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "content-type") {
          return input.contentType ?? "application/json";
        }
        if (name.toLowerCase() === "content-length") {
          return input.contentLength ?? null;
        }
        return null;
      },
    },
    text: async () => input.body ?? "{\"version\":3}",
  } as Response;
}

function createStreamResponse(input: {
  headers?: HeadersInit;
  body?: string;
  streamError?: Error;
  textError?: Error;
}): Response {
  const body = input.streamError
    ? new ReadableStream({
      pull() {
        throw input.streamError;
      },
    })
    : input.body ?? "{\"version\":3}";
  const response = new Response(body, {
    status: 200,
    headers: input.headers ?? {
      "Content-Type": "application/json",
    },
  });
  if (input.textError) {
    Object.defineProperty(response, "body", { value: undefined });
    response.text = vi.fn(async () => {
      throw input.textError;
    }) as unknown as typeof response.text;
  }
  Object.defineProperty(response, "url", { value: "https://example.com/app.js.map" });
  return response;
}

describe("同源 Source Map 读取器", () => {
  it("按同源规则读取 map 且不携带凭据", async () => {
    const fetcherMock = vi.fn(async () => createResponse({ body: "{\"version\":3}" }));
    const fetcher = new SameOriginSourceMapFetcher(fetcherMock as unknown as typeof fetch);

    const result = await fetcher.fetch("/app.js.map", "https://example.com/page");

    expect(result).toMatchObject({ ok: true, url: "https://example.com/app.js.map", content: "{\"version\":3}" });
    expect(fetcherMock).toHaveBeenCalledWith("https://example.com/app.js.map", expect.objectContaining({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
    }));
  });

  it("接受浏览器已自动解压的 gzip Source Map 响应", async () => {
    // Fetch 暴露给调用方的是浏览器已解码后的文本流，这里只验证 gzip 响应头不会触发误拒。
    const fetcherMock = vi.fn(async () => createStreamResponse({
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
      },
      body: "{\"version\":3,\"file\":\"app.js\",\"sources\":[],\"names\":[],\"mappings\":\"\"}",
    }));
    const fetcher = new SameOriginSourceMapFetcher(fetcherMock as unknown as typeof fetch);

    await expect(fetcher.fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("\"version\":3"),
    });
  });

  it("拒绝跨域 URL 和跨域重定向", async () => {
    const fetcher = new SameOriginSourceMapFetcher(vi.fn(async () => createResponse({ url: "https://cdn.example.net/app.js.map" })) as unknown as typeof fetch);

    await expect(fetcher.fetch("https://evil.example/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 只允许读取当前页面同源资源。",
    });
    await expect(fetcher.fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 读取拒绝跨域重定向。",
    });
  });

  it("拒绝非法 MIME 和超大小响应", async () => {
    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createResponse({ contentType: "image/png" })) as unknown as typeof fetch)
      .fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 只接受 JSON 或 map 文本资源。",
    });
    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createResponse({ contentLength: "1000001" })) as unknown as typeof fetch)
      .fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 响应超过大小上限。",
    });
  });

  it("只允许 .map 路径上的文本响应，不接受 octet-stream 或普通脚本文本", async () => {
    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createResponse({ contentType: "text/plain" })) as unknown as typeof fetch)
      .fetch("/app.js", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 只接受 JSON 或 map 文本资源。",
    });
    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createResponse({ contentType: "application/octet-stream" })) as unknown as typeof fetch)
      .fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 只接受 JSON 或 map 文本资源。",
    });
  });

  it("区分请求失败、超时、状态码失败和响应体读取失败", async () => {
    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch).fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 请求被浏览器拒绝。",
    });

    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch).fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 读取超时。",
    });

    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createResponse({ ok: false, status: 404 })) as unknown as typeof fetch)
      .fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 读取失败，HTTP 状态码 404。",
    });

    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createStreamResponse({
      textError: new Error("body locked"),
    })) as unknown as typeof fetch).fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 响应体读取失败。",
    });
  });

  it("流式响应体读取阶段超时时仍返回超时摘要", async () => {
    await expect(new SameOriginSourceMapFetcher(vi.fn(async () => createStreamResponse({
      streamError: new DOMException("The operation was aborted.", "AbortError"),
    })) as unknown as typeof fetch).fetch("/app.js.map", "https://example.com/page")).resolves.toMatchObject({
      ok: false,
      message: "Source Map 读取超时。",
    });
  });
});
