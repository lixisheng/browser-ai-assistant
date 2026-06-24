import { AnyMap, TraceMap, isIgnored, originalPositionFor, sourceContentFor } from "@jridgewell/trace-mapping";
import {
  SOURCEMAP_EXTRACT_ORIGINAL_CONTEXT_TOOL_ID,
  SOURCEMAP_EXTRACT_ORIGINAL_CONTEXT_TOOL_NAME,
  SOURCEMAP_LIST_CANDIDATES_TOOL_ID,
  SOURCEMAP_LIST_CANDIDATES_TOOL_NAME,
  SOURCEMAP_RESOLVE_LOCATION_TOOL_ID,
  SOURCEMAP_RESOLVE_LOCATION_TOOL_NAME,
} from "../../shared/models/toolRegistry";
import type { ModelToolCall, ModelToolResult } from "../../shared/models/types";
import type { BoundaryGrantContext } from "../../shared/toolAuthorization";
import type {
  ChatSourceMapToolAttachment,
  NetworkRequestDetail,
  NetworkRequestMeta,
  SourceMapCandidate,
  SourceMapOriginalContext,
  SourceMapResolvedLocation,
} from "../../shared/types";
import { truncateText } from "../../shared/utils/text";
import type { IndexedJsSourceSnapshot, JsSourceIndex } from "./jsSourceIndex";
import { isJavaScriptDetail, isJavaScriptMetaLike, redactJsSourceSnippet } from "./jsSourceIndex";
import type { NetworkRequestFilter } from "./networkRecorder";
import { SameOriginSourceMapFetcher } from "./sameOriginSourceMapFetcher";
import { MAX_SOURCE_MAP_FETCH_BYTES, isTrustedSourceMapMime, normalizeSameOriginSourceMapUrl } from "./sourceMapFetchGuards";

type SourceMapToolName =
  | typeof SOURCEMAP_LIST_CANDIDATES_TOOL_ID
  | typeof SOURCEMAP_LIST_CANDIDATES_TOOL_NAME
  | typeof SOURCEMAP_RESOLVE_LOCATION_TOOL_ID
  | typeof SOURCEMAP_RESOLVE_LOCATION_TOOL_NAME
  | typeof SOURCEMAP_EXTRACT_ORIGINAL_CONTEXT_TOOL_ID
  | typeof SOURCEMAP_EXTRACT_ORIGINAL_CONTEXT_TOOL_NAME;

interface SourceMapRecorderLike {
  isEnabled: boolean | (() => boolean);
  listRequests(filter?: NetworkRequestFilter): NetworkRequestMeta[];
  getDetails(requestIds: string[]): Promise<NetworkRequestDetail[]>;
}

export interface SourceMapToolExecutorOptions {
  recorder: SourceMapRecorderLike;
  jsSourceIndex: JsSourceIndex;
  getCurrentPageUrl: () => Promise<string>;
  fetcher?: Pick<SameOriginSourceMapFetcher, "fetch">;
  getBoundaryGrant?: () => BoundaryGrantContext | undefined;
}

interface SourceMapCandidateInternal extends SourceMapCandidate {
  mapContent?: string;
  mapUrl?: string;
}

interface ParsedSourceMap {
  candidate: SourceMapCandidateInternal;
  map: TraceMap;
}

type SourceMapInputLike = ConstructorParameters<typeof TraceMap>[0];
type SectionedSourceMapInputLike = ConstructorParameters<typeof AnyMap>[0];

const SOURCE_MAP_DISABLED_MESSAGE = "Source Map 解析依赖 Network 采集，请先开启浏览器控制。";
const RESOURCE_ID_INVALID_MESSAGE = "resourceId 必须是非空字符串。";
const LOCATION_INVALID_MESSAGE = "line 和 column 必须是大于等于 1 的有限数字。";
const MAX_RESOURCE_IDS = 100;
const MAX_RESOURCE_ID_LENGTH = 256;
const MAX_CANDIDATES = 100;
const DEFAULT_CONTEXT_RADIUS = 600;
const MAX_CONTEXT_LENGTH = 1800;
const MAX_INLINE_SOURCE_MAP_BYTES = 1_000_000;
const SOURCE_MAPPING_URL_PATTERN = /\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/gm;
const SOURCE_MAP_TOOL_NAMES = new Set<string>([
  SOURCEMAP_LIST_CANDIDATES_TOOL_ID,
  SOURCEMAP_LIST_CANDIDATES_TOOL_NAME,
  SOURCEMAP_RESOLVE_LOCATION_TOOL_ID,
  SOURCEMAP_RESOLVE_LOCATION_TOOL_NAME,
  SOURCEMAP_EXTRACT_ORIGINAL_CONTEXT_TOOL_ID,
  SOURCEMAP_EXTRACT_ORIGINAL_CONTEXT_TOOL_NAME,
]);

