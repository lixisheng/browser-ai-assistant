import { create, type StoreApi } from "zustand";
import type { RemoteModelInfo } from "../../shared/models/modelCatalog";
import {
  deleteModelProvider,
  deleteProviderModel,
  getModelProviders,
  getProviderModels,
  saveModelProvider,
  saveProviderModel,
} from "../../shared/storage/repositories";
import type { EndpointType, ModelProvider, ProviderModel } from "../../shared/types";

interface RequestFailure {
  message: string;
}

interface ChannelOperationState {
  loading: boolean;
  message?: string;
  error?: string;
}

interface ModelConnectivityState {
  loading: boolean;
  success?: boolean;
  error?: string;
}

interface AppState {
  providers: ModelProvider[];
  models: ProviderModel[];
  remoteModels: Record<string, RemoteModelInfo[]>;
  channelOperations: Record<string, ChannelOperationState>;
  modelConnectivity: Record<string, ModelConnectivityState>;
  selectedModelId: string;
  streamMode: boolean;
  failure?: RequestFailure;
  addExampleModel: () => void;
  addProvider: () => ModelProvider;
  updateProvider: (providerId: string, updates: Partial<Pick<ModelProvider, "name" | "endpointType" | "endpointUrl" | "apiKey">>) => void;
  addModel: (providerId: string) => ProviderModel;
  addRemoteModel: (providerId: string, remoteModel: RemoteModelInfo) => ProviderModel;
  updateModel: (modelId: string, updates: Partial<Pick<ProviderModel, "displayName" | "modelId" | "temperature" | "maxTokens" | "systemPrompt">>) => void;
  deleteProvider: (providerId: string) => void;
  deleteModel: (modelId: string) => void;
  loadChannelConfig: () => Promise<void>;
  fetchRemoteModels: (providerId: string) => Promise<void>;
  testModel: (providerId: string, modelId: string) => Promise<void>;
  selectModel: (modelId: string) => void;
  setStreamMode: (streamMode: boolean) => void;
  simulateFailure: () => void;
  clearFailure: () => void;
  reset: () => void;
}

const exampleProvider: ModelProvider = {
  id: "provider-1",
  name: "默认渠道",
  endpointType: "openai_chat",
  endpointUrl: "https://api.example.com/v1/chat/completions",
  apiKey: "sk-example",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const exampleModel: ProviderModel = {
  id: "model-1",
  providerId: exampleProvider.id,
  displayName: "默认 OpenAI",
  modelId: "gpt-test",
  temperature: 0.7,
  maxTokens: 1024,
  systemPrompt: "你是网页助手",
  isTitleModel: false,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

export const useAppStore = create<AppState>()((set, get) => ({
  providers: [],
  models: [],
  remoteModels: {},
  channelOperations: {},
  modelConnectivity: {},
  selectedModelId: "",
  streamMode: false,
  addExampleModel: () =>
    set(() => {
      void saveModelProvider(exampleProvider);
      void saveProviderModel(exampleModel);

      return {
        providers: [exampleProvider],
        models: [exampleModel],
        selectedModelId: exampleModel.id,
      };
    }),
  addProvider: () => {
    const now = Date.now();
    const index = get().providers.length + 1;
    const provider: ModelProvider = {
      id: `provider-${now}-${index}`,
      name: `新渠道 ${index}`,
      endpointType: "openai_chat",
      endpointUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({ providers: [...state.providers, provider] }));
    void saveModelProvider(provider);
    return provider;
  },
  updateProvider: (providerId, updates) =>
    set((state) => {
      const providers = state.providers.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              ...updates,
              endpointType: updates.endpointType ? (updates.endpointType as EndpointType) : provider.endpointType,
              updatedAt: Date.now(),
            }
          : provider,
      );
      const updatedProvider = providers.find((provider) => provider.id === providerId);

      if (updatedProvider) {
        void saveModelProvider(updatedProvider);
      }

      return { providers };
    }),
  addModel: (providerId) => createAndStoreModel(providerId, get, set),
  addRemoteModel: (providerId, remoteModel) =>
    createAndStoreModel(providerId, get, set, {
      displayName: remoteModel.displayName,
      modelId: remoteModel.id,
    }),
  updateModel: (modelId, updates) =>
    set((state) => {
      const models = state.models.map((model) =>
        model.id === modelId
          ? {
              ...model,
              ...updates,
              updatedAt: Date.now(),
            }
          : model,
      );
      const updatedModel = models.find((model) => model.id === modelId);

      if (updatedModel) {
        void saveProviderModel(updatedModel);
      }

      return { models };
    }),
  deleteProvider: (providerId) =>
    set((state) => {
      const removedModelIds = new Set(state.models.filter((model) => model.providerId === providerId).map((model) => model.id));
      const models = state.models.filter((model) => model.providerId !== providerId);
      const selectedModelId = removedModelIds.has(state.selectedModelId) ? models[0]?.id ?? "" : state.selectedModelId;
      const { [providerId]: _remoteModels, ...remoteModels } = state.remoteModels;
      const { [providerId]: _operation, ...channelOperations } = state.channelOperations;
      const modelConnectivity = Object.fromEntries(
        Object.entries(state.modelConnectivity).filter(([modelId]) => !removedModelIds.has(modelId)),
      );

      removedModelIds.forEach(clearModelConnectivityResetTimer);

      void deleteModelProvider(providerId);

      return {
        providers: state.providers.filter((provider) => provider.id !== providerId),
        models,
        selectedModelId,
        remoteModels,
        channelOperations,
        modelConnectivity,
      };
    }),
  deleteModel: (modelId) =>
    set((state) => {
      const models = state.models.filter((model) => model.id !== modelId);
      const selectedModelId = state.selectedModelId === modelId ? models[0]?.id ?? "" : state.selectedModelId;
      const { [modelId]: _operation, ...modelConnectivity } = state.modelConnectivity;

      clearModelConnectivityResetTimer(modelId);

      void deleteProviderModel(modelId);

      return {
        models,
        selectedModelId,
        modelConnectivity,
      };
    }),
  loadChannelConfig: async () => {
    const [providers, models] = await Promise.all([getModelProviders(), getProviderModels()]);
    const selectedModelStillExists = models.some((model) => model.id === get().selectedModelId);

    set({
      providers,
      models,
      selectedModelId: selectedModelStillExists ? get().selectedModelId : (models[0]?.id ?? ""),
    });
  },
  fetchRemoteModels: async (providerId) => {
    const provider = get().providers.find((item) => item.id === providerId);
    if (!provider) {
      return;
    }

    setChannelOperation(set, providerId, { loading: true });

    const response = await sendRuntimeMessage<{ ok: boolean; models?: RemoteModelInfo[]; message?: string }>({
      type: "modelCatalog.list",
      provider,
    });

    if (response.ok) {
      set((state) => ({
        remoteModels: {
          ...state.remoteModels,
          [providerId]: response.models ?? [],
        },
        channelOperations: {
          ...state.channelOperations,
          [providerId]: {
            loading: false,
            message: "模型列表获取成功",
          },
        },
      }));
      return;
    }

    setChannelOperation(set, providerId, { loading: false, error: response.message ?? "获取模型列表失败" });
  },
  testModel: async (providerId, modelId) => {
    const provider = get().providers.find((item) => item.id === providerId);
    const model = get().models.find((item) => item.id === modelId);
    if (!provider || !model) {
      return;
    }

    setModelConnectivity(set, modelId, { loading: true });

    const response = await sendRuntimeMessage<{ ok: boolean; message: string }>({
      type: "modelCatalog.test",
      provider,
      model,
    });

    if (response.ok) {
      setModelConnectivity(set, modelId, { loading: false, success: true });
      scheduleModelConnectivityReset(set, modelId);
      return;
    }

    setModelConnectivity(set, modelId, { loading: false, error: response.message });
  },
  selectModel: (modelId) => set({ selectedModelId: modelId }),
  setStreamMode: (streamMode) => set({ streamMode }),
  simulateFailure: () => set({ failure: { message: "请求失败，请重试" } }),
  clearFailure: () => set({ failure: undefined }),
  reset: () => {
    clearAllModelConnectivityResetTimers();

    set({
      providers: [],
      models: [],
      remoteModels: {},
      channelOperations: {},
      modelConnectivity: {},
      selectedModelId: "",
      streamMode: false,
      failure: undefined,
    });
  },
}));

