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
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedProvider = providers.find((provider) => provider.id === selectedModel?.providerId);
  const canSend = Boolean(selectedModel?.enabled && selectedProvider?.enabled);

  return (
    <section className="flex flex-1 flex-col gap-4">
      <ModelSelector />
      <MessageList />
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
