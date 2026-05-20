export interface TruncateResult {
  text: string;
  truncated: boolean;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, maxLength: number): TruncateResult {
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }

  return { text: value.slice(0, maxLength), truncated: true };
}