export class SourceMapToolExecutor {
  private readonly parsedMapsByResourceId = new Map<string, ParsedSourceMap>();
  private readonly fetcher: Pick<SameOriginSourceMapFetcher, "fetch">;
  private lastListedRequests: NetworkRequestMeta[] = [];

  constructor(private readonly options: SourceMapToolExecutorOptions) {
    this.fetcher = options.fetcher ?? new SameOriginSourceMapFetcher();
  }

  clear(): void {
    this.parsedMapsByResourceId.clear();
    this.lastListedRequests = [];
  }

  async execute(toolCall: ModelToolCall): Promise<ModelToolResult> {
    if (!this.isEnabled()) {
      return createErrorResult(toolCall, SOURCE_MAP_DISABLED_MESSAGE);
    }
    if (!SOURCE_MAP_TOOL_NAMES.has(toolCall.name)) {
      return createErrorResult(toolCall, `未知的 Source Map 工具：${toolCall.name}。`);
    }

    try {
      await this.refreshNetworkResources();
      if (isToolCallName(toolCall.name, SOURCEMAP_LIST_CANDIDATES_TOOL_ID, SOURCEMAP_LIST_CANDIDATES_TOOL_NAME)) {
        return await this.listCandidates(toolCall);
      }
      if (isToolCallName(toolCall.name, SOURCEMAP_RESOLVE_LOCATION_TOOL_ID, SOURCEMAP_RESOLVE_LOCATION_TOOL_NAME)) {
        return await this.resolveLocation(toolCall);
      }
      return await this.extractOriginalContext(toolCall);
    } catch {
      return createErrorResult(toolCall, "Source Map 工具执行失败，请稍后重试。");
    }
  }

  private async refreshNetworkResources(): Promise<void> {
    const listedRequests = this.options.recorder.listRequests({ limit: MAX_CANDIDATES });
    this.lastListedRequests = Array.isArray(listedRequests) ? listedRequests : [];
    const metas = this.lastListedRequests.filter(isJavaScriptMetaLike);
    if (metas.length === 0) {
      await this.options.recorder.getDetails([]);
      return;
    }
    const details = await this.options.recorder.getDetails(metas.slice(0, MAX_RESOURCE_IDS).map((request) => request.id));
    this.options.jsSourceIndex.upsertNetworkDetails(details.filter(isJavaScriptDetail));
  }

  private async listCandidates(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const resourceIds = normalizeOptionalStringArray(toolCall.arguments.resourceIds, MAX_RESOURCE_IDS, MAX_RESOURCE_ID_LENGTH);
    const limit = normalizeLimit(toolCall.arguments.limit, MAX_CANDIDATES);
    const allowFetch = toolCall.arguments.allowSameOriginFetch === true || this.canExpandContext();
    const resources = this.selectResources(resourceIds).slice(0, limit);
    const candidates: SourceMapCandidate[] = [];
    const failures: ChatSourceMapToolAttachment["failures"] = [];
    for (const resource of resources) {
      const loaded = await this.loadSourceMap(resource, allowFetch);
      candidates.push(...loaded.candidates.map(toPublicCandidate));
      failures.push(...loaded.failures);
    }
    const content = formatCandidateList(candidates, failures);
    return createSourceMapResult(toolCall, content, { candidates, failures, truncated: candidates.length >= limit });
  }

  private async resolveLocation(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const validation = validateLocationArguments(toolCall.arguments);
    if (!validation.ok) {
      return createErrorResult(toolCall, validation.message);
    }
    const resource = this.options.jsSourceIndex.getResourceSnapshot(validation.resourceId);
    if (!resource) {
      return createSourceMapResult(toolCall, "未找到指定 JS 资源。", { failures: [{ resourceId: validation.resourceId, message: "未找到指定 JS 资源。" }] });
    }
    const loaded = await this.loadSourceMap(resource, validation.allowSameOriginFetch || this.canExpandContext());
    const resolved = loaded.parsed ? resolveGeneratedLocation(resource, loaded.parsed.map, validation.line, validation.column) : createUnresolvedLocation(resource, validation.line, validation.column, firstFailureMessage(loaded));
    return createSourceMapResult(toolCall, formatResolvedLocations([resolved]), {
      candidates: loaded.candidates.map(toPublicCandidate),
      resolvedLocations: [resolved],
      failures: loaded.failures,
    });
  }

