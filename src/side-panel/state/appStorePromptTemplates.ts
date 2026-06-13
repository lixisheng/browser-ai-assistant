import {
  deletePromptTemplate,
  getPromptTemplates,
  reorderPromptTemplates,
  savePromptTemplate,
} from "../../shared/storage/repositories";
import type { PromptTemplate } from "../../shared/types";
import type { StoreGetter, StoreSetter } from "./appStore";

export async function loadPromptTemplatesAction(input: { set: StoreSetter }): Promise<void> {
  const promptTemplates = await getPromptTemplates();
  input.set({ promptTemplates });
}

export async function savePromptTemplateDraftAction(input: {
  promptId: string | undefined;
  draft: Pick<PromptTemplate, "title" | "content">;
  get: StoreGetter;
}): Promise<{ ok: true; prompt: PromptTemplate } | { ok: false; message: string }> {
  const title = input.draft.title.trim();
  const content = input.draft.content.trim();
  if (!title) {
    return { ok: false, message: "提示词标题不能为空" };
  }
  if (!content) {
    return { ok: false, message: "Prompt 内容不能为空" };
  }

  const now = Date.now();
  const existingPrompt = input.promptId ? input.get().promptTemplates.find((prompt) => prompt.id === input.promptId) : undefined;
  const prompt: PromptTemplate = {
    id: existingPrompt?.id ?? `prompt-${now}`,
    title,
    content,
    sortOrder: existingPrompt?.sortOrder ?? Math.max(0, ...input.get().promptTemplates.map((item) => item.sortOrder)) + 10,
    createdAt: existingPrompt?.createdAt ?? now,
    updatedAt: now,
  };

  await savePromptTemplate(prompt);
  await input.get().loadPromptTemplates();
  return { ok: true, prompt };
}

export async function deletePromptAction(input: { promptId: string; get: StoreGetter }): Promise<void> {
  await deletePromptTemplate(input.promptId);
  await input.get().loadPromptTemplates();
}

export async function reorderPromptTemplatesAction(input: { orderedIds: string[]; get: StoreGetter }): Promise<void> {
  await reorderPromptTemplates(input.orderedIds);
  await input.get().loadPromptTemplates();
}
