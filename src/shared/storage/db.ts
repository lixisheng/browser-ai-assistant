import Dexie, { type EntityTable } from "dexie";
import { DATABASE_NAME, DATABASE_VERSION } from "../constants";
import type { AppSetting, ChatSession, ExtractionRule, ModelConfig, ModelProvider, ProviderModel } from "../types";

export class BrowserAssistantDatabase extends Dexie {
  modelConfigs!: EntityTable<ModelConfig, "id">;
  modelProviders!: EntityTable<ModelProvider, "id">;
  providerModels!: EntityTable<ProviderModel, "id">;
  extractionRules!: EntityTable<ExtractionRule, "id">;
  chatSessions!: EntityTable<ChatSession, "id">;
  appSettings!: EntityTable<AppSetting, "key">;

  constructor() {
    super(DATABASE_NAME);

    this.version(DATABASE_VERSION).stores({
      modelConfigs: "id, channelName, endpointType, updatedAt",
      modelProviders: "id, name, endpointType, updatedAt",
      providerModels: "id, providerId, displayName, updatedAt",
      extractionRules: "id, urlPattern, updatedAt",
      chatSessions: "id, sortOrder, updatedAt",
      appSettings: "key, updatedAt",
    });
  }
}

export const db = new BrowserAssistantDatabase();
