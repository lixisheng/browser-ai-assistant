import { useMemo, useState } from "react";
import type { ExtractionRule } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { formatModelLabelWithVision } from "../ModelVisionIndicator";

const DEBUG_PREFIX = "[提取规则 AI 生成诊断]";



export function ExtractionRules() {
  const rules = useAppStore((state) => state.extractionRules);
  const providers = useAppStore((state) => state.providers);
  const models = useAppStore((state) => state.models);
  const pageContext = useAppStore((state) => state.pageContext);
  const saveRuleDraft = useAppStore((state) => state.saveRuleDraft);
  const deleteRule = useAppStore((state) => state.deleteRule);
  const moveRule = useAppStore((state) => state.moveRule);
  const generateUrlPatterns = useAppStore((state) => state.generateUrlPatterns);
  const [expandedRuleId, setExpandedRuleId] = useState<string>();
  const [draft, setDraft] = useState<Pick<ExtractionRule, "alias" | "urlPattern" | "selectorsText">>({
    alias: "",
    urlPattern: "",
    selectorsText: "",
  });
  const [editingRuleId, setEditingRuleId] = useState<string>();
  const [validationMessage, setValidationMessage] = useState("");
  const [generatedPatterns, setGeneratedPatterns] = useState<string[]>([]);
  const [generationMessage, setGenerationMessage] = useState("");
  const [generatingPatterns, setGeneratingPatterns] = useState(false);
  const [showGenerationModels, setShowGenerationModels] = useState(false);
  const matchedRuleId = pageContext.matchedRuleId;
  const orderedRules = useMemo(() => {
    const matchedRules = rules.filter((rule) => rule.id === matchedRuleId);
    const otherRules = rules.filter((rule) => rule.id !== matchedRuleId);
    return [...matchedRules, ...otherRules];
  }, [matchedRuleId, rules]);
  const generationModels = useMemo(
    () =>
      models
        .map((model) => {
          const provider = providers.find((item) => item.id === model.providerId);
          return provider
            ? {
                id: model.id,
                label: formatModelLabelWithVision(`${provider.name} / ${model.displayName}`, model.supportsVision),
              }
            : undefined;
        })
        .filter((item): item is { id: string; label: string } => Boolean(item)),
    [models, providers],
  );
  const openRule = (rule: ExtractionRule) => {
    setExpandedRuleId(rule.id);
    setEditingRuleId(rule.id);
    setDraft({
      alias: rule.alias,
      urlPattern: rule.urlPattern,
      selectorsText: rule.selectorsText,
    });
    setValidationMessage("");
    setGeneratedPatterns([]);
    setGenerationMessage("");
    setShowGenerationModels(false);
  };
  const createDraft = () => {
    setExpandedRuleId("draft-rule");
    setEditingRuleId(undefined);
    setDraft({
      alias: "",
      urlPattern: "",
      selectorsText: "",
    });
    setValidationMessage("");
    setGeneratedPatterns([]);
    setGenerationMessage("");
    setShowGenerationModels(false);
  };
  const handleSave = async () => {
    const result = await saveRuleDraft(editingRuleId, draft);
    if (!result.ok) {
      setValidationMessage(result.message);
      return;
    }

    setExpandedRuleId(result.rule.id);
    setEditingRuleId(result.rule.id);
    setDraft({
      alias: result.rule.alias,
      urlPattern: result.rule.urlPattern,
      selectorsText: result.rule.selectorsText,
    });
    setValidationMessage("");
  };
  const handleOpenGenerationModels = () => {
    console.debug(`${DEBUG_PREFIX} 用户点击 AI 生成，准备展示模型选择`, {
      modelCount: generationModels.length,
      models: generationModels,
      pageContextUrl: pageContext.url,
    });
    setGeneratedPatterns([]);
    setGenerationMessage("");
    setShowGenerationModels(true);
  };
  const handleGeneratePatterns = async (modelId: string) => {
    console.debug(`${DEBUG_PREFIX} 用户选择模型开始生成`, {
      modelId,
      pageContextUrl: pageContext.url,
    });
    setGeneratingPatterns(true);
    setGenerationMessage("");
    setGeneratedPatterns([]);

    const result = await generateUrlPatterns(modelId);
    console.debug(`${DEBUG_PREFIX} UI 收到生成结果`, {
      ok: result.ok,
      patternCount: result.ok ? result.patterns.length : 0,
      message: result.ok ? undefined : result.message,
    });
    setGeneratingPatterns(false);

    if (!result.ok) {
      setGenerationMessage(result.message);
      return;
    }

    setGeneratedPatterns(result.patterns);
    setShowGenerationModels(false);
  };
  const handleDelete = async () => {
    if (!editingRuleId) {
      setExpandedRuleId(undefined);
      return;
    }

    if (!window.confirm("确认删除这条提取规则吗？")) {
      return;
    }

    await deleteRule(editingRuleId);
    setExpandedRuleId(undefined);
    setEditingRuleId(undefined);
  };

  return (
    <section className="grid w-full gap-3" aria-label="提取规则">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">提取规则</h3>
        <button className="ui-button-secondary" type="button" onClick={createDraft}>
          新增规则
        </button>
      </div>
      <div className="grid gap-2">
        {orderedRules.map((rule) => {
          const matched = rule.id === matchedRuleId;
          const expanded = rule.id === expandedRuleId;

          return (
            <article
              key={rule.id}
              className={[
                "rounded-lg border bg-[var(--color-canvas)] p-2",
                matched ? "border-[var(--color-primary)]" : "border-[var(--color-hairline)]",
              ].join(" ")}
            >
              <div className="flex gap-2">
                <button
                  className="min-w-0 flex-1 text-left"
                  type="button"
                  onClick={() => openRule(rule)}
                >
                  {rule.alias ? <span className="block truncate text-sm font-medium">{rule.alias}</span> : null}
                  <span className="ui-muted block truncate text-xs">{rule.urlPattern}</span>
                </button>
                <div className="flex shrink-0 gap-1">
                  <button className="ui-button-secondary px-2 py-1" type="button" onClick={() => void moveRule(rule.id, "up")}>
                    上移
                  </button>
                  <button className="ui-button-secondary px-2 py-1" type="button" onClick={() => void moveRule(rule.id, "down")}>
                    下移
                  </button>
                </div>
              </div>
              {expanded ? (
                <RuleEditor
                  draft={draft}
                  validationMessage={validationMessage}
                  onChange={setDraft}
                  generatedPatterns={generatedPatterns}
                  generationMessage={generationMessage}
                  generatingPatterns={generatingPatterns}
                  showGenerationModels={showGenerationModels}
                  generationModels={generationModels}
                  onOpenGenerationModels={handleOpenGenerationModels}
                  onGeneratePatterns={(modelId) => void handleGeneratePatterns(modelId)}
                  onSave={() => void handleSave()}
                  onDelete={() => void handleDelete()}
                />
              ) : null}
            </article>
          );
        })}
        {expandedRuleId === "draft-rule" ? (
          <article className="rounded-lg border border-[var(--color-primary)] bg-[var(--color-canvas)] p-2">
            <RuleEditor
              draft={draft}
              validationMessage={validationMessage}
              onChange={setDraft}
              generatedPatterns={generatedPatterns}
              generationMessage={generationMessage}
              generatingPatterns={generatingPatterns}
              showGenerationModels={showGenerationModels}
              generationModels={generationModels}
              onOpenGenerationModels={handleOpenGenerationModels}
              onGeneratePatterns={(modelId) => void handleGeneratePatterns(modelId)}
              onSave={() => void handleSave()}
              onDelete={() => void handleDelete()}
            />
          </article>
        ) : null}
      </div>
    </section>
  );
}