  private async extractOriginalContext(toolCall: ModelToolCall): Promise<ModelToolResult> {
    const validation = validateLocationArguments(toolCall.arguments);
    if (!validation.ok) {
      return createErrorResult(toolCall, validation.message);
    }
    const resource = this.options.jsSourceIndex.getResourceSnapshot(validation.resourceId);
    if (!resource) {
      return createSourceMapResult(toolCall, "未找到指定 JS 资源。", { failures: [{ resourceId: validation.resourceId, message: "未找到指定 JS 资源。" }] });
    }
    const loaded = await this.loadSourceMap(resource, validation.allowSameOriginFetch || this.canExpandContext());
    const radius = normalizeRadius(toolCall.arguments.radius);
    const context = loaded.parsed
      ? extractOriginalContextFromMap(resource, loaded.parsed.map, validation.line, validation.column, radius)
      : createOriginalContextFailure(resource, validation.line, validation.column, firstFailureMessage(loaded));
    return createSourceMapResult(toolCall, formatOriginalContexts([context]), {
      candidates: loaded.candidates.map(toPublicCandidate),
      resolvedLocations: [stripContextSnippet(context)],
      originalContexts: [context],
      failures: loaded.failures,
      truncated: context.truncated,
    });
  }

  private async loadSourceMap(resource: IndexedJsSourceSnapshot, allowSameOriginFetch: boolean): Promise<{ candidates: SourceMapCandidateInternal[]; parsed?: ParsedSourceMap; failures: ChatSourceMapToolAttachment["failures"] }> {
    const cached = this.parsedMapsByResourceId.get(resource.id);
    const discovered = discoverSourceMapCandidates(resource);
    const failures: ChatSourceMapToolAttachment["failures"] = [];
    if (cached) {
      return {
        candidates: discovered.map((candidate) => candidateMatchesParsed(candidate, cached.candidate) ? { ...candidate, status: "available", parsed: true } : candidate),
        parsed: cached,
        failures,
      };
    }

    const candidates: SourceMapCandidateInternal[] = [];
    for (const candidate of discovered) {
      const loaded = await this.loadCandidate(resource, candidate, allowSameOriginFetch);
      candidates.push(loaded.candidate);
      if (loaded.failure) {
        failures.push(loaded.failure);
      }
      if (loaded.content) {
        const parsed = parseSourceMap(resource, loaded.candidate, loaded.content);
        candidates[candidates.length - 1] = parsed.candidate;
        if (parsed.map) {
          const parsedMap = { candidate: parsed.candidate, map: parsed.map };
          this.parsedMapsByResourceId.set(resource.id, parsedMap);
          return { candidates, parsed: parsedMap, failures };
        }
        failures.push({ resourceId: resource.id, url: loaded.candidate.url, message: parsed.candidate.message ?? "Source Map 解析失败。" });
      }
    }
    if (candidates.length === 0) {
      failures.push({ resourceId: resource.id, message: "未发现 Source Map 候选。" });
    }
    return { candidates, failures };
  }

  private async loadCandidate(
    resource: IndexedJsSourceSnapshot,
    candidate: SourceMapCandidateInternal,
    allowSameOriginFetch: boolean,
  ): Promise<{ candidate: SourceMapCandidateInternal; content?: string; failure?: ChatSourceMapToolAttachment["failures"][number] }> {
    if (candidate.mapContent) {
      return { candidate: { ...candidate, status: "available" }, content: candidate.mapContent };
    }
    if (!candidate.url) {
      return { candidate: { ...candidate, status: "failed", message: "Source Map 候选缺少 URL。" }, failure: { resourceId: resource.id, message: "Source Map 候选缺少 URL。" } };
    }
    if (!allowSameOriginFetch) {
      const fetchMessage = "需要 allowSameOriginFetch=true 才会读取同源 Source Map。";
      return { candidate: { ...candidate, status: "fetchable", message: candidate.message ? `${candidate.message} ${fetchMessage}` : fetchMessage } };
    }
    const pageUrl = await this.options.getCurrentPageUrl();
    const fetched = await this.fetcher.fetch(candidate.url, pageUrl);
    if (!fetched.ok) {
      const cached = await this.loadCachedSourceMapCandidate(candidate, pageUrl);
      if (cached.ok) {
        return {
          candidate: {
            ...candidate,
            url: cached.url,
            status: "available",
            mapUrl: cached.url,
            message: `主动读取失败：${fetched.message} 已复用 Network 已采集的同源 Source Map 响应。`,
          },
          content: cached.content,
        };
      }
      return {
        candidate: { ...candidate, status: "failed", message: fetched.message },
        failure: { resourceId: resource.id, url: fetched.url, message: fetched.message },
      };
    }
    return { candidate: { ...candidate, url: fetched.url, status: "available", mapUrl: fetched.url }, content: fetched.content };
  }

