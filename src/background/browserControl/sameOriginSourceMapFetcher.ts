import { truncateText } from "../../shared/utils/text";

export type SameOriginSourceMapFetchResult =
  | { ok: true; url: string; content: string; mimeType?: string; fetchedAt: number }
  | { ok: false; url: string; message: string };

const MAX_SOURCE_MAP_FETCH_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 8000;
const TRUSTED_SOURCE_MAP_MIME_TYPES = new Set([
  "application/json",
  "application/source-map",
]);
const TEXT_MIME_TYPES = new Set(["text/plain", "text/json"]);

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
        return { ok: false, url: urlResult.url, message: "Source Map 读取失败。" };
      }
      const mimeType = response.headers.get("content-type") ?? undefined;
      if (!isTrustedSourceMapMime(mimeType, urlResult.url)) {
        return { ok: false, url: urlResult.url, message: "Source Map 只接受 JSON 或 map 文本资源。" };
      }
      if (isContentLengthTooLarge(response.headers.get("content-length"))) {
        return { ok: false, url: urlResult.url, message: "Source Map 响应超过大小上限。" };
      }

      const content = await readTextWithLimit(response, MAX_SOURCE_MAP_FETCH_BYTES);
      if (content.truncated) {
        return { ok: false, url: urlResult.url, message: "Source Map 响应超过大小上限。" };
      }

      return { ok: true, url: finalUrl, content: content.text, mimeType, fetchedAt: Date.now() };
    } catch {
      return { ok: false, url: urlResult.url, message: "Source Map 读取失败。" };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

function normalizeSameOriginSourceMapUrl(url: string, pageUrl: string): { ok: true; url: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(url, pageUrl);
  } catch {
    return { ok: false, message: "Source Map URL 格式无效。" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "Source Map 只允许 http 或 https URL。" };
  }

  if (!isSameOrigin(parsed.toString(), pageUrl)) {
    return { ok: false, message: "Source Map 只允许读取当前页面同源资源。" };
  }

  return { ok: true, url: parsed.toString() };
}

function isSameOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.protocol === rightUrl.protocol && leftUrl.hostname === rightUrl.hostname && leftUrl.port === rightUrl.port;
  } catch {
    return false;
  }
}

function isTrustedSourceMapMime(mimeType: string | undefined, url: string): boolean {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (TRUSTED_SOURCE_MAP_MIME_TYPES.has(normalized)) {
    return true;
  }
  // 只把明确 .map 路径上的文本响应视为可信，避免把任意二进制或脚本文本误当成 Source Map。
  if (TEXT_MIME_TYPES.has(normalized) || !normalized) {
    return /\.map$/i.test(getUrlPathname(url));
  }
  return false;
}

function getUrlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? "";
  }
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
    return { text: truncateText(text, maxBytes).text, truncated: text.length > maxBytes };
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
