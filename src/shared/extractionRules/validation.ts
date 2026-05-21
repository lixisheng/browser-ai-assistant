export interface ExtractionRuleDraft {
  alias: string;
  urlPattern: string;
  selectorsText: string;
}

export type ExtractionRuleValidationResult = { ok: true } | { ok: false; message: string };

export function validateExtractionRuleDraft(draft: ExtractionRuleDraft): ExtractionRuleValidationResult {
  const urlPattern = draft.urlPattern.trim();
  if (!urlPattern) {
    return { ok: false, message: "URL 正则不能为空" };
  }

  try {
    new RegExp(urlPattern);
  } catch {
    return { ok: false, message: "URL 正则格式不正确" };
  }

  const selectors = getSelectorLines(draft.selectorsText);
  if (selectors.length === 0) {
    return { ok: false, message: "请至少填写一条 CSS 或 XPath" };
  }

  for (const [index, selector] of selectors.entries()) {
    if (!isValidCssSelector(selector) && !isValidXPath(selector)) {
      return { ok: false, message: `第 ${index + 1} 行 CSS/XPath 格式不正确` };
    }
  }

  return { ok: true };
}

export function getSelectorLines(selectorsText: string): string[] {
  return selectorsText
    .split(/\r?\n/)
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function isValidCssSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function isValidXPath(selector: string): boolean {
  try {
    document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return true;
  } catch {
    return false;
  }
}