  private async loadCachedSourceMapCandidate(
    candidate: SourceMapCandidateInternal,
    pageUrl: string,
  ): Promise<{ ok: true; url: string; content: string } | { ok: false }> {
    if (!candidate.url) {
      return { ok: false };
    }
    const candidateUrl = candidate.url;
    const matchingIds = this.lastListedRequests.filter((meta) => isSameSourceMapUrl(meta.url, candidateUrl, pageUrl)).map((meta) => meta.id);
    if (matchingIds.length === 0) {
      return { ok: false };
    }

    const details = await this.options.recorder.getDetails(matchingIds.slice(0, MAX_RESOURCE_IDS));
    for (const detail of details) {
      const content = validateCachedSourceMapDetail(detail, candidateUrl, pageUrl);
      if (content) {
        return { ok: true, url: detail.url, content };
      }
    }
    return { ok: false };
  }

  private selectResources(resourceIds: string[]): IndexedJsSourceSnapshot[] {
    const resources = this.options.jsSourceIndex.listResourceSnapshots();
    if (resourceIds.length === 0) {
      return resources;
    }
    const allowedIds = new Set(resourceIds);
    return resources.filter((resource) => allowedIds.has(resource.id));
  }

  private isEnabled(): boolean {
    return typeof this.options.recorder.isEnabled === "function" ? this.options.recorder.isEnabled() : this.options.recorder.isEnabled;
  }

  private canExpandContext(): boolean {
    return Boolean(this.options.getBoundaryGrant?.()?.grants.includes("expand_js_or_sourcemap_context"));
  }
}

function discoverSourceMapCandidates(resource: IndexedJsSourceSnapshot): SourceMapCandidateInternal[] {
  const header = findHeader(resource.responseHeaders, "sourcemap");
  if (header) {
    return [createExternalCandidate(resource, "response-header", header)];
  }
  const legacyHeader = findHeader(resource.responseHeaders, "x-sourcemap") ?? findHeader(resource.responseHeaders, "x-source-map");
  if (legacyHeader) {
    return [createExternalCandidate(resource, "x-source-map-header", legacyHeader)];
  }

  const matches = Array.from(resource.content.matchAll(SOURCE_MAPPING_URL_PATTERN));
  // 浏览器只会采纳最后一个 sourceMappingURL 注释，这里也保持同样口径，避免把旧注释误当成最终候选。
  const lastMatch = matches.at(-1);
  if (!lastMatch?.[1]) {
    return [];
  }
  const value = lastMatch[1].trim();
  const truncatedMessage = resource.truncated ? "JS 资源已截断，sourceMappingURL 可能不准确。" : undefined;
  if (value.startsWith("data:")) {
    return [decodeInlineSourceMapCandidate(resource, value, truncatedMessage)];
  }
  return [createExternalCandidate(resource, "source-mapping-url", value, truncatedMessage)];
}

function createExternalCandidate(resource: IndexedJsSourceSnapshot, source: SourceMapCandidate["source"], rawUrl: string, message?: string): SourceMapCandidateInternal {
  try {
    const url = new URL(rawUrl, resource.url).toString();
    return {
      resourceId: resource.id,
      resourceUrl: resource.url,
      source,
      url,
      inline: false,
      status: "fetchable",
      parsed: false,
      message,
    };
  } catch {
    return {
      resourceId: resource.id,
      resourceUrl: resource.url,
      source,
      inline: false,
      status: "failed",
      parsed: false,
      message: "Source Map URL 格式无效。",
    };
  }
}

