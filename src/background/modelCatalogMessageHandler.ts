import { fetchProviderModels, testProviderModel } from "../shared/models/modelCatalog";
import type { ModelProvider, ProviderModel } from "../shared/types";

export type ModelCatalogMessage =
  | {
      type: "modelCatalog.list";
      provider: ModelProvider;
    }
  | {
      type: "modelCatalog.test";
      provider: ModelProvider;
      model: ProviderModel;
    };

export async function handleModelCatalogMessage(message: ModelCatalogMessage) {
  try {
    if (message.type === "modelCatalog.list") {
      return {
        ok: true,
        models: await fetchProviderModels(message.provider),
      };
    }

    if (message.type === "modelCatalog.test") {
      return await testProviderModel(message.provider, message.model);
    }

    return {
      ok: false,
      message: "未知模型渠道请求",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "模型渠道请求失败",
    };
  }
}
