import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CompositionEvent } from "react";

type ComposedTextElement = HTMLInputElement | HTMLTextAreaElement;

interface ComposedTextInputHandlers {
  value: string;
  onChange: (event: ChangeEvent<ComposedTextElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<ComposedTextElement>) => void;
}

/**
 * 为受控 textarea 提供中文输入法安全的本地草稿。
 *
 * 中文输入法组合输入期间不能提交拼音中间态，否则异步持久化后的旧草稿可能回写到界面，
 * 导致用户按空格选词后仍残留 shizhong 之类的拼音字符。
 */
export function useComposedTextInput(value: string, onCommit: (value: string) => void): ComposedTextInputHandlers {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!composingRef.current) {
      setDraft(value);
    }
  }, [value]);

  return {
    value: draft,
    onChange: (event) => {
      const nextValue = event.target.value;
      setDraft(nextValue);

      if (!composingRef.current) {
        onCommit(nextValue);
      }
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: (event) => {
      const nextValue = event.currentTarget.value;
      composingRef.current = false;
      setDraft(nextValue);
      onCommit(nextValue);
    },
  };
}
