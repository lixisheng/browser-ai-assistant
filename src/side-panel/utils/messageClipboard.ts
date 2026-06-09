import { downloadBlob } from "./downloadBlob";

const IMAGE_WIDTH = 880;
const IMAGE_PADDING = 32;
const CONTENT_WIDTH = IMAGE_WIDTH - IMAGE_PADDING * 2;
const MAX_IMAGE_HEIGHT = 32000;
const TRUNCATION_TEXT = "...内容过长已截断";
const CHINESE_FONT_FAMILY = "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, Hiragino Sans GB, Arial, sans-serif";
const MONO_FONT_FAMILY = "Consolas, Microsoft YaHei Mono, Noto Sans Mono CJK SC, monospace";

type MessageImageResult = "copied" | "downloaded";

type TextKind = "heading1" | "heading2" | "heading3" | "paragraph" | "quote" | "code" | "spacer";

interface TextLine {
  kind: TextKind;
  text: string;
}

interface TextStyle {
  font: string;
  color: string;
  lineHeight: number;
}

const textStyles: Record<Exclude<TextKind, "spacer">, TextStyle> = {
  heading1: {
    font: `700 30px ${CHINESE_FONT_FAMILY}`,
    color: "#141413",
    lineHeight: 42,
  },
  heading2: {
    font: `700 24px ${CHINESE_FONT_FAMILY}`,
    color: "#141413",
    lineHeight: 34,
  },
  heading3: {
    font: `700 19px ${CHINESE_FONT_FAMILY}`,
    color: "#2f2d2a",
    lineHeight: 30,
  },
  paragraph: {
    font: `400 16px ${CHINESE_FONT_FAMILY}`,
    color: "#2f2d2a",
    lineHeight: 26,
  },
  quote: {
    font: `400 15px ${CHINESE_FONT_FAMILY}`,
    color: "#5f5b54",
    lineHeight: 24,
  },
  code: {
    font: `400 14px ${MONO_FONT_FAMILY}`,
    color: "#faf9f5",
    lineHeight: 24,
  },
};

export async function copyTextToClipboard(markdown: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("当前环境不支持复制到剪贴板");
  }

  try {
    await navigator.clipboard.writeText(markdown);
  } catch {
    throw new Error("复制失败，请重试");
  }
}

export async function copyOrDownloadMessageImage(markdown: string, filename: string = createMessageImageFilename()): Promise<MessageImageResult> {
  const blob = await renderMarkdownImageBlob(markdown);
  const copied = await copyImageToClipboard(blob);
  if (copied) {
    return "copied";
  }

  downloadBlob(blob, filename);
  return "downloaded";
}

export function createMessageImageFilename(exportedAt: number = Date.now()): string {
  return `AI消息-${new Date(exportedAt).toISOString().slice(0, 10)}.png`;
}

async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return false;
  }

  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

async function renderMarkdownImageBlob(markdown: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法生成消息图片");
  }

  const lines = layoutMarkdown(markdown, context);
  const calculatedHeight = calculateImageHeight(lines);
  const truncated = calculatedHeight > MAX_IMAGE_HEIGHT;
  const height = truncated ? MAX_IMAGE_HEIGHT : calculatedHeight;
  canvas.width = IMAGE_WIDTH;
  canvas.height = height;

  drawMarkdownImage(context, lines, height, truncated);

  const blob = await canvasToPngBlob(canvas);
  if (!blob) {
    throw new Error("无法生成消息图片");
  }

  return blob;
}

