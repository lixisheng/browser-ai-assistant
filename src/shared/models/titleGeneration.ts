import { formatLocalDateTime } from "../utils/date";
import type { ChatMessage, ModelConfig } from "../types";

export interface GenerateSessionTitleInput {
  siteTitle: string;
  now: Date;
  messages: ChatMessage[];
  titleModel?: ModelConfig;
  requestTitle: (model: ModelConfig, messages: ChatMessage[]) => Promise<string>;
}

export async function generateSessionTitle(input: GenerateSessionTitleInput): Promise<string> {
  const fallbackTitle = createFallbackTitle(input.siteTitle, input.now);

  if (!input.titleModel) {
    return fallbackTitle;
  }

  try {
    const generatedTitle = (await input.requestTitle(input.titleModel, input.messages)).trim();
    return generatedTitle || fallbackTitle;
  } catch {
    return fallbackTitle;
  }
}

function createFallbackTitle(siteTitle: string, now: Date): string {
  return `${siteTitle || "未命名网页"} ${formatLocalDateTime(now)}`;
}
