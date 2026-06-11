import type {
  ChatWebSearchPayload,
  ChatWebSearchResult,
  TavilyIncludeAnswer,
  TavilyIncludeRawContent,
  WebSearchApiKeyStrategy,
  WebSearchSettings,
} from "../types";
import { normalizeTavilyIncludeAnswer, normalizeTavilyIncludeRawContent, normalizeTavilyMaxResults } from "./settings";
import { truncateText } from "../utils/text";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MAX_RESULT_CONTENT_LENGTH = 1200;
const MAX_ANSWER_LENGTH = 2000;
export const WEB_SEARCH_FAILURE_MESSAGE = "网络搜索失败，请检查 Tavily 配置后重试";

export interface TavilySearchOptions {
  includeAnswer?: TavilyIncludeAnswer;
  includeRawContent?: TavilyIncludeRawContent;
  maxResults?: number;
}

type Fetcher = typeof fetch;

interface SearchTavilyInput {
  query: string;
  settings: WebSearchSettings;
  currentApiKeyIndex: number;
  options?: TavilySearchOptions;
  fetcher?: Fetcher;
  random?: () => number;
}

export type SearchTavilyResult =
  | {
      ok: true;
      attachment: ChatWebSearchPayload;
      nextApiKeyIndex: number;
    }
  | {
      ok: false;
      message: string;
    };

export function parseTavilyApiKeys(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function selectTavilyApiKey(
  apiKeys: string[],
  strategy: WebSearchApiKeyStrategy,
  currentIndex: number,
  random: () => number = Math.random,
): { apiKey: string; nextIndex: number } | undefined {
  if (apiKeys.length === 0) {
    return undefined;
  }

  if (strategy === "random") {
    const selectedIndex = Math.min(apiKeys.length - 1, Math.max(0, Math.floor(random() * apiKeys.length)));
    return {
      apiKey: apiKeys[selectedIndex],
      nextIndex: normalizeApiKeyIndex(currentIndex, apiKeys.length),
    };
  }

  const selectedIndex = normalizeApiKeyIndex(currentIndex, apiKeys.length);
  return {
    apiKey: apiKeys[selectedIndex],
    nextIndex: (selectedIndex + 1) % apiKeys.length,
  };
}

export async function searchTavily(input: SearchTavilyInput): Promise<SearchTavilyResult> {
  const query = input.query.trim();
  if (!query) {
    return { ok: false, message: "网络搜索问题不能为空" };
  }

  const apiKeys = parseTavilyApiKeys(input.settings.tavily.apiKeysText);
  const selected = selectTavilyApiKey(apiKeys, input.settings.tavily.apiKeyStrategy, input.currentApiKeyIndex, input.random);
  if (!selected) {
    return { ok: false, message: "请先配置 Tavily API Key" };
  }

  try {
    const includeAnswer = normalizeTavilyIncludeAnswer(input.options?.includeAnswer ?? input.settings.tavily.includeAnswer);
    const includeRawContent = normalizeTavilyIncludeRawContent(input.options?.includeRawContent ?? input.settings.tavily.includeRawContent);
    const maxResults = normalizeTavilyMaxResults(input.options?.maxResults ?? input.settings.tavily.maxResults);

    const response = await (input.fetcher ?? fetch)(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${selected.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        include_answer: includeAnswer,
        include_raw_content: includeRawContent,
        max_results: maxResults,
      }),
    });

    if (!response.ok) {
      return { ok: false, message: WEB_SEARCH_FAILURE_MESSAGE };
    }

    const data = await response.json();
    const normalized = normalizeTavilyResponse(data, query);
    if (!normalized) {
      return { ok: false, message: WEB_SEARCH_FAILURE_MESSAGE };
    }

    return {
      ok: true,
      attachment: normalized,
      nextApiKeyIndex: selected.nextIndex,
    };
  } catch {
    return { ok: false, message: WEB_SEARCH_FAILURE_MESSAGE };
  }
}

export function createTavilySearchContextPrompt(attachment: ChatWebSearchPayload): string {
  const sections = [
    "网络搜索上下文：",
    `搜索渠道：${attachment.provider}`,
    `搜索问题：${attachment.query}`,
  ];

  if (attachment.answer?.trim()) {
    sections.push("", "综合答案：", attachment.answer.trim());
  }

  sections.push("", "搜索结果：");
  if (attachment.results.length === 0) {
    sections.push("未返回可用搜索结果");
  } else {
    sections.push(
      attachment.results
        .map((result, index) =>
          [
            `${index + 1}. ${result.title || "未命名结果"}`,
            `URL：${result.url}`,
            result.publishedDate ? `发布时间：${result.publishedDate}` : "",
            typeof result.score === "number" ? `相关度：${result.score}` : "",
            `摘要：${result.content}`,
            result.rawContent ? `原始内容：${result.rawContent}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
    );
  }

  if (attachment.truncated) {
    sections.push("", "提示：部分搜索内容已截断。");
  }

  return sections.join("\n").trim();
}

export function formatTavilySearchAttachmentSummary(attachment: ChatWebSearchPayload): string {
  const first = attachment.results[0];
  if (!first) {
    return `已搜索：${attachment.query}，未返回结果`;
  }

  return `已搜索：${attachment.query}，返回 ${attachment.results.length} 条结果，首条：${first.title || first.url}`;
}

function normalizeTavilyResponse(value: unknown, query: string): ChatWebSearchPayload | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeResponse = value as { answer?: unknown; results?: unknown };
  if (!Array.isArray(maybeResponse.results)) {
    return undefined;
  }

  let truncated = false;
  const results = maybeResponse.results
    .map((item): ChatWebSearchResult | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const result = item as Record<string, unknown>;
      const title = typeof result.title === "string" ? result.title.trim() : "";
      const url = typeof result.url === "string" ? result.url.trim() : "";
      const contentValue = typeof result.content === "string" ? result.content.trim() : "";
      const rawContentValue = typeof result.raw_content === "string" ? result.raw_content.trim() : "";
      if (!url || !contentValue) {
        return undefined;
      }

      const content = truncateText(contentValue, MAX_RESULT_CONTENT_LENGTH);
      const rawContent = rawContentValue ? truncateText(rawContentValue, MAX_RESULT_CONTENT_LENGTH) : undefined;
      truncated = truncated || content.truncated;
      truncated = truncated || Boolean(rawContent?.truncated);

      return {
        title: title || url,
        url,
        content: content.text,
        rawContent: rawContent?.text || undefined,
        score: typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined,
        publishedDate: typeof result.published_date === "string" ? result.published_date : undefined,
      };
    })
    .filter((item): item is ChatWebSearchResult => Boolean(item));

  const answerValue = typeof maybeResponse.answer === "string" ? maybeResponse.answer.trim() : "";
  const answer = truncateText(answerValue, MAX_ANSWER_LENGTH);
  truncated = truncated || answer.truncated;

  return {
    provider: "tavily",
    query,
    answer: answer.text || undefined,
    results,
    createdAt: Date.now(),
    truncated,
  };
}

function normalizeApiKeyIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || length <= 0) {
    return 0;
  }

  const rounded = Math.floor(index);
  return ((rounded % length) + length) % length;
}