type StoreGetter = StoreApi<AppState>["getState"];
type StoreSetter = StoreApi<AppState>["setState"];

function createAndStoreModel(
  providerId: string,
  get: StoreGetter,
  set: StoreSetter,
  overrides: Partial<Pick<ProviderModel, "displayName" | "modelId">> = {},
): ProviderModel {
  const now = Date.now();
  const index = get().models.filter((model) => model.providerId === providerId).length + 1;
  const model: ProviderModel = {
    id: `model-${now}-${index}`,
    providerId,
    displayName: overrides.displayName ?? `新模型 ${index}`,
    modelId: overrides.modelId ?? "gpt-4.1-mini",
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: "你是网页助手",
    isTitleModel: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  set((state) => ({
    models: [...state.models, model],
    selectedModelId: state.selectedModelId || model.id,
  }));
  void saveProviderModel(model);
  return model;
}

function setChannelOperation(set: StoreSetter, providerId: string, operation: ChannelOperationState) {
  set((state) => ({
    channelOperations: {
      ...state.channelOperations,
      [providerId]: operation,
    },
  }));
}

const modelConnectivityResetTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setModelConnectivity(set: StoreSetter, modelId: string, operation: ModelConnectivityState) {
  set((state) => ({
    modelConnectivity: {
      ...state.modelConnectivity,
      [modelId]: operation,
    },
  }));
}

function scheduleModelConnectivityReset(set: StoreSetter, modelId: string) {
  clearModelConnectivityResetTimer(modelId);

  const timer = setTimeout(() => {
    set((state) => {
      const operation = state.modelConnectivity[modelId];

      if (!operation?.success) {
        return state;
      }

      return {
        modelConnectivity: {
          ...state.modelConnectivity,
          [modelId]: {
            ...operation,
            success: false,
          },
        },
      };
    });
    modelConnectivityResetTimers.delete(modelId);
  }, 5000);

  modelConnectivityResetTimers.set(modelId, timer);
}

function clearModelConnectivityResetTimer(modelId: string) {
  const timer = modelConnectivityResetTimers.get(modelId);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  modelConnectivityResetTimers.delete(modelId);
}

function clearAllModelConnectivityResetTimers() {
  modelConnectivityResetTimers.forEach((timer) => clearTimeout(timer));
  modelConnectivityResetTimers.clear();
}

async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return {
      ok: false,
      message: "当前环境不支持插件后台请求",
    } as T;
  }

  return globalThis.chrome.runtime.sendMessage(message) as Promise<T>;
}
