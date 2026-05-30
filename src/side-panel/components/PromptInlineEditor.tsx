import { useLayoutEffect, useRef } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ChatPromptInvocation } from "../../shared/types";

interface PromptInlineEditorProps {
  ariaLabel: string;
  className?: string;
  value: string;
  promptInvocations: ChatPromptInvocation[];
  promptAriaLabelPrefix: string;
  onChange: (value: string) => void;
  onRemovePrompt: (index: number) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPaste?: (event: ReactClipboardEvent<HTMLElement>) => void;
  onCompositionStart?: (event: ReactCompositionEvent<HTMLElement>) => void;
  onCompositionEnd?: (value: string, event: ReactCompositionEvent<HTMLElement>) => void;
}

export function PromptInlineEditor({
  ariaLabel,
  className,
  value,
  promptInvocations,
  promptAriaLabelPrefix,
  onChange,
  onRemovePrompt,
  onKeyDown,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
}: PromptInlineEditorProps) {
  const editorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.textContent === value) {
      return;
    }

    editor.textContent = value;
    placeCaretAtEnd(editor);
  }, [value]);

  const readValue = () => editorRef.current?.textContent ?? "";

  const syncValueFromDom = () => {
    onChange(readValue());
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Backspace" && promptInvocations.length > 0 && isSelectionAtTextStart(editorRef.current)) {
      event.preventDefault();
      onRemovePrompt(promptInvocations.length - 1);
      return;
    }

    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }

    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      insertTextAtSelection("\n");
      syncValueFromDom();
    }
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented) {
      return;
    }

    const plainText = event.clipboardData.getData("text/plain");
    if (!plainText) {
      return;
    }

    event.preventDefault();
    insertTextAtSelection(plainText);
    syncValueFromDom();
  };

  return (
    <div className={`prompt-inline-editor${className ? ` ${className}` : ""}`} onClick={() => editorRef.current?.focus()}>
      {promptInvocations.map((prompt, index) => (
        <button
          key={`${prompt.promptId}-${index}`}
          className="prompt-token-link"
          type="button"
          aria-label={`${promptAriaLabelPrefix}：${prompt.title}`}
          contentEditable={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRemovePrompt(index)}
        >
          <PromptTokenContent title={prompt.title} />
        </button>
      ))}
      <span
        ref={editorRef}
        className="prompt-inline-editor-text"
        role="textbox"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
        onInput={syncValueFromDom}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={(event) => onCompositionEnd?.(readValue(), event)}
      />
    </div>
  );
}

export function PromptTokenContent({ title }: { title: string }) {
  return (
    <>
      <span className="prompt-token-icon" aria-hidden="true">
        ◈
      </span>
      <span className="prompt-token-title">{title}</span>
    </>
  );
}

function isSelectionAtTextStart(editor: HTMLElement | null): boolean {
  if (!editor) {
    return false;
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return editor.textContent?.length === 0;
  }

  const range = selection.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.startContainer)) {
    return false;
  }

  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(editor);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  return prefixRange.toString().length === 0;
}

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertTextAtSelection(text: string) {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
