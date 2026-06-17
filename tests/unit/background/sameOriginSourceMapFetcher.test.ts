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
});
