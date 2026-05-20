import { validateModelConfig } from "./modelValidation";
import type { ModelValidationResult } from "./types";
import type { ModelConfig, ModelProvider, ProviderModel } from "../types";

export interface RemoteModelInfo {
  id: string;
  displayName: string;
}

export interface ModelListRequest {
  url: string;
  headers: Record<string, string>;
}

type Fetcher = typeof fetch;

export function createListModelsRequest(provider: ModelProvider): ModelListRequest {
  if (provider.endpointType === "anthropic_messages") {
    return {
      url: createSiblingEndpointUrl(provider.endpointUrl, "models"),
      headers: {
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
  }

  return {
    url: createSiblingEndpointUrl(provider.endpointUrl, "models"),
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
    },
  };
}

export async function fetchProviderModels(provider: ModelProvider, fetcher: Fetcher = fetch): Promise<RemoteModelInfo[]> {
  const request = createListModelsRequest(provider);
  const response = await fetcher(request.url, {
    method: "GET",
    headers: request.headers,
  });

  if (!response.ok) {
    throw new Error(`获取模型列表失败：${response.status} ${response.statusText}`);
  }

  return parseModelListResponse(await response.json());
}

export function parseModelListResponse(responseBody: unknown): RemoteModelInfo[] {
  if (!isObject(responseBody) || !Array.isArray(responseBody.data)) {
    return [];
  }

  return responseBody.data
    .map((item) => {
      if (!isObject(item) || typeof item.id !== "string" || item.id.trim().length === 0) {
        return undefined;
      }

      const displayName =
        typeof item.display_name === "string" && item.display_name.trim().length > 0
          ? item.display_name
          : typeof item.displayName === "string" && item.displayName.trim().length > 0
            ? item.displayName
            : item.id;

      return {
        id: item.id,
        displayName,
      };
    })
    .filter((item): item is RemoteModelInfo => Boolean(item));
}

export async function testProviderModel(
  provider: ModelProvider,
  model: ProviderModel,
  fetcher: Fetcher = fetch,
): Promise<ModelValidationResult> {
  const result = await validateModelConfig(createModelConfig(provider, model), fetcher);

  return result.ok
    ? {
        ok: true,
        message: "模型测试通过",
      }
    : {
        ok: false,
        message: result.message.replace("API Key 校验失败", "模型测试失败"),
      };
}

export function createModelConfig(provider: ModelProvider, model: ProviderModel): ModelConfig {
  return {
    ...model,
    name: model.displayName,
    channelName: provider.name,
    endpointType: provider.endpointType,
    endpointUrl: provider.endpointUrl,
    apiKey: provider.apiKey,
  };
}

function createSiblingEndpointUrl(endpointUrl: string, siblingName: string): string {
  const url = new URL(endpointUrl);
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    url.pathname = `/${siblingName}`;
    return url.toString();
  }

  if (segments.at(-1) === "completions" && segments.at(-2) === "chat") {
    segments.splice(segments.length - 2, 2, siblingName);
  } else {
    segments[segments.length - 1] = siblingName;
  }

  url.pathname = `/${segments.join("/")}`;
  return url.toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