function validateCachedSourceMapDetail(detail: NetworkRequestDetail, candidateUrl: string, pageUrl: string): string | undefined {
  if (!isSameSourceMapUrl(detail.url, candidateUrl, pageUrl)) {
    return undefined;
  }
  if (detail.failed === true || typeof detail.status !== "number" || detail.status < 200 || detail.status >= 300) {
    return undefined;
  }
  if (detail.truncated || typeof detail.responseBody !== "string" || getUtf8ByteLength(detail.responseBody) > MAX_SOURCE_MAP_FETCH_BYTES) {
    return undefined;
  }
  const mimeType = findHeader(detail.responseHeaders, "content-type") ?? detail.mimeType;
  if (!isTrustedSourceMapMime(mimeType, detail.url)) {
    return undefined;
  }
  try {
    JSON.parse(detail.responseBody);
  } catch {
    return undefined;
  }
  return detail.responseBody;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSameSourceMapUrl(left: string, right: string, pageUrl: string): boolean {
  const leftResult = normalizeSameOriginSourceMapUrl(left, pageUrl);
  const rightResult = normalizeSameOriginSourceMapUrl(right, pageUrl);
  return leftResult.ok && rightResult.ok && leftResult.url === rightResult.url;
}

function decodeInlineSourceMapCandidate(resource: IndexedJsSourceSnapshot, dataUrl: string, message?: string): SourceMapCandidateInternal {
  const base: SourceMapCandidateInternal = {
    resourceId: resource.id,
    resourceUrl: resource.url,
    source: "inline",
    inline: true,
    status: "failed",
    parsed: false,
    message,
  };
  const match = /^data:([^,]*),(.*)$/is.exec(dataUrl);
  if (!match) {
    return { ...base, message: "inline Source Map data URL 格式无效。" };
  }
  const metadata = match[1].toLowerCase();
  if (!isAllowedInlineMime(metadata)) {
    return { ...base, message: "inline Source Map 只接受 JSON 或 source-map data URL。" };
  }
  if (match[2].length > MAX_INLINE_SOURCE_MAP_BYTES * 2) {
    return { ...base, message: "inline Source Map 超过大小上限。" };
  }
  try {
    const decoded = metadata.includes(";base64") ? decodeBase64(match[2]) : decodeURIComponent(match[2]);
    if (decoded.length > MAX_INLINE_SOURCE_MAP_BYTES) {
      return { ...base, message: "inline Source Map 超过大小上限。" };
    }
    return { ...base, status: "available", mapContent: decoded };
  } catch {
    return { ...base, message: "inline Source Map 解码失败。" };
  }
}

function parseSourceMap(resource: IndexedJsSourceSnapshot, candidate: SourceMapCandidateInternal, content: string): { candidate: SourceMapCandidateInternal; map?: TraceMap } {
  try {
    const parsed = JSON.parse(content) as SourceMapInputLike | SectionedSourceMapInputLike;
    const map = isSectionedSourceMap(parsed) ? new AnyMap(parsed, candidate.url ?? resource.url) : new TraceMap(parsed as SourceMapInputLike, candidate.url ?? resource.url);
    return { candidate: { ...candidate, status: "available", parsed: true }, map };
  } catch {
    return { candidate: { ...candidate, status: "failed", parsed: false, message: "Source Map JSON 或 mappings 无效。" } };
  }
}

function resolveGeneratedLocation(resource: IndexedJsSourceSnapshot, map: TraceMap, line: number, column: number): SourceMapResolvedLocation {
  // trace-mapping 的 line 仍然按一基处理，只有 column 需要从展示口径的一基转为库口径的零基。
  const original = originalPositionFor(map, { line, column: Math.max(0, column - 1) });
  if (!original.source || original.line === null || original.column === null) {
    return createUnresolvedLocation(resource, line, column, "Source Map 未找到对应原始位置。");
  }
  return {
    resourceId: resource.id,
    resourceUrl: resource.url,
    generatedLine: line,
    generatedColumn: column,
    source: original.source,
    originalLine: original.line,
    originalColumn: original.column + 1,
    name: original.name ?? undefined,
    ignored: isIgnored(map, original.source),
    hasSourceContent: sourceContentFor(map, original.source) !== null,
  };
}

function extractOriginalContextFromMap(resource: IndexedJsSourceSnapshot, map: TraceMap, line: number, column: number, radius: number): SourceMapOriginalContext {
  const resolved = resolveGeneratedLocation(resource, map, line, column);
  if (!resolved.source || !resolved.originalLine || !resolved.originalColumn) {
    return { ...resolved, redacted: true, truncated: false };
  }
  const sourceContent = sourceContentFor(map, resolved.source);
  if (sourceContent === null) {
    return { ...resolved, redacted: true, truncated: false, message: "Source Map 不包含 sourcesContent，本阶段不主动拉取原始源码文件。" };
  }
  const position = calculatePositionFromLineColumn(sourceContent, resolved.originalLine, resolved.originalColumn);
  const start = Math.max(0, position - radius);
  const end = Math.min(sourceContent.length, position + radius);
  const truncated = truncateText(sourceContent.slice(start, end), MAX_CONTEXT_LENGTH);
  const redacted = redactJsSourceSnippet(truncated.text);
  return {
    ...resolved,
    snippet: redacted.text,
    // Source Map 原始片段统一按已脱敏附件处理，避免后续导出或追问把这段内容当作原文全文。
    redacted: true,
    truncated: truncated.truncated || start > 0 || end < sourceContent.length,
  };
}

function createUnresolvedLocation(resource: IndexedJsSourceSnapshot, line: number, column: number, message: string): SourceMapResolvedLocation {
  return {
    resourceId: resource.id,
    resourceUrl: resource.url,
    generatedLine: line,
    generatedColumn: column,
    ignored: false,
    hasSourceContent: false,
    message,
  };
}

function createOriginalContextFailure(resource: IndexedJsSourceSnapshot, line: number, column: number, message: string): SourceMapOriginalContext {
  return {
    ...createUnresolvedLocation(resource, line, column, message),
    redacted: true,
    truncated: false,
  };
}

function createSourceMapResult(
  toolCall: ModelToolCall,
  content: string,
  payload: {
    candidates?: SourceMapCandidate[];
    resolvedLocations?: SourceMapResolvedLocation[];
    originalContexts?: SourceMapOriginalContext[];
    failures?: ChatSourceMapToolAttachment["failures"];
    truncated?: boolean;
  },
): ModelToolResult {
  const attachment = createSourceMapAttachment(toolCall.id, payload);
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    toolAttachments: [attachment],
  };
}

