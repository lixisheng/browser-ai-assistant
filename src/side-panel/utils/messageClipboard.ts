import { downloadBlob } from "./downloadBlob";
import { getTextWithoutMarkdownTableActions } from "./markdownTableText";

const IMAGE_WIDTH = 880;
const IMAGE_PADDING = 32;
const CONTENT_WIDTH = IMAGE_WIDTH - IMAGE_PADDING * 2;
const MAX_IMAGE_HEIGHT = 32000;
const MAX_ELEMENT_IMAGE_SIDE = 8000;
const MAX_ELEMENT_IMAGE_AREA = 16_000_000;
const MAX_ELEMENT_IMAGE_OUTPUT_SIDE = 12000;
const MAX_ELEMENT_IMAGE_OUTPUT_AREA = 48_000_000;
const MIN_ELEMENT_IMAGE_SCALE = 2;
const MAX_ELEMENT_IMAGE_SCALE = 3;
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

export async function copyElementImageToClipboard(element: HTMLElement): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前环境不支持复制图片到剪贴板");
  }

  const blob = await renderElementImageBlob(element);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw new Error("复制失败，请重试");
  }
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

async function renderElementImageBlob(element: HTMLElement): Promise<Blob> {
  const measurement = createMeasuredExportElement(element);
  try {
    const { width, height } = measurement;
    if (width <= 0 || height <= 0) {
      throw new Error("表格为空，无法复制为图片");
    }
    if (width > MAX_ELEMENT_IMAGE_SIDE || height > MAX_ELEMENT_IMAGE_SIDE || width * height > MAX_ELEMENT_IMAGE_AREA) {
      throw new Error("表格尺寸过大，无法复制为图片");
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("无法生成表格图片");
    }

    const scale = calculateElementImageScale(width, height);
    const outputWidth = Math.ceil(width * scale);
    const outputHeight = Math.ceil(height * scale);
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    if (measurement.element instanceof HTMLTableElement) {
      drawTableElementImage(context, measurement.element, width, height, scale);
    } else {
      const image = await createImageFromElement(measurement.element, width, height, outputWidth, outputHeight);
      context.drawImage(image, 0, 0, outputWidth, outputHeight);
    }
    const blob = await canvasToPngBlob(canvas);
    if (!blob) {
      throw new Error("无法生成表格图片");
    }

    return blob;
  } finally {
    measurement.cleanup();
  }
}

function calculateElementImageScale(width: number, height: number): number {
  const preferredScale = Math.min(
    MAX_ELEMENT_IMAGE_SCALE,
    Math.max(MIN_ELEMENT_IMAGE_SCALE, Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : MIN_ELEMENT_IMAGE_SCALE),
  );
  const sideScale = Math.min(MAX_ELEMENT_IMAGE_OUTPUT_SIDE / width, MAX_ELEMENT_IMAGE_OUTPUT_SIDE / height);
  const areaScale = Math.sqrt(MAX_ELEMENT_IMAGE_OUTPUT_AREA / (width * height));
  return Math.max(1, Math.min(preferredScale, sideScale, areaScale));
}

function drawTableElementImage(context: CanvasRenderingContext2D, table: HTMLTableElement, width: number, height: number, scale: number): void {
  context.save();
  context.scale(scale, scale);
  context.fillStyle = getVisibleBackgroundColor(table) ?? "#ffffff";
  context.fillRect(0, 0, width, height);

  const tableRect = table.getBoundingClientRect();
  for (const row of Array.from(table.rows)) {
    for (const cell of Array.from(row.cells)) {
      drawTableCell(context, cell, tableRect);
    }
  }
  context.restore();
}

function drawTableCell(context: CanvasRenderingContext2D, cell: HTMLTableCellElement, tableRect: DOMRect): void {
  const cellRect = cell.getBoundingClientRect();
  const x = cellRect.left - tableRect.left;
  const y = cellRect.top - tableRect.top;
  const width = cellRect.width;
  const height = cellRect.height;
  if (width <= 0 || height <= 0) {
    return;
  }

  const style = getComputedStyle(cell);
  context.fillStyle = getVisibleBackgroundColor(cell) ?? "#ffffff";
  context.fillRect(x, y, width, height);
  drawCellBorder(context, style, x, y, width, height);
  drawCellText(context, cell, style, x, y, width, height);
}

function drawCellBorder(context: CanvasRenderingContext2D, style: CSSStyleDeclaration, x: number, y: number, width: number, height: number): void {
  const borderWidth = Math.max(1, parseCssPixel(style.borderTopWidth));
  context.strokeStyle = style.borderTopColor || "#d8d3ca";
  context.lineWidth = borderWidth;
  context.strokeRect(x + borderWidth / 2, y + borderWidth / 2, Math.max(0, width - borderWidth), Math.max(0, height - borderWidth));
}

