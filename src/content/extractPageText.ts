import { normalizeText, truncateText } from "../shared/utils/text";
import type { ExtractionRule } from "../shared/types";
import { getSelectorLines } from "../shared/extractionRules/validation";

export interface ExtractPageTextInput {
  url: string;
  rules: ExtractionRule[];
  maxLength: number;
}

export interface ExtractPageTextResult {
  text: string;
  truncated: boolean;
  usedFallback: boolean;
  matchedRuleId?: string;
}

export function extractPageText(input: ExtractPageTextInput): ExtractPageTextResult {
  const matchedRule = [...input.rules].sort((left, right) => left.sortOrder - right.sortOrder).find((rule) => matchUrl(rule.urlPattern, input.url));
  const extractedText = matchedRule ? extractBySelectors(matchedRule.selectorsText) : "";
  const usedFallback = extractedText.length === 0;
  const rawText = usedFallback ? extractGlobalText() : extractedText;
  const normalizedText = normalizeText(rawText);
  const truncated = truncateText(normalizedText, input.maxLength);

  return {
    ...truncated,
    usedFallback,
    matchedRuleId: matchedRule?.id,
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
  const selectors = getSelectorLines(selectorsText);
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
    return normalizeText(nodes.map((node) => extractVisibleTextFromNode(node)).join(" "));
  } catch {
    return "";
  }
}

function extractByXPath(xpath: string): string {
  try {
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const parts: string[] = [];

    for (let index = 0; index < result.snapshotLength; index += 1) {
      const node = result.snapshotItem(index);
      if (node) {
        parts.push(extractVisibleTextFromNode(node));
      }
    }

    return normalizeText(parts.join(" "));
  } catch {
    return "";
  }
}

function extractGlobalText(): string {
  return extractVisibleTextFromNode(document.body);
}

function extractVisibleTextFromNode(root: Node): string {
  if (shouldSkipNode(root)) {
    return "";
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    if (!shouldSkipNode(currentNode)) {
      const text = normalizeText(currentNode.textContent ?? "");
      if (text) {
        parts.push(text);
      }
    }
    currentNode = walker.nextNode();
  }

  return normalizeText(parts.join(" "));
}

function shouldSkipNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) {
    return true;
  }

  if (!document.body.contains(element)) {
    return true;
  }

  return Boolean(element.closest("script, style, template, noscript, [hidden], [aria-hidden='true']")) || isElementHidden(element);
}

function isElementHidden(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
}
