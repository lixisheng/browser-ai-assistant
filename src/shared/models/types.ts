export interface ModelRequestPayload {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface OpenAIJsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

export interface OpenAIToolChoiceResponseFormat {
  type: "tool";
  tool: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIStructuredOutputFormat = OpenAIJsonSchemaResponseFormat | OpenAIToolChoiceResponseFormat;

export interface ModelValidationResult {
  ok: boolean;
  message: string;
}
