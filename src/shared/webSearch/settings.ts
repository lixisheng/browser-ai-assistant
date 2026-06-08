import type { TavilyIncludeAnswer, TavilyIncludeRawContent, WebSearchApiKeyStrategy, WebSearchSettings } from "../types";
import { getAppSetting, saveAppSetting } from "../storage/repositories";

export const WEB_SEARCH_SETTINGS_KEY = "webSearchSettings";
export const TAVILY_API_KEY_ROUND_ROBIN_INDEX_KEY = "tavilyApiKeyRoundRobinIndex";

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  provider: "tavily",
  tavily: {
    apiKeysText: "",
    apiKeyStrategy: "round_robin",
    includeAnswer: "basic",
    includeRawContent: false,
    maxResults: 5,
  },
  updatedAt: 0,
};

export function normalizeWebSearchSettings(value?: Partial<WebSearchSettings>): WebSearchSettings {
  return {
    provider: value?.provider === "tavily" ? value.provider : DEFAULT_WEB_SEARCH_SETTINGS.provider,
    tavily: {
      apiKeysText: typeof value?.tavily?.apiKeysText === "string" ? value.tavily.apiKeysText.trim() : "",
      apiKeyStrategy: normalizeApiKeyStrategy(value?.tavily?.apiKeyStrategy),
      includeAnswer: normalizeTavilyIncludeAnswer(value?.tavily?.includeAnswer),
      includeRawContent: normalizeTavilyIncludeRawContent(value?.tavily?.includeRawContent),
      maxResults: normalizeTavilyMaxResults(value?.tavily?.maxResults),
    },
    updatedAt: typeof value?.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export async function getWebSearchSettings(): Promise<WebSearchSettings> {
  return normalizeWebSearchSettings(await getAppSetting<Partial<WebSearchSettings>>(WEB_SEARCH_SETTINGS_KEY));
}

export async function saveWebSearchSettings(settings: WebSearchSettings): Promise<void> {
  await saveAppSetting({
    key: WEB_SEARCH_SETTINGS_KEY,
    value: normalizeWebSearchSettings(settings),
    updatedAt: Date.now(),
  });
}

function normalizeApiKeyStrategy(value: unknown): WebSearchApiKeyStrategy {
  return value === "random" || value === "round_robin" ? value : DEFAULT_WEB_SEARCH_SETTINGS.tavily.apiKeyStrategy;
}

export function normalizeTavilyIncludeAnswer(value: unknown): TavilyIncludeAnswer {
  return value === true || value === false || value === "basic" || value === "advanced"
    ? value
    : DEFAULT_WEB_SEARCH_SETTINGS.tavily.includeAnswer;
}

export function normalizeTavilyIncludeRawContent(value: unknown): TavilyIncludeRawContent {
  return value === true || value === false || value === "markdown" || value === "text"
    ? value
    : DEFAULT_WEB_SEARCH_SETTINGS.tavily.includeRawContent;
}

export function normalizeTavilyMaxResults(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return DEFAULT_WEB_SEARCH_SETTINGS.tavily.maxResults;
  }

  return Math.min(20, Math.max(1, Math.round(numberValue)));
}

export function parseTavilyIncludeAnswerInput(value: string): TavilyIncludeAnswer {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  return value === "advanced" ? "advanced" : "basic";
}

export function parseOptionalTavilyIncludeAnswerInput(value: string): TavilyIncludeAnswer | undefined {
  return value ? parseTavilyIncludeAnswerInput(value) : undefined;
}

export function parseTavilyIncludeRawContentInput(value: string): TavilyIncludeRawContent {
  if (value === "true") {
    return true;
  }
  if (value === "markdown" || value === "text") {
    return value;
  }

  return false;
}

export function parseOptionalTavilyIncludeRawContentInput(value: string): TavilyIncludeRawContent | undefined {
  return value ? parseTavilyIncludeRawContentInput(value) : undefined;
}

export function formatTavilyIncludeAnswerLabel(value: TavilyIncludeAnswer): string {
  if (value === "basic") {
    return "基础答案";
  }
  if (value === "advanced") {
    return "深入答案";
  }

  return value ? "开启" : "关闭";
}

export function formatTavilyIncludeRawContentLabel(value: TavilyIncludeRawContent): string {
  if (value === "markdown") {
    return "Markdown";
  }
  if (value === "text") {
    return "纯文本";
  }

  return value ? "开启" : "关闭";
}
