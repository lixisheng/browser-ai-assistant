export const MAX_SOURCE_MAP_FETCH_BYTES = 1_000_000;

const TRUSTED_SOURCE_MAP_MIME_TYPES = new Set([
  "application/json",
  "application/source-map",
]);
const TEXT_SOURCE_MAP_MIME_TYPES = new Set(["text/plain", "text/json"]);

export function normalizeSameOriginSourceMapUrl(url: string, pageUrl: string): { ok: true; url: string } | { ok: false; message: string } {
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

export function isSameOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.protocol === rightUrl.protocol && leftUrl.hostname === rightUrl.hostname && leftUrl.port === rightUrl.port;
  } catch {
    return false;
  }
}

export function isTrustedSourceMapMime(mimeType: string | undefined, url: string): boolean {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (TRUSTED_SOURCE_MAP_MIME_TYPES.has(normalized)) {
    return true;
  }
  // 只把明确 .map 路径上的文本响应视为可信，避免把任意二进制或脚本文本误当成 Source Map。
  if (TEXT_SOURCE_MAP_MIME_TYPES.has(normalized) || !normalized) {
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
