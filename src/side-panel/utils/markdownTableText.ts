const MARKDOWN_TABLE_ACTIONS_SELECTOR = "[data-markdown-table-actions]";

export function getTextWithoutMarkdownTableActions(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const action of Array.from(clone.querySelectorAll(MARKDOWN_TABLE_ACTIONS_SELECTOR))) {
    action.remove();
  }
  return clone.textContent ?? "";
}
