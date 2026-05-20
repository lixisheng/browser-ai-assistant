import { useAppStore } from "../state/appStore";

export function ModelSelector() {
  const providers = useAppStore((state) => state.providers);
  const models = useAppStore((state) => state.models);
  const selectedModelId = useAppStore((state) => state.selectedModelId);
  const streamMode = useAppStore((state) => state.streamMode);
  const selectModel = useAppStore((state) => state.selectModel);
  const setStreamMode = useAppStore((state) => state.setStreamMode);
  const selectableModels = models
    .map((model) => {
      const provider = providers.find((item) => item.id === model.providerId);
      return provider && provider.enabled && model.enabled
        ? {
            id: model.id,
            label: `${provider.name} / ${model.displayName}`,
          }
        : undefined;
    })
    .filter((model): model is { id: string; label: string } => Boolean(model));

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        当前模型
        <select
          className="ui-input"
          value={selectedModelId}
          onChange={(event) => selectModel(event.target.value)}
        >
          <option value="">未选择模型</option>
          {selectableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={streamMode}
          onChange={(event) => setStreamMode(event.target.checked)}
        />
        流式响应
      </label>
    </div>
  );
}
