import { normalizeText, truncateText } from "../shared/utils/text";
import type { ExtractionRule } from "../shared/types";

export interface ExtractPageTextInput {
  url: string;
  rules: ExtractionRule[];
  maxLength: number;
}

export interface ExtractPageTextResult {
  text: string;
  truncated: boolean;
  usedFallback: boolean;
}

export function extractPageText(input: ExtractPageTextInput): ExtractPageTextResult {
  const matchedRule = input.rules.find((rule) => matchUrl(rule.urlPattern, input.url));
  const extractedText = matchedRule ? extractBySelectors(matchedRule.selectorsText) : "";
  const usedFallback = extractedText.length === 0;
  const rawText = usedFallback ? extractGlobalText() : extractedText;
  const normalizedText = normalizeText(rawText);
  const truncated = truncateText(normalizedText, input.maxLength);

  return {
    ...truncated,
    usedFallback,
  };
}

function matchUrl(pattern: string, url: string): boolean {
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return false;
  }
}

function extractBySelectors(selectorsText: string): string {
  const selectors = selectorsText
    .split(/\r?\n/)
    .map((selector) => selector.trim())
    .filter(Boolean);
  const parts: string[] = [];

  for (const selector of selectors) {
    const selectorText = extractByCss(selector) || extractByXPath(selector);
    if (selectorText) {
      parts.push(selectorText);
    }
  }

  return normalizeText(parts.join(" "));
}

function extractByCss(selector: string): string {
  try {
    const nodes = Array.from(document.querySelectorAll(selector));
    return normalizeText(nodes.map((node) => node.textContent ?? "").join(" "));
  } catch {
    return "";
  }
}

function extractByXPath(xpath: string): string {
  try {
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const parts: string[] = [];

    for (let index = 0; index < result.snapshotLength; index += 1) {
      parts.push(result.snapshotItem(index)?.textContent ?? "");
    }

    return normalizeText(parts.join(" "));
  } catch {
    return "";
  }
}

function extractGlobalText(): string {
  return extractTextFromNode(document.documentElement);
}

function extractTextFromNode(root: Node): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    const text = normalizeText(currentNode.textContent ?? "");
    if (text) {
      parts.push(text);
    }
    currentNode = walker.nextNode();
  }

  return normalizeText(parts.join(" "));
}
