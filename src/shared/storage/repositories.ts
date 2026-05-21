import { db } from "./db";
import type { ChatSession, ExtractionRule, ModelConfig, ModelProvider, ProviderModel } from "../types";

export async function saveModelConfig(model: ModelConfig): Promise<void> {
  await db.modelConfigs.put(model);
}

export async function getModelConfigs(): Promise<ModelConfig[]> {
  return db.modelConfigs.orderBy("updatedAt").toArray();
}

export async function saveModelProvider(provider: ModelProvider): Promise<void> {
  await db.modelProviders.put(provider);
}

export async function getModelProviders(): Promise<ModelProvider[]> {
  return db.modelProviders.orderBy("updatedAt").toArray();
}

export async function deleteModelProvider(providerId: string): Promise<void> {
  await db.transaction("rw", [db.modelProviders, db.providerModels], async () => {
    await db.modelProviders.delete(providerId);
    await db.providerModels.where("providerId").equals(providerId).delete();
  });
}

export async function saveProviderModel(model: ProviderModel): Promise<void> {
  await db.providerModels.put(model);
}

export async function getProviderModels(providerId?: string): Promise<ProviderModel[]> {
  const models = providerId
    ? await db.providerModels.where("providerId").equals(providerId).sortBy("updatedAt")
    : await db.providerModels.orderBy("updatedAt").toArray();

  return models;
}

export async function deleteProviderModel(modelId: string): Promise<void> {
  await db.providerModels.delete(modelId);
}

export async function saveExtractionRule(rule: ExtractionRule): Promise<void> {
  await db.extractionRules.put(rule);
}

export async function getExtractionRules(): Promise<ExtractionRule[]> {
  return db.extractionRules.orderBy("sortOrder").toArray();
}

export async function deleteExtractionRule(ruleId: string): Promise<void> {
  await db.extractionRules.delete(ruleId);
}

export async function moveExtractionRule(ruleId: string, direction: "up" | "down"): Promise<void> {
  await db.transaction("rw", db.extractionRules, async () => {
    const rules = await getExtractionRules();
    const currentIndex = rules.findIndex((rule) => rule.id === ruleId);
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;

    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= rules.length) {
      return;
    }

    const now = Date.now();
    const currentRule = rules[currentIndex];
    const targetRule = rules[targetIndex];
    await Promise.all([
      db.extractionRules.put({ ...currentRule, sortOrder: targetRule.sortOrder, updatedAt: now }),
      db.extractionRules.put({ ...targetRule, sortOrder: currentRule.sortOrder, updatedAt: now }),
    ]);
  });
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  await db.chatSessions.put(session);
}

export async function getChatSession(id: string): Promise<ChatSession | undefined> {
  return db.chatSessions.get(id);
}

export async function getChatSessions(): Promise<ChatSession[]> {
  return db.chatSessions.orderBy("sortOrder").toArray();
}

export async function clearDatabase(): Promise<void> {
  await db.transaction(
    "rw",
    [db.modelConfigs, db.modelProviders, db.providerModels, db.extractionRules, db.chatSessions, db.appSettings],
    async () => {
      await Promise.all([
        db.modelConfigs.clear(),
        db.modelProviders.clear(),
        db.providerModels.clear(),
        db.extractionRules.clear(),
        db.chatSessions.clear(),
        db.appSettings.clear(),
      ]);
    },
  );
}
