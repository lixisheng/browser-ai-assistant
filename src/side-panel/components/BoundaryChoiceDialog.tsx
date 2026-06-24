import { useState } from "react";
import type { BrowserControlBoundaryChoiceRequestMessage } from "../../shared/browserControl";

interface BoundaryChoiceDialogProps {
  request: BrowserControlBoundaryChoiceRequestMessage;
  onSubmit: (selectedChoiceIds: string[], otherText?: string) => void;
}

export function BoundaryChoiceDialog({ request, onSubmit }: BoundaryChoiceDialogProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const expired = Date.now() >= request.expiresAt;
  const hasSelection = selectedIds.length > 0 || otherText.trim().length > 0;
  const toggleChoice = (choiceId: string) => {
    if (submitting) {
      return;
    }
    setSelectedIds((current) => {
      if (request.allowMultiple) {
        return current.includes(choiceId) ? current.filter((id) => id !== choiceId) : [...current, choiceId];
      }
      return current.includes(choiceId) ? [] : [choiceId];
    });
  };
  const submit = () => {
    if (submitting || expired || !hasSelection) {
      return;
    }
    setSubmitting(true);
    const trimmedOther = otherText.trim();
    onSubmit(selectedIds, trimmedOther || undefined);
  };
  const cancel = () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    onSubmit([], "用户取消本次边界确认。");
  };

  return (
    <>
      <div className="dialog-overlay" aria-hidden="true" />
      <section className="boundary-choice-dialog" role="dialog" aria-modal="true" aria-label="AI 边界确认">
        <div className="boundary-choice-header">
          <h2 className="boundary-choice-title">{request.question}</h2>
          <p className="boundary-choice-reason">{request.reason}</p>
        </div>
        <div className="boundary-choice-list">
          {request.choices.map((choice) => (
            <button
              key={choice.id}
              className={selectedIds.includes(choice.id) ? "boundary-choice-item boundary-choice-item-active" : "boundary-choice-item"}
              type="button"
              aria-pressed={selectedIds.includes(choice.id)}
              disabled={submitting}
              onClick={() => toggleChoice(choice.id)}
            >
              <span className="boundary-choice-row">
                <span className="boundary-choice-option-title">{choice.title}</span>
                <span className={`boundary-choice-risk boundary-choice-risk-${choice.risk}`}>{choice.risk}</span>
              </span>
              <span className="boundary-choice-description">{choice.description}</span>
              <span className="boundary-choice-grants">授权：{choice.grants.length} 项</span>
            </button>
          ))}
        </div>
        <label className="boundary-choice-other">
          <span>其他</span>
          <textarea
            className="ui-input boundary-choice-other-input"
            value={otherText}
            disabled={submitting}
            onChange={(event) => setOtherText(event.target.value)}
            placeholder="补充要求，不会直接授权。"
          />
        </label>
        <div className="boundary-choice-actions">
          <button className="ui-button-secondary boundary-choice-action-button" type="button" disabled={submitting} onClick={cancel}>
            取消
          </button>
          <button className="ui-button-primary boundary-choice-action-button" type="button" disabled={submitting || expired || !hasSelection} onClick={submit}>
            提交选择
          </button>
        </div>
      </section>
    </>
  );
}
