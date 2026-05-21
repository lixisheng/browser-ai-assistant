import { create, type StoreApi } from "zustand";
import type { RemoteModelInfo } from "../../shared/models/modelCatalog";
import {
  deleteExtractionRule,
  deleteModelProvider,
  deleteProviderModel,
  getExtractionRules,
  getModelProviders,
  getProviderModels,
  moveExtractionRule,
  saveExtractionRule,
  saveModelProvider,
  saveProviderModel,
} from "../../shared/storage/repositories";
import { DEFAULT_CONTEXT_MAX_LENGTH } from "../../shared/constants";
import { validateExtractionRuleDraft } from "../../shared/extractionRules/validation";
import { generateUrlPatternsWithModel } from "../../shared/extractionRules/urlPatternGeneration";
import type { EndpointType, ExtractionRule, ModelProvider, ProviderModel } from "../../shared/types";

const DEBUG_PREFIX = "[提取规则 AI 生成诊断]";

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

interface PageContextState {
  loading: boolean;
  url?: string;
  text: string;
  truncated: boolean;
  usedFallback: boolean;
  matchedRuleId?: string;
  error?: string;
}

interface AppState {
  providers: ModelProvider[];
  models: ProviderModel[];
  extractionRules: ExtractionRule[];
  pageContext: PageContextState;
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
  loadExtractionRules: () => Promise<void>;
  saveRuleDraft: (ruleId: string | undefined, draft: Pick<ExtractionRule, "alias" | "urlPattern" | "selectorsText">) => Promise<{ ok: true; rule: ExtractionRule } | { ok: false; message: string }>;
  deleteRule: (ruleId: string) => Promise<void>;
  moveRule: (ruleId: string, direction: "up" | "down") => Promise<void>;
  refreshPageContext: () => Promise<void>;
  generateUrlPatterns: (modelId?: string) => Promise<{ ok: true; patterns: string[] } | { ok: false; message: string }>;
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
  extractionRules: [],
  pageContext: {
    loading: false,
    text: "",
    truncated: false,
    usedFallback: true,
  },
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
  loadExtractionRules: async () => {
    const extractionRules = await getExtractionRules();
    set({ extractionRules });
  },
  saveRuleDraft: async (ruleId, draft) => {
    const validation = validateExtractionRuleDraft(draft);
    if (!validation.ok) {
      return validation;
    }

    const now = Date.now();
    const existingRule = ruleId ? get().extractionRules.find((rule) => rule.id === ruleId) : undefined;
    const nextSortOrder =
      existingRule?.sortOrder ?? Math.max(0, ...get().extractionRules.map((rule) => rule.sortOrder)) + 10;
    const rule: ExtractionRule = {
      id: existingRule?.id ?? `rule-${now}`,
      alias: draft.alias.trim(),
      urlPattern: draft.urlPattern.trim(),
      selectorsText: draft.selectorsText.trim(),
      sortOrder: nextSortOrder,
      createdAt: existingRule?.createdAt ?? now,
      updatedAt: now,
    };

    await saveExtractionRule(rule);
    await get().loadExtractionRules();
    void get().refreshPageContext();
    return { ok: true, rule };
  },
  deleteRule: async (ruleId) => {
    await deleteExtractionRule(ruleId);
    await get().loadExtractionRules();
    void get().refreshPageContext();
  },
  moveRule: async (ruleId, direction) => {
    await moveExtractionRule(ruleId, direction);
    await get().loadExtractionRules();
    void get().refreshPageContext();
  },
  refreshPageContext: async () => {
    set((state) => ({
      pageContext: {
        ...state.pageContext,
        loading: true,
        error: undefined,
      },
    }));

    const response = await sendRuntimeMessage<
      | {
          ok: true;
          url?: string;
          text: string;
          truncated: boolean;
          usedFallback: boolean;
          matchedRuleId?: string;
        }
      | { ok: false; message?: string }
    >({
      type: "pageContext.extract",
      rules: get().extractionRules,
      maxLength: DEFAULT_CONTEXT_MAX_LENGTH,
    });

    if (!response) {
      set((state) => ({
        pageContext: {
          ...state.pageContext,
          loading: false,
          error: "提取当前页面失败",
        },
      }));
      return;
    }

    if (response.ok) {
      set({
        pageContext: {
          loading: false,
          url: response.url,
          text: response.text,
          truncated: response.truncated,
          usedFallback: response.usedFallback,
          matchedRuleId: response.matchedRuleId,
        },
      });
      return;
    }

    set((state) => ({
      pageContext: {
        ...state.pageContext,
        loading: false,
        error: response.message ?? "提取当前页面失败",
      },
    }));
  },
  generateUrlPatterns: async (modelId) => {
    const state = get();
    const debugRequestId = `url-pattern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.debug(`${DEBUG_PREFIX} 前端开始生成 URL 正则`, {
      debugRequestId,
      requestedModelId: modelId,
      providerCount: state.providers.length,
      modelCount: state.models.length,
      selectedModelId: state.selectedModelId,
      pageContextUrl: state.pageContext.url,
    });

    const model = modelId
      ? state.models.find((item) => item.id === modelId)
      : state.models.find((item) => item.id === state.selectedModelId) ?? state.models.find((item) => item.enabled);
    const provider = model ? state.providers.find((item) => item.id === model.providerId) : undefined;
    if (!provider || !model) {
      console.warn(`${DEBUG_PREFIX} 前端未找到可用模型或渠道`, {
        debugRequestId,
        requestedModelId: modelId,
        foundModel: Boolean(model),
        foundProvider: Boolean(provider),
      });
      return { ok: false, message: "请先配置可用模型后再使用 AI 生成" };
    }

    const urlResult = state.pageContext.url
      ? ({ ok: true, url: state.pageContext.url } as const)
      : await getCurrentTabUrlForGeneration(debugRequestId);
    if (!urlResult.ok) {
      console.warn(`${DEBUG_PREFIX} 前端获取当前 URL 失败`, {
        debugRequestId,
        message: urlResult.message,
      });
      return { ok: false, message: urlResult.message };
    }

    console.debug(`${DEBUG_PREFIX} 前端准备直接调用模型生成`, {
      debugRequestId,
      providerId: provider.id,
      providerName: provider.name,
      endpointType: provider.endpointType,
      endpointUrl: provider.endpointUrl,
      modelId: model.id,
      modelName: model.displayName,
      modelValue: model.modelId,
      url: urlResult.url,
    });

    try {
      const response = await generateUrlPatternsWithModel(provider, model, urlResult.url);

      console.debug(`${DEBUG_PREFIX} 前端收到生成响应`, {
        debugRequestId,
        response,
      });

      return response.ok ? response : { ok: false, message: response.message ?? "AI 生成失败" };
    } catch (error) {
      console.error(`${DEBUG_PREFIX} 前端生成流程异常`, {
        debugRequestId,
        error,
      });
      return { ok: false, message: "AI 生成失败" };
    }
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
      extractionRules: [],
      pageContext: {
        loading: false,
        text: "",
        truncated: false,
        usedFallback: true,
      },
      remoteModels: {},
      channelOperations: {},
      modelConnectivity: {},
      selectedModelId: "",
      streamMode: false,
      failure: undefined,
    });
  },
}));

async function getCurrentTabUrlForGeneration(debugRequestId: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  console.debug(`${DEBUG_PREFIX} 前端请求后台读取当前标签页 URL`, {
    debugRequestId,
  });

  const response = await sendRuntimeMessage<{ ok: true; url: string } | { ok: false; message?: string }>({
    type: "extractionRule.getCurrentTabUrl",
    debugRequestId,
  });

  console.debug(`${DEBUG_PREFIX} 前端收到当前标签页 URL 响应`, {
    debugRequestId,
    response,
    runtimeLastError: globalThis.chrome?.runtime?.lastError?.message,
  });

  if (!response) {
    return { ok: false, message: "未获取到当前页面 URL" };
  }

  return response.ok ? response : { ok: false, message: response.message ?? "未获取到当前页面 URL" };
}

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

  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (response: T) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(response);
    };

    try {
      // 真实 Chrome 扩展环境可能走 callback 形态；显式传 callback，避免把 sendMessage 的返回值 undefined 当作响应。
      const maybePromise = globalThis.chrome.runtime.sendMessage(message, (response: T) => {
        const runtimeError = globalThis.chrome?.runtime?.lastError?.message;
        if (runtimeError) {
          finish({
            ok: false,
            message: runtimeError,
          } as T);
          return;
        }

        finish(response);
      }) as Promise<T> | undefined;

      if (maybePromise && typeof maybePromise.then === "function") {
        void maybePromise.then(finish).catch((error) => {
          finish({
            ok: false,
            message: error instanceof Error ? error.message : "插件后台请求失败",
          } as T);
        });
      }
    } catch (error) {
      finish({
        ok: false,
        message: error instanceof Error ? error.message : "插件后台请求失败",
      } as T);
    }
  });
}