function layoutMarkdown(markdown: string, context: CanvasRenderingContext2D): TextLine[] {
  const lines: TextLine[] = [];
  let inCodeBlock = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    if (rawLine.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!rawLine.trim()) {
      lines.push({ kind: "spacer", text: "" });
      continue;
    }

    if (inCodeBlock) {
      lines.push(...wrapStyledLine(rawLine, "code", context));
      continue;
    }

    const headingMatch = rawLine.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const kind = headingMatch[1].length === 1 ? "heading1" : headingMatch[1].length === 2 ? "heading2" : "heading3";
      lines.push(...wrapStyledLine(headingMatch[2], kind, context));
      continue;
    }

    const quoteMatch = rawLine.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      lines.push(...wrapStyledLine(quoteMatch[1], "quote", context));
      continue;
    }

    const listMatch = rawLine.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      lines.push(...wrapStyledLine(`• ${listMatch[1]}`, "paragraph", context));
      continue;
    }

    lines.push(...wrapStyledLine(rawLine, "paragraph", context));
  }

  return lines.length > 0 ? lines : [{ kind: "paragraph", text: "" }];
}

function wrapStyledLine(text: string, kind: Exclude<TextKind, "spacer">, context: CanvasRenderingContext2D): TextLine[] {
  const style = textStyles[kind];
  context.font = style.font;
  const maxWidth = kind === "quote" ? CONTENT_WIDTH - 20 : kind === "code" ? CONTENT_WIDTH - 24 : CONTENT_WIDTH;
  const wrapped = wrapText(text, maxWidth, context);
  return wrapped.map((line) => ({ kind, text: line }));
}

function wrapText(text: string, maxWidth: number, context: CanvasRenderingContext2D): string[] {
  const characters = Array.from(text);
  const lines: string[] = [];
  let current = "";

  for (const character of characters) {
    const next = current + character;
    if (current && context.measureText(next).width > maxWidth) {
      lines.push(current);
      current = character;
      continue;
    }

    current = next;
  }

  lines.push(current);
  return lines;
}

function calculateImageHeight(lines: TextLine[]): number {
  const contentHeight = lines.reduce((height, line) => {
    if (line.kind === "spacer") {
      return height + 12;
    }

    return height + textStyles[line.kind].lineHeight;
  }, 0);

  return Math.max(120, contentHeight + IMAGE_PADDING * 2);
}

function drawMarkdownImage(context: CanvasRenderingContext2D, lines: TextLine[], height: number, truncated: boolean): void {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, IMAGE_WIDTH, height);
  context.textBaseline = "top";

  let y = IMAGE_PADDING;
  const footerTop = height - IMAGE_PADDING - textStyles.quote.lineHeight;
  const contentBottom = truncated ? footerTop - 12 : height - IMAGE_PADDING;
  for (const line of lines) {
    if (line.kind === "spacer") {
      y += 12;
      continue;
    }

    const style = textStyles[line.kind];
    if (y + style.lineHeight > contentBottom) {
      break;
    }

    context.font = style.font;
    context.fillStyle = style.color;

    if (line.kind === "code") {
      drawRoundedRect(context, IMAGE_PADDING, y - 4, CONTENT_WIDTH, style.lineHeight + 8, 6, "#181715");
      context.fillStyle = style.color;
      context.fillText(line.text, IMAGE_PADDING + 12, y);
    } else if (line.kind === "quote") {
      context.fillStyle = "#e8a55a";
      context.fillRect(IMAGE_PADDING, y + 2, 3, style.lineHeight - 4);
      context.fillStyle = style.color;
      context.fillText(line.text, IMAGE_PADDING + 16, y);
    } else {
      context.fillText(line.text, IMAGE_PADDING, y);
    }

    y += style.lineHeight;
  }

  if (truncated) {
    const style = textStyles.quote;
    context.font = style.font;
    context.fillStyle = "#e8a55a";
    context.fillRect(IMAGE_PADDING, footerTop + 2, 3, style.lineHeight - 4);
    context.fillStyle = style.color;
    context.fillText(TRUNCATION_TEXT, IMAGE_PADDING + 16, footerTop);
  }
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: string,
): void {
  context.fillStyle = color;
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(x, y, width, height, radius);
  } else {
    context.rect(x, y, width, height);
  }
  context.fill();
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}