function createSourceMapAttachment(
  sourceToolCallId: string,
  payload: {
    candidates?: SourceMapCandidate[];
    resolvedLocations?: SourceMapResolvedLocation[];
    originalContexts?: SourceMapOriginalContext[];
    failures?: ChatSourceMapToolAttachment["failures"];
    truncated?: boolean;
  },
): ChatSourceMapToolAttachment {
  const candidates = payload.candidates ?? [];
  const resolvedLocations = payload.resolvedLocations ?? [];
  const originalContexts = payload.originalContexts ?? [];
  const failures = payload.failures ?? [];
  return {
    id: `tool-attachment-${sourceToolCallId}`,
    kind: "source-map",
    title: "Source Map 解析结果",
    summary: `Source Map 候选 ${candidates.length} 个，映射 ${resolvedLocations.length} 个，原始片段 ${originalContexts.length} 个，失败 ${failures.length} 个。`,
    sourceToolCallId,
    createdAt: Date.now(),
    redacted: true,
    truncated: payload.truncated === true || originalContexts.some((context) => context.truncated),
    candidates,
    resolvedLocations,
    originalContexts,
    failures,
  };
}

function createErrorResult(toolCall: ModelToolCall, content: string): ModelToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    content,
    isError: true,
  };
}

function validateLocationArguments(args: Record<string, unknown>): { ok: true; resourceId: string; line: number; column: number; allowSameOriginFetch: boolean } | { ok: false; message: string } {
  const resourceId = normalizeOptionalString(args.resourceId, MAX_RESOURCE_ID_LENGTH);
  if (!resourceId) {
    return { ok: false, message: RESOURCE_ID_INVALID_MESSAGE };
  }
  if (!isPositiveInteger(args.line) || !isPositiveInteger(args.column)) {
    return { ok: false, message: LOCATION_INVALID_MESSAGE };
  }
  return {
    ok: true,
    resourceId,
    line: Math.floor(args.line),
    column: Math.floor(args.column),
    allowSameOriginFetch: args.allowSameOriginFetch === true,
  };
}

function normalizeOptionalStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((item) => normalizeOptionalString(item, maxLength)).filter((item): item is string => Boolean(item)))).slice(0, maxItems);
}

function normalizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? truncateText(trimmed, maxLength).text : undefined;
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), fallback);
}

function normalizeRadius(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_RADIUS;
  }
  return Math.min(Math.max(Math.floor(value), 80), 3000);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function findHeader(headers: IndexedJsSourceSnapshot["responseHeaders"], name: string): string | undefined {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value.trim();
}

function isAllowedInlineMime(metadata: string): boolean {
  const mimeType = metadata.split(";", 1)[0]?.trim();
  return !mimeType || mimeType === "application/json" || mimeType === "application/source-map" || mimeType === "text/plain" || mimeType === "text/json";
}

function decodeBase64(value: string): string {
  try {
    if (typeof atob === "function") {
      return atob(value);
    }
  } catch {
    // 继续尝试 Node 测试环境的 Buffer。
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function calculatePositionFromLineColumn(content: string, line: number, column: number): number {
  let currentLine = 1;
  let lineStart = 0;
  for (let index = 0; index < content.length && currentLine < line; index += 1) {
    if (content[index] === "\n") {
      currentLine += 1;
      lineStart = index + 1;
    }
  }
  return Math.min(content.length, lineStart + Math.max(0, column - 1));
}

function formatCandidateList(candidates: SourceMapCandidate[], failures: ChatSourceMapToolAttachment["failures"]): string {
  if (candidates.length === 0) {
    return failures.length ? `未找到可用 Source Map 候选：\n${failures.map((failure) => `- ${failure.message}`).join("\n")}` : "未找到 Source Map 候选。";
  }
  return [
    `找到 ${candidates.length} 个 Source Map 候选：`,
    ...candidates.map((candidate, index) =>
      `${index + 1}. ${candidate.resourceId} | ${candidate.source} | ${candidate.status} | ${formatCandidateLocation(candidate)}${candidate.message ? ` | ${candidate.message}` : ""}`,
    ),
  ].join("\n");
}

function formatCandidateLocation(candidate: SourceMapCandidate): string {
  if (candidate.inline) {
    return "inline";
  }
  return candidate.url ? "外部 Source Map" : "无 URL";
}

function formatResolvedLocations(locations: SourceMapResolvedLocation[]): string {
  return locations.map((location) =>
    `${location.resourceId}:${location.generatedLine}:${location.generatedColumn} -> ${location.source ?? "未映射"}:${location.originalLine ?? "-"}:${location.originalColumn ?? "-"}${location.message ? `\n${location.message}` : ""}`,
  ).join("\n");
}

function formatOriginalContexts(contexts: SourceMapOriginalContext[]): string {
  return contexts.map((context) => [
    `${context.resourceId}:${context.generatedLine}:${context.generatedColumn} -> ${context.source ?? "未映射"}:${context.originalLine ?? "-"}:${context.originalColumn ?? "-"}`,
    context.truncated ? "Truncated: true" : "Truncated: false",
    "",
    context.snippet ?? context.message ?? "",
  ].join("\n")).join("\n\n");
}

function firstFailureMessage(loaded: { failures: ChatSourceMapToolAttachment["failures"] }): string {
  return loaded.failures[0]?.message ?? "Source Map 不可用。";
}

function toPublicCandidate(candidate: SourceMapCandidateInternal): SourceMapCandidate {
  const { mapContent: _mapContent, mapUrl: _mapUrl, ...publicCandidate } = candidate;
  return publicCandidate;
}

function stripContextSnippet(context: SourceMapOriginalContext): SourceMapResolvedLocation {
  const { snippet: _snippet, redacted: _redacted, truncated: _truncated, ...location } = context;
  return location;
}

function candidateMatchesParsed(candidate: SourceMapCandidateInternal, parsed: SourceMapCandidateInternal): boolean {
  return candidate.resourceId === parsed.resourceId && candidate.source === parsed.source && (candidate.url ?? "") === (parsed.url ?? "");
}

function isToolCallName(name: string, legacyId: string, publicName: string): boolean {
  return name === legacyId || name === publicName;
}

function isSectionedSourceMap(value: SourceMapInputLike | SectionedSourceMapInputLike): value is SectionedSourceMapInputLike {
  return typeof value === "object" && value !== null && "sections" in value && Array.isArray((value as { sections?: unknown }).sections);
}
