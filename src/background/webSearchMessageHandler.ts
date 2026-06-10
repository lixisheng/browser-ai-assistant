import { searchTavily } from "../shared/webSearch/tavily";
import { getWebSearchSettings, TAVILY_API_KEY_ROUND_ROBIN_INDEX_KEY } from "../shared/webSearch/settings";
import { getAppSetting, saveAppSetting } from "../shared/storage/repositories";
import type { ChatWebSearchContextAttachment } from "../shared/types";
import type { TavilySearchOptions } from "../shared/webSearch/tavily";

type Fetcher = typeof fetch;

export type WebSearchResponse =
  | { ok: true; attachment: ChatWebSearchContextAttachment }
  | { ok: false; message: string };

export async function executeTavilySearchFromSettings(
  query: string,
  options?: TavilySearchOptions,
  fetcher: Fetcher = fetch,
): Promise<WebSearchResponse> {
  const settings = await getWebSearchSettings();
  const currentIndex = await getAppSetting<number>(TAVILY_API_KEY_ROUND_ROBIN_INDEX_KEY);
  const result = await searchTavily({
    query,
    settings,
    options,
    currentApiKeyIndex: typeof currentIndex === "number" ? currentIndex : 0,
    fetcher,
  });

  if (!result.ok) {
    return result;
  }

  await saveAppSetting({
    key: TAVILY_API_KEY_ROUND_ROBIN_INDEX_KEY,
    value: result.nextApiKeyIndex,
    updatedAt: Date.now(),
  });

  return {
    ok: true,
    attachment: result.attachment,
  };
}
