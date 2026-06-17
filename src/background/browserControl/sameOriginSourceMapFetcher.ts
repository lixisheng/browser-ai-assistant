import { truncateText } from "../../shared/utils/text";
import {
  MAX_SOURCE_MAP_FETCH_BYTES,
  isSameOrigin,
  isTrustedSourceMapMime,
  normalizeSameOriginSourceMapUrl,
} from "./sourceMapFetchGuards";

export type SameOriginSourceMapFetchResult =
  | { ok: true; url: string; content: string; mimeType?: string; fetchedAt: number }
  | { ok: false; url: string; message: string };

const DEFAULT_TIMEOUT_MS = 8000;

export class SameOriginSourceMapFetcher {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async fetch(url: string, pageUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SameOriginSourceMapFetchResult> {
    const urlResult = normalizeSameOriginSourceMapUrl(url, pageUrl);
    if (!urlResult.ok) {
      return { ok: false, url, message: urlResult.message };
    }

    // MV3 支持 AbortController；测试环境缺失时退化为无主动取消。
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : undefined;
    try {
      const response = await this.fetcher(urlResult.url, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: controller?.signal,
      });
      const finalUrl = response.url || urlResult.url;
      if (isRedirectResponse(response) || !isSameOrigin(finalUrl, pageUrl)) {
        return { ok: false, url: urlResult.url, message: "Source Map 读取拒绝跨域重定向。" };
      }
      if (!response.ok) {
        return { ok: false, url: urlResult.url, message: `Source Map 读取失败，HTTP 状态码 ${response.status}。` };
      }
      const mimeType = response.headers.get("content-type") ?? undefined;
      if (!isTrustedSourceMapMime(mimeType, urlResult.url)) {
        return { ok: false, url: urlResult.url, message: "Source Map 只接受 JSON 或 map 文本资源。" };
      }
      if (isContentLengthTooLarge(response.headers.get("content-length"))) {
        return { ok: false, url: urlResult.url, message: "Source Map 响应超过大小上限。" };
      }

      const content = await readResponseText(response, MAX_SOURCE_MAP_FETCH_BYTES);
      if (content.truncated) {
        return { ok: false, url: urlResult.url, message: "Source Map 响应超过大小上限。" };
      }

      return { ok: true, url: finalUrl, content: content.text, mimeType, fetchedAt: Date.now() };
    } catch (error) {
      return { ok: false, url: urlResult.url, message: normalizeFetchFailureMessage(error) };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  try {
    return await readTextWithLimit(response, maxBytes);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new SourceMapBodyReadError();
  }
}

class SourceMapBodyReadError extends Error {
  constructor() {
    super("Source Map response body read failed");
    this.name = "SourceMapBodyReadError";
  }
}

function normalizeFetchFailureMessage(error: unknown): string {
  if (isAbortError(error)) {
    return "Source Map 读取超时。";
  }
  const name = getErrorName(error);
  if (name === "SourceMapBodyReadError") {
    return "Source Map 响应体读取失败。";
  }
  if (error instanceof TypeError) {
    return "Source Map 请求被浏览器拒绝。";
  }
  return "Source Map 读取失败。";
}

function isAbortError(error: unknown): boolean {
  return getErrorName(error) === "AbortError";
}

function getErrorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name?: unknown }).name) : "";
}

function isRedirectResponse(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

function isContentLengthTooLarge(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const size = Number(value);
  return Number.isFinite(size) && size > MAX_SOURCE_MAP_FETCH_BYTES;
}

async function readTextWithLimit(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body?.getReader) {
    const text = await response.text();
    return { text: truncateText(text, maxBytes).text, truncated: getUtf8ByteLength(text) > maxBytes };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          return { text: chunks.join(""), truncated: true };
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), truncated: false };
  } finally {
    reader.releaseLock();
  }
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
