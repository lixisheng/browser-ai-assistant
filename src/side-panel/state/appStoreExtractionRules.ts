import { generateUrlPatternsWithModel } from "../../shared/extractionRules/urlPatternGeneration";
import { validateExtractionRuleDraft } from "../../shared/extractionRules/validation";
import {
  deleteExtractionRule,
  getExtractionRules,
  moveExtractionRule,
  saveExtractionRule,
} from "../../shared/storage/repositories";
import type { ExtractionRule } from "../../shared/types";
import type { StoreGetter, StoreSetter } from "./appStore";
import { sendRuntimeMessage } from "./runtimeMessage";

const DEBUG_PREFIX = "[提取规则 AI 生成诊断]";

export async function loadExtractionRulesAction(input: { set: StoreSetter }): Promise<void> {
  const extractionRules = await getExtractionRules();
  input.set({ extractionRules });
}

export async function saveRuleDraftAction(input: {
  ruleId: string | undefined;
  draft: Pick<ExtractionRule, "alias" | "urlPattern" | "selectorsText">;
  get: StoreGetter;
}): Promise<{ ok: true; rule: ExtractionRule } | { ok: false; message: string }> {
  const validation = validateExtractionRuleDraft(input.draft);
  if (!validation.ok) {
    return validation;
  }

  const now = Date.now();
  const existingRule = input.ruleId ? input.get().extractionRules.find((rule) => rule.id === input.ruleId) : undefined;
  const nextSortOrder =
    existingRule?.sortOrder ?? Math.max(0, ...input.get().extractionRules.map((rule) => rule.sortOrder)) + 10;
  const rule: ExtractionRule = {
    id: existingRule?.id ?? `rule-${now}`,
    alias: input.draft.alias.trim(),
    urlPattern: input.draft.urlPattern.trim(),
    selectorsText: input.draft.selectorsText.trim(),
    sortOrder: nextSortOrder,
    createdAt: existingRule?.createdAt ?? now,
    updatedAt: now,
  };

  await saveExtractionRule(rule);
  await input.get().loadExtractionRules();
  void input.get().refreshPageContext();
  return { ok: true, rule };
}

export async function deleteRuleAction(input: { ruleId: string; get: StoreGetter }): Promise<void> {
  await deleteExtractionRule(input.ruleId);
  await input.get().loadExtractionRules();
  void input.get().refreshPageContext();
}

export async function moveRuleAction(input: { ruleId: string; direction: "up" | "down"; get: StoreGetter }): Promise<void> {
  await moveExtractionRule(input.ruleId, input.direction);
  await input.get().loadExtractionRules();
  void input.get().refreshPageContext();
}

export async function generateUrlPatternsAction(input: {
  modelId?: string;
  get: StoreGetter;
}): Promise<{ ok: true; patterns: string[] } | { ok: false; message: string }> {
  const state = input.get();
  const debugRequestId = `url-pattern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.debug(`${DEBUG_PREFIX} 前端开始生成 URL 正则`, {
    debugRequestId,
    requestedModelId: input.modelId,
    providerCount: state.providers.length,
    modelCount: state.models.length,
    selectedModelId: state.selectedModelId,
    pageContextUrl: state.pageContext.url,
  });

  const model = input.modelId
    ? state.models.find((item) => item.id === input.modelId)
    : state.models.find((item) => item.id === state.selectedModelId) ?? state.models.find((item) => item.enabled);
  const provider = model ? state.providers.find((item) => item.id === model.providerId) : undefined;
  if (!provider || !model) {
    console.warn(`${DEBUG_PREFIX} 前端未找到可用模型或渠道`, {
      debugRequestId,
      requestedModelId: input.modelId,
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
    const response = await generateUrlPatternsWithModel(provider, model, urlResult.url, fetch, state.chatPreferences.aiRequestRetryCount);

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
}

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
