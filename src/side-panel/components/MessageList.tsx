import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatImageAttachment, ChatMessage } from "../../shared/types";

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const [previewAttachment, setPreviewAttachment] = useState<ChatImageAttachment | undefined>();

  if (messages.length === 0) {
    return (
      <section aria-label="消息列表" className="message-list">
        <p className="ui-muted text-sm">暂无消息</p>
      </section>
    );
  }

  return (
    <section aria-label="消息列表" className="message-list">
      {messages.map((message) => (
        <article key={message.id} className={message.role === "user" ? "message-row message-row-user" : "message-row"}>
          <div className="message-avatar" aria-hidden="true">
            {message.role === "user" ? "我" : "AI"}
          </div>
          <div className="message-bubble-wrap">
            {message.role === "assistant" && message.thinking ? (
              <details className="message-thinking" open={shouldOpenThinking(message) || undefined}>
                <summary>{message.streaming ? "思考中" : "思考过程"}</summary>
                <p>{message.thinking}</p>
              </details>
            ) : null}
            {message.attachments?.length ? (
              <div className="message-image-preview-strip" aria-label="已发送图片">
                {message.attachments.map((attachment) => (
                  <button
                    className="image-preview-thumb"
                    type="button"
                    key={attachment.id}
                    aria-label={`查看已发送图片 ${attachment.name}`}
                    onClick={() => setPreviewAttachment(attachment)}
                  >
                    <img src={attachment.dataUrl} alt="" />
                  </button>
                ))}
              </div>
            ) : null}
            <div className="message-bubble">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          </div>
        </article>
      ))}
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
    </section>
  );
}

function shouldOpenThinking(message: ChatMessage): boolean {
  if (!message.streaming || !message.thinking) {
    return false;
  }

  return message.thinking.split(/\r?\n/).length <= 5;
}