interface RuleEditorProps {
  draft: Pick<ExtractionRule, "alias" | "urlPattern" | "selectorsText">;
  validationMessage: string;
  generatedPatterns: string[];
  generationMessage: string;
  generatingPatterns: boolean;
  showGenerationModels: boolean;
  generationModels: Array<{ id: string; label: string }>;
  onChange: (draft: Pick<ExtractionRule, "alias" | "urlPattern" | "selectorsText">) => void;
  onOpenGenerationModels: () => void;
  onGeneratePatterns: (modelId: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

function RuleEditor({
  draft,
  validationMessage,
  generatedPatterns,
  generationMessage,
  generatingPatterns,
  showGenerationModels,
  generationModels,
  onChange,
  onOpenGenerationModels,
  onGeneratePatterns,
  onSave,
  onDelete,
}: RuleEditorProps) {
  return (
    <div className="mt-3 grid gap-3 border-t border-[var(--color-hairline)] pt-3">
      <label className="grid gap-1 text-sm">
        规则别名
        <input
          className="ui-input"
          aria-label="规则别名"
          value={draft.alias}
          onChange={(event) => onChange({ ...draft, alias: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        URL 正则
        <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <input
            className="ui-input min-w-0"
            aria-label="URL 正则"
            value={draft.urlPattern}
            onChange={(event) => onChange({ ...draft, urlPattern: event.target.value })}
          />
          <button className="ui-button-secondary whitespace-nowrap" type="button" onClick={onOpenGenerationModels} disabled={generatingPatterns}>
            AI 生成
          </button>
        </span>
      </label>
      {generationMessage ? <p className="text-sm text-[var(--color-error)]">{generationMessage}</p> : null}
      {showGenerationModels ? (
        <div className="grid gap-2 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-soft)] p-2">
          <p className="text-sm font-medium">选择用于生成的模型</p>
          {generationModels.length > 0 ? (
            <div className="grid gap-1">
              {generationModels.map((model) => (
                <button
                  key={model.id}
                  className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-left text-sm text-[var(--color-ink)]"
                  type="button"
                  onClick={() => onGeneratePatterns(model.id)}
                  disabled={generatingPatterns}
                >
                  {model.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-error)]">请先配置模型后再使用 AI 生成</p>
          )}
        </div>
      ) : null}
      {generatedPatterns.length > 0 ? (
        <div className="grid gap-1 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-soft)] p-2">
          {generatedPatterns.map((pattern) => (
            <button
              key={pattern}
              className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-left text-xs text-[var(--color-ink)]"
              type="button"
              onClick={() => onChange({ ...draft, urlPattern: pattern })}
            >
              {pattern}
            </button>
          ))}
        </div>
      ) : null}
      <label className="grid gap-1 text-sm">
        CSS/XPath 列表
        <textarea
          className="ui-input min-h-24"
          aria-label="CSS/XPath 列表"
          value={draft.selectorsText}
          onChange={(event) => onChange({ ...draft, selectorsText: event.target.value })}
        />
      </label>
      {validationMessage ? <p className="text-sm text-[var(--color-error)]">{validationMessage}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="ui-button-primary" type="button" onClick={onSave}>
          保存规则
        </button>
        <button className="ui-button-secondary" type="button" onClick={onDelete}>
          删除规则
        </button>
      </div>
    </div>
  );
}
