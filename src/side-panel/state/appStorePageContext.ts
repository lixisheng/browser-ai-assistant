import { createPageContextPrompt } from "../../shared/chat/pageContextPrompt";
import type { ExtractionRule, PageContextExtractMode } from "../../shared/types";
import type { ContextTabCandidate, StoreGetter, StoreSetter } from "./appStore";
import { sendRuntimeMessage } from "./runtimeMessage";

type ExtractPageContextSuccessResponse = {
  ok: true;
  url?: string;
  title?: string;
  text: string;
  truncated: boolean;
  usedFallback: boolean;
  matchedRuleId?: string;
};

type ExtractPageContextFailureResponse = { ok: false; message?: string };

let pageContextRefreshSequence = 0;

export function resetPageContextRefreshSequence(): void {
  pageContextRefreshSequence += 1;
}

export async function loadContextTabsAction(input: { set: StoreSetter }): Promise<void> {
  input.set({ contextTabsLoading: true, contextTabsError: undefined });
  const response = await sendRuntimeMessage<
    | {
        ok: true;
        tabs: Array<{ tabId: number; title: string; url: string; active: boolean }>;
      }
    | { ok: false; message?: string }
  >({ type: "pageContext.listTabs" });

  if (!response?.ok || !("tabs" in response) || !Array.isArray(response.tabs)) {
    const message = response && "message" in response ? response.message : undefined;
    input.set({
      contextTabsLoading: false,
      contextTabsError: message ?? "获取标签页列表失败",
    });
    return;
  }

  input.set((state) => {
    const previousSelectedIds = new Set(state.contextTabs.filter((tab) => tab.selected).map((tab) => tab.tabId));
    const hasPreviousSelection = previousSelectedIds.size > 0;
    const nextTabs = response.tabs.map((tab) => ({
      ...tab,
      selected: hasPreviousSelection ? previousSelectedIds.has(tab.tabId) : tab.active,
    }));
    const hasSelection = nextTabs.some((tab) => tab.selected);

    return {
      contextTabs: hasSelection ? nextTabs : nextTabs.map((tab, index) => ({ ...tab, selected: index === 0 })),
      contextTabsLoading: false,
      contextTabsError: undefined,
    };
  });
}

export function toggleContextTabSelectionAction(input: { tabId: number; get: StoreGetter; set: StoreSetter }): void {
  input.set((state) => ({
    contextTabs: state.contextTabs.map((tab) => (tab.tabId === input.tabId ? { ...tab, selected: !tab.selected, error: undefined } : tab)),
  }));
  void input.get().refreshPageContext();
}

export async function refreshPageContextAction(input: { get: StoreGetter; set: StoreSetter }): Promise<void> {
  const requestedContextMode = input.get().contextMode;
  const requestId = ++pageContextRefreshSequence;
  const selectedTabs = input.get().contextTabs.filter((tab) => tab.selected);
  input.set((state) => ({
    pageContext: {
      ...state.pageContext,
      extractMode: requestedContextMode,
      loading: true,
      error: undefined,
    },
    contextTabs: state.contextTabs.map((tab) => (tab.selected ? { ...tab, loading: true, error: undefined } : { ...tab, loading: false })),
  }));

  const extractContext = (tabId?: number) =>
    sendRuntimeMessage<ExtractPageContextSuccessResponse | ExtractPageContextFailureResponse | undefined>({
      type: "pageContext.extract",
      tabId,
      rules: input.get().extractionRules as ExtractionRule[],
      maxLength: undefined,
      extractMode: requestedContextMode as PageContextExtractMode,
    });

  const responses = selectedTabs.length > 0
    ? await Promise.all(selectedTabs.map(async (tab) => ({ tab, response: await extractContext(tab.tabId) })))
    : [{ tab: undefined, response: await extractContext() }];

  if (requestId !== pageContextRefreshSequence) {
    return;
  }

  const successfulResponses = responses.filter((item): item is { tab?: ContextTabCandidate; response: ExtractPageContextSuccessResponse } =>
    Boolean(item.response?.ok),
  );
  const failedResponses = responses.filter((item) => !item.response?.ok);

  if (successfulResponses.length === 0) {
    const firstFailedResponse = failedResponses[0]?.response;
    input.set((state) => ({
      pageContext: {
        ...state.pageContext,
        text: "",
        truncated: false,
        usedFallback: true,
        loading: false,
        error: firstFailedResponse && "message" in firstFailedResponse ? firstFailedResponse.message ?? "提取当前页面失败" : "提取当前页面失败",
      },
      contextTabs: mergeContextTabErrors(state.contextTabs, failedResponses),
    }));
    return;
  }

  const shouldUseFormattedContext = selectedTabs.length > 1 || successfulResponses.length > 1;
  const mergedText = shouldUseFormattedContext
    ? successfulResponses.map(({ response }) => createPageContextPrompt(response)).filter(Boolean).join("\n\n---\n\n")
    : successfulResponses[0]?.response.text ?? "";
  const firstSuccess = successfulResponses[0]?.response;
  input.set((state) => ({
    pageContext: {
      loading: false,
      url: successfulResponses.length === 1 ? firstSuccess.url : undefined,
      title: successfulResponses.length === 1 ? firstSuccess.title : `${successfulResponses.length} 个标签页`,
      text: mergedText,
      formatted: shouldUseFormattedContext,
      extractMode: requestedContextMode,
      truncated: successfulResponses.some(({ response }) => response.truncated),
      usedFallback: successfulResponses.some(({ response }) => response.usedFallback),
      matchedRuleId: successfulResponses.length === 1 ? firstSuccess.matchedRuleId : undefined,
      error: failedResponses.length > 0 ? "部分标签页提取失败，已跳过失败项" : undefined,
    },
    contextTabs: mergeContextTabErrors(state.contextTabs, failedResponses).map((tab) =>
      successfulResponses.some((item) => item.tab?.tabId === tab.tabId) ? { ...tab, loading: false, error: undefined } : tab,
    ),
  }));
}

function mergeContextTabErrors(
  tabs: ContextTabCandidate[],
  failedResponses: Array<{ tab?: ContextTabCandidate; response?: ExtractPageContextSuccessResponse | ExtractPageContextFailureResponse }>,
): ContextTabCandidate[] {
  const errorByTabId = new Map<number, string>();
  for (const item of failedResponses) {
    if (item.tab) {
      errorByTabId.set(item.tab.tabId, item.response && "message" in item.response ? item.response.message ?? "提取失败" : "提取失败");
    }
  }

  return tabs.map((tab) => ({
    ...tab,
    loading: false,
    error: errorByTabId.get(tab.tabId),
  }));
}
