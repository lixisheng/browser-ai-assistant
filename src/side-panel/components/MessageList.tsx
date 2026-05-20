import ReactMarkdown from "react-markdown";

export function MessageList() {
  return (
    <section aria-label="消息列表" className="ui-panel min-h-24">
      <ReactMarkdown>暂无消息</ReactMarkdown>
    </section>
  );
}