function drawCellText(
  context: CanvasRenderingContext2D,
  cell: HTMLTableCellElement,
  style: CSSStyleDeclaration,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const text = getTextWithoutMarkdownTableActions(cell).replace(/\s+/g, " ").trim();
  if (!text) {
    return;
  }

  const paddingLeft = parseCssPixel(style.paddingLeft);
  const paddingRight = parseCssPixel(style.paddingRight);
  const paddingTop = parseCssPixel(style.paddingTop);
  const paddingBottom = parseCssPixel(style.paddingBottom);
  const contentWidth = Math.max(0, width - paddingLeft - paddingRight);
  const contentHeight = Math.max(0, height - paddingTop - paddingBottom);
  if (contentWidth <= 0 || contentHeight <= 0) {
    return;
  }

  context.font = style.font || `${style.fontWeight || "400"} ${style.fontSize || "12px"} ${style.fontFamily || CHINESE_FONT_FAMILY}`;
  context.fillStyle = style.color || "#141413";
  context.textBaseline = "top";

  const lineHeight = parseCssPixel(style.lineHeight) || Math.max(parseCssPixel(style.fontSize) * 1.4, 16);
  const lines = wrapText(text, contentWidth, context);
  let textY = y + paddingTop;
  for (const line of lines) {
    if (textY + lineHeight > y + paddingTop + contentHeight + 0.5) {
      break;
    }
    context.fillText(line, getTextX(context, line, style.textAlign, x + paddingLeft, contentWidth), textY);
    textY += lineHeight;
  }
}

function getTextX(context: CanvasRenderingContext2D, line: string, textAlign: string, x: number, width: number): number {
  if (textAlign === "right" || textAlign === "end") {
    return x + Math.max(0, width - context.measureText(line).width);
  }
  if (textAlign === "center") {
    return x + Math.max(0, (width - context.measureText(line).width) / 2);
  }
  return x;
}

function getVisibleBackgroundColor(element: HTMLElement): string | null {
  const backgroundColor = getComputedStyle(element).backgroundColor;
  return backgroundColor && backgroundColor !== "transparent" && backgroundColor !== "rgba(0, 0, 0, 0)" ? backgroundColor : null;
}

function parseCssPixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createMeasuredExportElement(element: HTMLElement): { element: HTMLElement; width: number; height: number; cleanup: () => void } {
  const measuringRoot = document.createElement("div");
  measuringRoot.setAttribute("data-element-image-measure-root", "true");
  measuringRoot.style.position = "fixed";
  measuringRoot.style.left = "-100000px";
  measuringRoot.style.top = "0";
  measuringRoot.style.width = "max-content";
  measuringRoot.style.height = "auto";
  measuringRoot.style.overflow = "visible";
  measuringRoot.style.visibility = "hidden";
  measuringRoot.style.pointerEvents = "none";
  measuringRoot.style.zIndex = "-1";

  const exportElement = cloneElementWithInlineStyles(element);
  measuringRoot.appendChild(exportElement);
  document.body.appendChild(measuringRoot);

  const { width, height } = measureElementDimensions(exportElement);
  return {
    element: exportElement,
    width,
    height,
    cleanup: () => {
      measuringRoot.remove();
    },
  };
}

function measureElementDimensions(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.ceil(Math.max(element.scrollWidth, rect.width)),
    height: Math.ceil(Math.max(element.scrollHeight, rect.height)),
  };
}

async function createImageFromElement(element: HTMLElement, width: number, height: number, outputWidth: number, outputHeight: number): Promise<HTMLImageElement> {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.width = `${width}px`;
  wrapper.style.height = `${height}px`;
  wrapper.style.overflow = "visible";
  wrapper.style.background = getComputedStyle(element).backgroundColor || "#ffffff";
  wrapper.appendChild(element);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject width="${width}" height="${height}">${new XMLSerializer().serializeToString(wrapper)}</foreignObject>`,
    "</svg>",
  ].join("");
  const image = new Image();
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法生成表格图片"));
    image.src = source;
  });
}

function cloneElementWithInlineStyles(element: HTMLElement): HTMLElement {
  const clone = element.cloneNode(false) as HTMLElement;
  copyComputedStyles(element, clone);

  for (const child of Array.from(element.childNodes)) {
    if (child instanceof HTMLElement) {
      if (child.hasAttribute("data-markdown-table-actions")) {
        continue;
      }
      clone.appendChild(cloneElementWithInlineStyles(child));
    } else {
      clone.appendChild(child.cloneNode(true));
    }
  }

  return clone;
}

function copyComputedStyles(source: HTMLElement, target: HTMLElement): void {
  const computedStyle = getComputedStyle(source);
  const styleNames = [
    "backgroundColor",
    "borderCollapse",
    "borderColor",
    "borderRadius",
    "borderStyle",
    "borderWidth",
    "boxSizing",
    "color",
    "display",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "lineHeight",
    "margin",
    "maxWidth",
    "minWidth",
    "overflowWrap",
    "padding",
    "textAlign",
    "verticalAlign",
    "whiteSpace",
    "width",
  ];

  for (const styleName of styleNames) {
    target.style.setProperty(toKebabCase(styleName), computedStyle.getPropertyValue(toKebabCase(styleName)));
  }
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
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
