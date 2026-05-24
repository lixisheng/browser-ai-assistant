import { useEffect, useId, useState } from "react";
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { isPngDataUrl, isTabCaptureImageAttachment, TAB_CAPTURE_VISIBLE_MESSAGE_TYPE, type TabCaptureVisibleResponse } from "../../shared/tabCapture";
import type { ChatImageAttachment, SendShortcut } from "../../shared/types";
import { useAppStore } from "../state/appStore";

const MAX_IMAGE_ATTACHMENTS = 5;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

interface ChatComposerProps {
  canSend: boolean;
  matchedRuleLabel: string;
}

interface ComposerSwitchProps {
  ariaLabel: string;
  checked: boolean;
  label: string;
  onToggle: () => void;
}

function ComposerSwitch({ ariaLabel, checked, label, onToggle }: ComposerSwitchProps) {
  return (
    <button className="composer-switch" type="button" role="switch" aria-label={ariaLabel} aria-checked={checked} onClick={onToggle}>
      <span className="composer-switch-track" aria-hidden="true">
        <span className="composer-switch-thumb" />
      </span>
      <span aria-hidden={ariaLabel !== label}>{label}</span>
    </button>
  );
}

export function ChatComposer({ canSend, matchedRuleLabel }: ChatComposerProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [previewAttachment, setPreviewAttachment] = useState<ChatImageAttachment | undefined>();
  const [contextDialogOpen, setContextDialogOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const imageInputId = useId();
  const currentModelSupportsVision = useAppStore((state) => Boolean(state.models.find((model) => model.id === state.selectedModelId)?.supportsVision));
  const sendShortcut = useAppStore((state) => state.chatPreferences.sendShortcut);
  const streamMode = useAppStore((state) => state.streamMode);
  const contextMode = useAppStore((state) => state.contextMode);
  const appendPageContextToSystemPrompt = useAppStore((state) => state.appendPageContextToSystemPrompt);
  const sending = useAppStore((state) => state.sending);
  const pageContext = useAppStore((state) => state.pageContext);
  const setStreamMode = useAppStore((state) => state.setStreamMode);
  const setContextMode = useAppStore((state) => state.setContextMode);
  const setComposerHasDraft = useAppStore((state) => state.setComposerHasDraft);
  const setAppendPageContextToSystemPrompt = useAppStore((state) => state.setAppendPageContextToSystemPrompt);
  const refreshPageContext = useAppStore((state) => state.refreshPageContext);
  const sendChatMessage = useAppStore((state) => state.sendChatMessage);

  useEffect(() => {
    setComposerHasDraft(input.trim().length > 0 || attachments.length > 0);
  }, [attachments.length, input, setComposerHasDraft]);

  useEffect(() => {
    if (!contextDialogOpen) {
      return undefined;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextDialogOpen(false);
      }
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [contextDialogOpen]);

  const submit = async () => {
    const content = input.trim();
    if (!content && attachments.length === 0) {
      return;
    }

    setInput("");
    const sendingAttachments = attachments;
    setAttachments([]);
    setAttachmentError("");
    await sendChatMessage(content, sendingAttachments);
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composing || !isSendShortcut(event, sendShortcut)) {
      return;
    }

    event.preventDefault();
    if (!canSend || sending || (!input.trim() && attachments.length === 0)) {
      return;
    }

    void submit();
  };

  const handleImageInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    void addImageFiles(Array.from(event.target.files ?? [])).catch(() => {
      setAttachmentError("图片读取失败，请重新选择图片");
    });
    event.target.value = "";
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = getPastedImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void addImageFiles(files).catch(() => {
      setAttachmentError("图片读取失败，请重新选择图片");
    });
  };

  const handleCaptureVisibleTab = async () => {
    if (!currentModelSupportsVision) {
      return;
    }
    if (attachments.length >= MAX_IMAGE_ATTACHMENTS) {
      setAttachmentError("最多只能添加 5 张图片");
      return;
    }

    try {
      const response = await sendRuntimeMessage<TabCaptureVisibleResponse>({ type: TAB_CAPTURE_VISIBLE_MESSAGE_TYPE });
      if (!response?.ok) {
        setAttachmentError(response?.message || "当前页面截图失败，请稍后重试");
        return;
      }
      if (!isTabCaptureImageAttachment(response.attachment)) {
        setAttachmentError("当前页面截图结果无效，请重试");
        return;
      }
      if (estimateDataUrlBytes(response.attachment.dataUrl) > MAX_IMAGE_ATTACHMENT_BYTES) {
        setAttachmentError("单张图片不能超过 5MB");
        return;
      }
      if (!isPngDataUrl(response.attachment.dataUrl)) {
        setAttachmentError("当前页面截图结果无效，请重试");
        return;
      }

      setAttachments((current) => [...current, response.attachment]);
      setAttachmentError("");
    } catch {
      setAttachmentError("当前页面截图失败，请稍后重试");
    }
  };

  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    if (!currentModelSupportsVision) {
      setAttachmentError("当前模型不支持视觉理解，无法添加图片");
      return;
    }

    const nextAttachments = [...attachments];
    for (const file of files) {
      if (nextAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
        setAttachmentError("最多只能添加 5 张图片");
        break;
      }
      if (!file.type.startsWith("image/") || !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        setAttachmentError("仅支持 PNG、JPEG、WebP 或 GIF 图片");
        continue;
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        setAttachmentError("单张图片不能超过 5MB");
        continue;
      }

      try {
        nextAttachments.push({
          id: `image-${Date.now()}-${nextAttachments.length}`,
          name: file.name || "图片",
          mediaType: file.type,
          dataUrl: await readFileAsDataUrl(file),
        });
      } catch {
        setAttachmentError("图片读取失败，请重新选择图片");
        continue;
      }
      setAttachmentError("");
    }

    setAttachments(nextAttachments);
  };

  const contextModeLabel = contextMode === "all" ? "提取所有" : "提取文本";

  return (
    <section className="chat-composer" aria-label="聊天输入区">
      {attachments.length > 0 ? (
        <div className="image-preview-strip" aria-label="已添加图片">
          {attachments.map((attachment) => (
            <div className="image-preview-thumb-wrap" key={attachment.id}>
              <button className="image-preview-thumb" type="button" aria-label={`查看图片 ${attachment.name}`} onClick={() => setPreviewAttachment(attachment)}>
                <img src={attachment.dataUrl} alt="" />
              </button>
              <button
                className="image-preview-remove"
                type="button"
                aria-label={`删除图片 ${attachment.name}`}
                title="删除图片"
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="context-strip">
        <button className="ui-button-secondary context-view-button" type="button" onClick={() => setContextDialogOpen(true)}>
          查看上下文
        </button>
        <span className="context-chip">{matchedRuleLabel}</span>
        <button className="ui-button-secondary" type="button" onClick={() => void refreshPageContext()}>
          刷新
        </button>
        {currentModelSupportsVision ? (
          <button className="ui-button-secondary" type="button" aria-label="截图当前标签页" title="截取当前标签页可见区域" onClick={() => void handleCaptureVisibleTab()}>
            截图
          </button>
        ) : null}
        <ComposerSwitch
          ariaLabel="拼接上下文"
          checked={appendPageContextToSystemPrompt}
          label="拼接上下文"
          onToggle={() => setAppendPageContextToSystemPrompt(!appendPageContextToSystemPrompt)}
        />
      </div>
      {pageContext.truncated ? <p className="text-sm text-[var(--color-warning)]">内容已截断，请细化 CSS/XPath</p> : null}
      {pageContext.error ? <p className="text-sm text-[var(--color-error)]">{pageContext.error}</p> : null}
      {attachmentError ? <p className="text-sm text-[var(--color-error)]">{attachmentError}</p> : null}
      <div className="chat-input-shell">
        <input
          id={imageInputId}
          className="sr-only"
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          multiple
          aria-label="上传图片"
          disabled={!currentModelSupportsVision}
          onChange={handleImageInputChange}
        />
        <label
          className={`image-upload-button${currentModelSupportsVision ? "" : " image-upload-button-disabled"}`}
          htmlFor={imageInputId}
          title={currentModelSupportsVision ? "上传图片" : "当前模型不支持视觉理解"}
        >
          <span aria-hidden="true">▣</span>
        </label>
        <textarea
          className="ui-input chat-input"
          aria-label="对话输入"
          value={input}
          onPaste={handlePaste}
          onKeyDown={handleInputKeyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onChange={(event) => setInput(event.target.value)}
        />
      </div>
      <div className="composer-actions">
        <div className="composer-switches">
          <ComposerSwitch ariaLabel="流式响应" checked={streamMode} label="流式响应" onToggle={() => setStreamMode(!streamMode)} />
          <ComposerSwitch
            ariaLabel="提取模式"
            checked={contextMode === "all"}
            label={contextModeLabel}
            onToggle={() => setContextMode(contextMode === "all" ? "text" : "all")}
          />
        </div>
        <button className="ui-button-primary" type="button" disabled={!canSend || sending || (!input.trim() && attachments.length === 0)} onClick={() => void submit()}>
          {sending ? "发送中" : "发送"}
        </button>
      </div>
      {previewAttachment ? (
        <>
          <div className="dialog-overlay" aria-hidden="true" />
          <section className="image-preview-dialog" role="dialog" aria-modal="true" aria-label="图片预览">
            <button className="ui-button-secondary image-preview-close" type="button" aria-label="关闭图片预览" onClick={() => setPreviewAttachment(undefined)}>
              关闭
            </button>
            <img src={previewAttachment.dataUrl} alt={previewAttachment.name} />
          </section>
        </>
      ) : null}
      {contextDialogOpen ? (
        <>
          <div className="dialog-overlay" aria-hidden="true" />
          <section className="context-dialog" role="dialog" aria-modal="true" aria-labelledby="context-dialog-title">
            <div className="context-dialog-header">
              <h2 className="context-dialog-title" id="context-dialog-title">
                当前页上下文
              </h2>
              <button className="ui-button-secondary context-dialog-close" type="button" aria-label="关闭上下文" onClick={() => setContextDialogOpen(false)}>
                关闭
              </button>
            </div>
            <p className="context-preview">{pageContext.text || "暂无上下文"}</p>
          </section>
        </>
      ) : null}
    </section>
  );
}

function getPastedImageFiles(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(clipboardData.files ?? []).filter((file) => file.type.startsWith("image/"));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function estimateDataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.split(",", 2)[1] ?? "";
  const paddingBytes = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - paddingBytes);
}

function sendRuntimeMessage<T>(message: { type: string }): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      reject(new Error("Chrome runtime 不可用"));
      return;
    }

    let settled = false;
    const finish = (response: T | undefined) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(response);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    try {
      // 真实 Chrome 扩展环境可能走 callback 形态；保留 Promise 兼容是为了适配测试环境和不同浏览器实现。
      const maybePromise = runtime.sendMessage(message, (response: T) => {
        const lastError = runtime.lastError;
        if (lastError) {
          fail(new Error(lastError.message));
          return;
        }

        finish(response);
      }) as Promise<T> | undefined;

      if (maybePromise && typeof maybePromise.then === "function") {
        void maybePromise.then(finish).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  });
}

function isSendShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>, shortcut: SendShortcut): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) {
    return false;
  }

  const modifiers = {
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  };

  switch (shortcut) {
    case "enter":
      return !modifiers.shiftKey && !modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey;
    case "shift_enter":
      return modifiers.shiftKey && !modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey;
    case "ctrl_enter":
      return modifiers.ctrlKey && !modifiers.shiftKey && !modifiers.altKey && !modifiers.metaKey;
    case "ctrl_shift_enter":
      return modifiers.ctrlKey && modifiers.shiftKey && !modifiers.altKey && !modifiers.metaKey;
    case "alt_enter":
      return modifiers.altKey && !modifiers.shiftKey && !modifiers.ctrlKey && !modifiers.metaKey;
    default:
      return false;
  }
}
