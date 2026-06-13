import { useState } from "react";
import type { DragEvent } from "react";
import type { PromptTemplate } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";

export function PromptTemplateSettings() {
  const promptTemplates = useAppStore((state) => state.promptTemplates);
  const savePromptTemplateDraft = useAppStore((state) => state.savePromptTemplateDraft);
  const deletePrompt = useAppStore((state) => state.deletePrompt);
  const reorderPromptTemplates = useAppStore((state) => state.reorderPromptTemplates);
  const [expandedPromptId, setExpandedPromptId] = useState<string>();
  const [editingPromptId, setEditingPromptId] = useState<string>();
  const [draft, setDraft] = useState<Pick<PromptTemplate, "title" | "content">>({ title: "", content: "" });
  const [validationMessage, setValidationMessage] = useState("");
  const [draggingPromptId, setDraggingPromptId] = useState<string>();

  const openPrompt = (prompt: PromptTemplate) => {
    setExpandedPromptId(prompt.id);
    setEditingPromptId(prompt.id);
    setDraft({ title: prompt.title, content: prompt.content });
    setValidationMessage("");
  };
  const createDraft = () => {
    setExpandedPromptId("draft-prompt");
    setEditingPromptId(undefined);
    setDraft({ title: "", content: "" });
    setValidationMessage("");
  };
  const handleSave = async () => {
    const result = await savePromptTemplateDraft(editingPromptId, draft);
    if (!result.ok) {
      setValidationMessage(result.message);
      return;
    }

    setExpandedPromptId(result.prompt.id);
    setEditingPromptId(result.prompt.id);
    setDraft({ title: result.prompt.title, content: result.prompt.content });
    setValidationMessage("");
  };
  const handleDelete = async () => {
    if (!editingPromptId) {
      setExpandedPromptId(undefined);
      return;
    }

    if (!window.confirm("确认删除这条提示词吗？")) {
      return;
    }

    await deletePrompt(editingPromptId);
    setExpandedPromptId(undefined);
    setEditingPromptId(undefined);
    setDraft({ title: "", content: "" });
  };
  const handleDrop = (targetPromptId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const sourcePromptId = draggingPromptId ?? event.dataTransfer.getData("text/plain").trim();
    setDraggingPromptId(undefined);
    if (!sourcePromptId || sourcePromptId === targetPromptId) {
      return;
    }

    const currentIds = promptTemplates.map((prompt) => prompt.id);
    const sourceIndex = currentIds.indexOf(sourcePromptId);
    const targetIndex = currentIds.indexOf(targetPromptId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }

    const nextIds = [...currentIds];
    nextIds.splice(sourceIndex, 1);
    nextIds.splice(targetIndex, 0, sourcePromptId);
    void reorderPromptTemplates(nextIds);
  };

  return (
    <section className="grid w-full gap-3" aria-label="提示词">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">提示词</h3>
        <button className="ui-button-secondary" type="button" onClick={createDraft}>
          新增提示词
        </button>
      </div>
      {promptTemplates.length === 0 && expandedPromptId !== "draft-prompt" ? (
        <p className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-soft)] p-3 text-sm text-[var(--color-muted)]">
          暂无提示词
        </p>
      ) : null}
      <div className="grid gap-2">
        {promptTemplates.map((prompt) => {
          const expanded = prompt.id === expandedPromptId;

          return (
            <article
              key={prompt.id}
              className="prompt-template-card rounded-lg border border-[var(--color-hairline)] bg-[var(--color-canvas)] p-2"
              draggable
              onDragStart={(event) => {
                setDraggingPromptId(prompt.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", prompt.id);
              }}
              onDragEnd={() => setDraggingPromptId(undefined)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(prompt.id, event)}
            >
              <button className="min-w-0 text-left" type="button" onClick={() => openPrompt(prompt)}>
                <span className="block truncate text-sm font-medium">{prompt.title}</span>
                <span className="prompt-template-preview ui-muted mt-1 text-xs">{prompt.content}</span>
              </button>
              {expanded ? (
                <PromptTemplateEditor
                  draft={draft}
                  validationMessage={validationMessage}
                  onChange={setDraft}
                  onSave={() => void handleSave()}
                  onDelete={() => void handleDelete()}
                />
              ) : null}
            </article>
          );
        })}
        {expandedPromptId === "draft-prompt" ? (
          <article className="rounded-lg border border-[var(--color-primary)] bg-[var(--color-canvas)] p-2">
            <PromptTemplateEditor
              draft={draft}
              validationMessage={validationMessage}
              onChange={setDraft}
              onSave={() => void handleSave()}
              onDelete={() => void handleDelete()}
            />
          </article>
        ) : null}
      </div>
    </section>
  );
}

interface PromptTemplateEditorProps {
  draft: Pick<PromptTemplate, "title" | "content">;
  validationMessage: string;
  onChange: (draft: Pick<PromptTemplate, "title" | "content">) => void;
  onSave: () => void;
  onDelete: () => void;
}

function PromptTemplateEditor({ draft, validationMessage, onChange, onSave, onDelete }: PromptTemplateEditorProps) {
  return (
    <div className="mt-3 grid gap-3 border-t border-[var(--color-hairline)] pt-3">
      <label className="grid gap-1 text-sm">
        提示词标题
        <input
          className="ui-input"
          aria-label="提示词标题"
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Prompt 内容
        <textarea
          className="ui-input min-h-32"
          aria-label="Prompt 内容"
          value={draft.content}
          onChange={(event) => onChange({ ...draft, content: event.target.value })}
        />
      </label>
      {validationMessage ? <p className="text-sm text-[var(--color-error)]">{validationMessage}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="ui-button-primary" type="button" onClick={onSave}>
          保存提示词
        </button>
        <button className="ui-button-secondary" type="button" onClick={onDelete}>
          删除提示词
        </button>
      </div>
    </div>
  );
}
