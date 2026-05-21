import { MessageList } from "./MessageList";
import { ModelSelector } from "./ModelSelector";
import { useAppStore } from "../state/appStore";

export function ChatPanel() {
  const providers = useAppStore((state) => state.providers);
  const models = useAppStore((state) => state.models);
  const selectedModelId = useAppStore((state) => state.selectedModelId);
  const failure = useAppStore((state) => state.failure);
  const addExampleModel = useAppStore((state) => state.addExampleModel);
  const simulateFailure = useAppStore((state) => state.simulateFailure);
  const clearFailure = useAppStore((state) => state.clearFailure);
  const pageContext = useAppStore((state) => state.pageContext);
  const extractionRules = useAppStore((state) => state.extractionRules);
  const refreshPageContext = useAppStore((state) => state.refreshPageContext);
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const matchedRule = extractionRules.find((rule) => rule.id === pageContext.matchedRuleId);
  const canSend = Boolean(selectedModel?.enabled && selectedProvider?.enabled);

  return (
    <section className="flex flex-1 flex-col gap-4">
      <ModelSelector />
      <MessageList />
      <section className="ui-panel grid gap-2" aria-label="当前页上下文">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {pageContext.loading
              ? "正在提取当前页"
              : matchedRule
                ? `已匹配规则：${matchedRule.alias || matchedRule.urlPattern}`
                : pageContext.usedFallback
                  ? "使用全局提取"
                  : "已提取当前页"}
          </p>
          <button className="ui-button-secondary px-3 py-1" type="button" onClick={() => void refreshPageContext()}>
            刷新
          </button>
        </div>
        {pageContext.truncated ? <p className="text-sm text-[var(--color-warning)]">内容已截断，请细化 CSS/XPath</p> : null}
        {pageContext.error ? <p className="text-sm text-[var(--color-error)]">{pageContext.error}</p> : null}
        {pageContext.text ? (
          <details className="text-sm">
            <summary className="cursor-pointer select-none text-[var(--color-primary)]">查看上下文</summary>
            <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-surface-soft)] p-2 text-[var(--color-body)]">
              {pageContext.text}
            </p>
          </details>
        ) : null}
      </section>
      {providers.length === 0 || models.length === 0 ? <p className="text-sm" style={{ color: "var(--color-warning)" }}>请先配置 API Key 后再开始对话</p> : null}
      {failure ? (
        <div className="rounded-lg p-3 text-sm" style={{ background: "#fff4ef", border: "1px solid color-mix(in srgb, var(--color-error) 32%, white)", color: "var(--color-error)" }}>
          <p>{failure.message}</p>
          <button className="ui-button-secondary mt-2 px-3 py-1" type="button" onClick={clearFailure}>
            重试
          </button>
        </div>
      ) : null}
      <textarea className="ui-input min-h-24 p-3" aria-label="对话输入" />
      <div className="flex gap-2">
        <button className="ui-button-primary" type="button" disabled={!canSend}>
          发送
        </button>
        <button className="ui-button-secondary px-4" type="button" onClick={addExampleModel}>
          添加示例模型
        </button>
        <button className="ui-button-secondary px-4" type="button" onClick={simulateFailure}>
          模拟失败
        </button>
      </div>
    </section>
  );
}
