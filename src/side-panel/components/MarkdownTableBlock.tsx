import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { copyElementImageToClipboard, copyTextToClipboard } from "../utils/messageClipboard";
import { getTextWithoutMarkdownTableActions } from "../utils/markdownTableText";
import { CopyMessageIcon, ExportImageIcon } from "./MessageActionIcons";

const COPY_FEEDBACK_DURATION_MS = 1600;
type CopyFeedback = "markdown-success" | "image-success" | "error" | null;

type MarkdownTableBlockProps = ComponentPropsWithoutRef<"table"> & { node?: unknown };

export function MarkdownTableBlock({ children, node: _node, ...props }: MarkdownTableBlockProps) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const copyRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearCopyFeedbackTimer();
    };
  }, []);

  const clearCopyFeedbackTimer = () => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
  };

  const showCopyFeedback = (feedback: Exclude<CopyFeedback, null>) => {
    setCopyFeedback(feedback);
    clearCopyFeedbackTimer();
    feedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback(null);
      feedbackTimerRef.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
  };

  const runCopyAction = async (action: () => Promise<void>, successFeedback: Exclude<CopyFeedback, "error" | null>) => {
    const requestId = copyRequestIdRef.current + 1;
    copyRequestIdRef.current = requestId;
    try {
      await action();
      if (!mountedRef.current || requestId !== copyRequestIdRef.current) {
        return;
      }
      showCopyFeedback(successFeedback);
    } catch {
      if (!mountedRef.current || requestId !== copyRequestIdRef.current) {
        return;
      }
      showCopyFeedback("error");
    }
  };

  const handleCopyMarkdown = () => {
    const table = tableRef.current;
    if (!table) {
      return;
    }
    void runCopyAction(() => copyTextToClipboard(createMarkdownTableText(table)), "markdown-success");
  };

  const handleCopyImage = () => {
    const table = tableRef.current;
    if (!table) {
      return;
    }
    void runCopyAction(() => copyElementImageToClipboard(table), "image-success");
  };

  const actions = (
    <span className="markdown-table-block-actions" data-markdown-table-actions="true">
      <button
        className="message-icon-button markdown-table-block-icon-button"
        type="button"
        aria-label="复制表格 Markdown"
        title="复制表格 Markdown"
        onClick={handleCopyMarkdown}
      >
        <CopyMessageIcon />
      </button>
      <button
        className="message-icon-button markdown-table-block-icon-button"
        type="button"
        aria-label="复制表格图片"
        title="复制表格图片"
        onClick={handleCopyImage}
      >
        <ExportImageIcon />
      </button>
      {copyFeedback ? (
        <span
          className={[
            "markdown-table-block-copy-feedback",
            copyFeedback === "error" ? "markdown-table-block-copy-feedback-error" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="status"
          aria-live="polite"
        >
          {copyFeedback === "markdown-success" ? "已复制" : copyFeedback === "image-success" ? "图片已复制" : "复制失败"}
        </span>
      ) : null}
    </span>
  );

  return (
    <div className="markdown-table-block">
      <div className="markdown-table-block-scroller">
        <table ref={tableRef} {...props}>
          {injectHeaderActions(children, actions)}
        </table>
      </div>
    </div>
  );
}

export function createMarkdownTableText(table: HTMLTableElement): string {
  const rows = Array.from(table.rows);
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  const normalizedRows = rows.map((row) => normalizeTableCells(Array.from(row.cells), columnCount));
  const [headerRow, ...bodyRows] = normalizedRows;
  return [
    formatMarkdownTableRow(headerRow),
    formatMarkdownTableRow(Array.from({ length: columnCount }, () => "---")),
    ...bodyRows.map(formatMarkdownTableRow),
  ].join("\n");
}

function normalizeTableCells(cells: HTMLTableCellElement[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => normalizeMarkdownTableCell(getTableCellText(cells[index])));
}

function getTableCellText(cell?: HTMLTableCellElement): string {
  if (!cell) {
    return "";
  }
  return getTextWithoutMarkdownTableActions(cell);
}

function normalizeMarkdownTableCell(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

function formatMarkdownTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function injectHeaderActions(children: ReactNode, actions: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isNamedElement(child, "thead")) {
      return child;
    }
    return cloneElementWithChildren(child, injectActionsIntoThead(child.props.children, actions));
  });
}

function injectActionsIntoThead(children: ReactNode, actions: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isNamedElement(child, "tr")) {
      return child;
    }
    return cloneElementWithChildren(child, injectActionsIntoHeaderRow(child.props.children, actions));
  });
}

function injectActionsIntoHeaderRow(children: ReactNode, actions: ReactNode): ReactNode {
  const cells = Children.toArray(children);
  const lastHeaderIndex = findLastHeaderCellIndex(cells);
  return cells.map((child, index) => {
    if (index !== lastHeaderIndex || !isNamedElement(child, "th")) {
      return child;
    }
    return cloneElementWithChildren(
      child,
      <span className="markdown-table-block-header-content">
        <span className="markdown-table-block-header-text">{child.props.children}</span>
        {actions}
      </span>,
    );
  });
}

function findLastHeaderCellIndex(cells: ReactNode[]): number {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (isNamedElement(cells[index], "th")) {
      return index;
    }
  }
  return -1;
}

function isNamedElement(element: ReactNode, name: string): element is ReactElement<{ children?: ReactNode }> {
  return isValidElement(element) && element.type === name;
}

function cloneElementWithChildren(element: ReactElement<{ children?: ReactNode }>, children: ReactNode): ReactElement {
  return cloneElement(element, undefined, children);
}
