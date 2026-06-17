import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { aggregateDisplayAttachmentsByKind, getJsSourceAttachmentDisplayCount, MessageList } from "../../../src/side-panel/components/MessageList";
import type { ChatJsSourceToolAttachment, ChatMessage } from "../../../src/shared/types";

function createJsSourceAttachment(partial: Partial<ChatJsSourceToolAttachment>): ChatJsSourceToolAttachment {
  return {
    id: "attachment-js",
    kind: "js-source",
    title: "JS 源码片段",
    summary: "JS 资源 1 个",
    createdAt: 1,
    redacted: true,
    truncated: false,
    resources: [],
    jsMatches: [],
    contexts: [],
    failedFetches: [],
    ...partial,
  };
}

describe("MessageList 工具附件展示聚合", () => {
  it("同一气泡下多个 JS 源码附件聚合后仍保留结构化数据", () => {
    const attachments = aggregateDisplayAttachmentsByKind([
      createJsSourceAttachment({
        id: "attachment-js-a",
        resources: [
          {
            id: "script-a",
            source: "network",
            url: "https://example.com/a.js",
            size: 1,
            searchable: true,
            redacted: true,
            truncated: false,
          },
        ],
        jsMatches: [
          {
            resourceId: "script-a",
            source: "network",
            url: "https://example.com/a.js",
            term: "sign",
            position: 10,
            line: 1,
            column: 11,
            snippet: "function sign(){}",
            redacted: true,
            truncated: false,
          },
        ],
      }),
      createJsSourceAttachment({
        id: "attachment-js-b",
        createdAt: 2,
        truncated: true,
        resources: [
          {
            id: "script-b",
            source: "same-origin-fetch",
            url: "https://example.com/b.js",
            size: 1,
            searchable: true,
            redacted: true,
            truncated: false,
          },
        ],
        contexts: [
          {
            resourceId: "script-b",
            source: "same-origin-fetch",
            url: "https://example.com/b.js",
            position: 20,
            line: 2,
            column: 5,
            snippet: "const token = \"[已脱敏]\"",
            redacted: true,
            truncated: true,
          },
        ],
        failedFetches: [{ url: "https://example.com/missing.js", message: "同源 JS 补位读取失败。" }],
      }),
    ]);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: "js-source",
      id: "message-display-js-source-attachment-js-a-attachment-js-b",
      truncated: true,
      resources: [
        expect.objectContaining({ id: "script-a" }),
        expect.objectContaining({ id: "script-b" }),
      ],
      jsMatches: [expect.objectContaining({ resourceId: "script-a" })],
      contexts: [expect.objectContaining({ resourceId: "script-b" })],
      failedFetches: [expect.objectContaining({ message: "同源 JS 补位读取失败。" })],
    });
    expect(attachments[0]).not.toHaveProperty("details");
  });
  it("聚合 JS 源码附件时会基于去重后的结构重新生成摘要", () => {
    const attachments = aggregateDisplayAttachmentsByKind([
      createJsSourceAttachment({
        id: "attachment-js-a",
        summary: "旧摘要 A",
        resources: [
          {
            id: "script-a",
            source: "network",
            url: "https://example.com/a.js",
            size: 1,
            searchable: true,
            redacted: true,
            truncated: false,
          },
        ],
        jsMatches: [
          {
            resourceId: "script-a",
            source: "network",
            url: "https://example.com/a.js",
            term: "sign",
            position: 10,
            line: 1,
            column: 11,
            snippet: "function sign(){}",
            redacted: true,
            truncated: false,
          },
        ],
      }),
      createJsSourceAttachment({
        id: "attachment-js-b",
        summary: "旧摘要 B",
        resources: [
          {
            id: "script-a",
            source: "network",
            url: "https://example.com/a.js",
            size: 1,
            searchable: true,
            redacted: true,
            truncated: false,
          },
        ],
        jsMatches: [
          {
            resourceId: "script-a",
            source: "network",
            url: "https://example.com/a.js",
            term: "sign",
            position: 10,
            line: 1,
            column: 11,
            snippet: "function sign(){}",
            redacted: true,
            truncated: false,
          },
        ],
      }),
    ]);

    expect(attachments[0]).toMatchObject({
      kind: "js-source",
      summary: "JS 资源 1 个，命中 1 个，上下文 0 个，补位失败 0 个。",
    });
  });

  it("JS 源码附件标题计数在无片段时显示资源数，有片段时显示片段数", () => {
    expect(getJsSourceAttachmentDisplayCount(createJsSourceAttachment({
      resources: [
        {
          id: "script-a",
          source: "network",
          url: "https://example.com/a.js",
          size: 1,
          searchable: true,
          redacted: true,
          truncated: false,
        },
        {
          id: "script-b",
          source: "network",
          url: "https://example.com/b.js",
          size: 1,
          searchable: true,
          redacted: true,
          truncated: false,
        },
      ],
    }))).toBe(2);

    expect(getJsSourceAttachmentDisplayCount(createJsSourceAttachment({
      resources: [
        {
          id: "script-a",
          source: "network",
          url: "https://example.com/a.js",
          size: 1,
          searchable: true,
          redacted: true,
          truncated: false,
        },
      ],
      jsMatches: [
        {
          resourceId: "script-a",
          source: "network",
          url: "https://example.com/a.js",
          term: "login",
          position: 10,
          line: 1,
          column: 11,
          snippet: "login()",
          redacted: true,
          truncated: false,
        },
      ],
      contexts: [
        {
          resourceId: "script-a",
          source: "network",
          url: "https://example.com/a.js",
          position: 20,
          line: 2,
          column: 5,
          snippet: "function login(){}",
          redacted: true,
          truncated: false,
        },
      ],
    }))).toBe(2);
  });

  it("Source Map 映射详情展示安全摘要，不直接输出完整资源 URL", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "已解析 Source Map",
      createdAt: 1,
      modelId: "model-1",
      endpointType: "openai_chat",
      streamMode: false,
      systemPrompt: "",
      contextPrompt: "",
      contextMode: "text",
      toolAttachments: [
        {
          id: "attachment-map",
          kind: "source-map",
          title: "Source Map 解析结果",
          summary: "Source Map 候选 0 个，映射 1 个，原始片段 0 个，失败 0 个。",
          createdAt: 1,
          redacted: true,
          truncated: false,
          candidates: [],
          resolvedLocations: [
            {
              resourceId: "script-1",
              resourceUrl: "https://example.com/internal/admin-panel.js?token=secret",
              generatedLine: 10,
              generatedColumn: 20,
              source: "src/app.ts",
              originalLine: 2,
              originalColumn: 5,
              name: "renderAdmin",
              ignored: false,
              hasSourceContent: true,
            },
          ],
          originalContexts: [],
          failures: [],
        },
      ],
    };

    render(
      <MessageList
        messages={[message]}
        retryProgressByMessageId={{}}
        toolCallDisplayMode="assistant_grouped"
        showToolCallProcessInAssistantMode
        onRegenerateMessage={() => undefined}
        onEditAndRegenerateUserMessage={() => undefined}
        regenerating={false}
      />,
    );

    expect(screen.getByText("resourceId: script-1", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("name: renderAdmin", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/admin-panel\.js\?token=secret/)).not.toBeInTheDocument();
  });

  it("Source Map 候选展示只显示安全位置摘要，不直接输出完整 map URL", () => {
    const message: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "已发现 Source Map 候选",
      createdAt: 2,
      modelId: "model-1",
      endpointType: "openai_chat",
      streamMode: false,
      systemPrompt: "",
      contextPrompt: "",
      contextMode: "text",
      toolAttachments: [
        {
          id: "attachment-map-2",
          kind: "source-map",
          title: "Source Map 解析结果",
          summary: "Source Map 候选 1 个，映射 0 个，原始片段 0 个，失败 0 个。",
          createdAt: 2,
          redacted: true,
          truncated: false,
          candidates: [
            {
              resourceId: "script-2",
              resourceUrl: "https://example.com/assets/app.js",
              source: "source-mapping-url",
              url: "https://example.com/assets/app.js.map?token=secret",
              inline: false,
              status: "fetchable",
              parsed: false,
            },
          ],
          resolvedLocations: [],
          originalContexts: [],
          failures: [],
        },
      ],
    };

    render(
      <MessageList
        messages={[message]}
        retryProgressByMessageId={{}}
        toolCallDisplayMode="assistant_grouped"
        showToolCallProcessInAssistantMode
        onRegenerateMessage={() => undefined}
        onEditAndRegenerateUserMessage={() => undefined}
        regenerating={false}
      />,
    );

    expect(screen.getByText("script-2 | source-mapping-url | fetchable | 外部 Source Map")).toBeInTheDocument();
    expect(screen.queryByText(/app\.js\.map\?token=secret/)).not.toBeInTheDocument();
  });
});
