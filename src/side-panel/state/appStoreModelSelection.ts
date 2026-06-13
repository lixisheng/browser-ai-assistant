import type { ChatSession, ModelProvider, ProviderModel } from "../../shared/types";
import type { AppState } from "./appStore";
import { upsertSession } from "./appStoreSessionUtils";

export function resolveAvailableModelId(modelId: string, models: ProviderModel[], providers: ModelProvider[]): string {
  const availableModels = models.filter((model) => {
    const provider = providers.find((item) => item.id === model.providerId);
    return model.enabled && provider?.enabled;
  });

  if (modelId && availableModels.some((model) => model.id === modelId)) {
    return modelId;
  }

  return availableModels[0]?.id ?? "";
}

export function resolveConfiguredModelId(modelId: string, models: ProviderModel[], providers: ModelProvider[]): string {
  if (!modelId) {
    return "";
  }

  const resolvedModelId = resolveAvailableModelId(modelId, models, providers);
  return resolvedModelId === modelId ? modelId : "";
}

export function resolveSessionModelId(session: ChatSession, state: AppState): string {
  const sessionModelId = session.selectedModelId
    ? resolveAvailableModelId(session.selectedModelId, state.models, state.providers)
    : "";
  return sessionModelId || resolveAvailableModelId(state.defaultChatModelId, state.models, state.providers);
}

export function resolveActiveChatSessionSelection(
  state: AppState,
  chatSessions: ChatSession[],
): Pick<AppState, "activeSessionId" | "selectedModelId"> {
  const activeSession =
    (state.activeSessionId && chatSessions.find((session) => session.id === state.activeSessionId)) || chatSessions[0];
  if (!activeSession) {
    return {
      activeSessionId: "",
      selectedModelId: resolveAvailableModelId(state.defaultChatModelId || state.selectedModelId, state.models, state.providers),
    };
  }

  return {
    activeSessionId: activeSession.id,
    selectedModelId: resolveSessionModelId(activeSession, state),
  };
}

export function syncActiveSessionSelectedModelAfterModelRemoval(
  chatSessions: ChatSession[],
  activeSessionId: string,
  removedModelIds: Set<string>,
  selectedModelId: string,
): { chatSessions: ChatSession[]; session?: ChatSession } {
  const activeSession = chatSessions.find((session) => session.id === activeSessionId);
  if (!activeSession?.selectedModelId || !removedModelIds.has(activeSession.selectedModelId)) {
    return { chatSessions };
  }

  const nextSession: ChatSession = {
    ...activeSession,
    selectedModelId,
    updatedAt: Date.now(),
  };
  return {
    chatSessions: upsertSession(chatSessions, nextSession),
    session: nextSession,
  };
}
