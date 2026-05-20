export interface ModelRequestPayload {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ModelValidationResult {
  ok: boolean;
  message: string;
}
