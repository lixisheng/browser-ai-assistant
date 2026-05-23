import { createS3AuthorizationHeaders } from "./s3SigV4";
import { assertValidSyncRemoteBackup, type SyncRemoteBackup, type SyncRemoteProvider } from "./types";

type Fetcher = typeof fetch;

interface S3ProviderConfig {
  endpointUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  objectKeyPrefix: string;
}

export function createS3Provider(fetcher: Fetcher, config: S3ProviderConfig): SyncRemoteProvider {
  const normalizedConfig = normalizeS3ProviderConfig(config);

  return {
    async write(prefix, backup) {
      const body = JSON.stringify(backup);
      const url = createS3ObjectUrl(normalizedConfig, prefix);
      const authHeaders = await createS3AuthorizationHeaders({
        method: "PUT",
        url,
        accessKeyId: normalizedConfig.accessKeyId,
        secretAccessKey: normalizedConfig.secretAccessKey,
        region: normalizedConfig.region,
        payload: body,
      });
      const response = await fetcher(url.toString(), {
        method: "PUT",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        throw new Error("S3 备份失败，请检查 Endpoint、Bucket、密钥或权限");
      }
    },
    async read(prefix) {
      const url = createS3ObjectUrl(normalizedConfig, prefix);
      const authHeaders = await createS3AuthorizationHeaders({
        method: "GET",
        url,
        accessKeyId: normalizedConfig.accessKeyId,
        secretAccessKey: normalizedConfig.secretAccessKey,
        region: normalizedConfig.region,
        payload: "",
      });
      const response = await fetcher(url.toString(), {
        method: "GET",
        headers: authHeaders,
      });

      if (!response.ok) {
        throw new Error("S3 恢复失败，请检查备份对象是否存在");
      }

      const backup = JSON.parse(await response.text()) as unknown;
      assertValidSyncRemoteBackup(backup);
      return backup;
    },
  };
}

function normalizeS3ProviderConfig(config: S3ProviderConfig): S3ProviderConfig {
  const endpointUrl = config.endpointUrl.trim();
  const accessKeyId = config.accessKeyId.trim();
  const secretAccessKey = config.secretAccessKey;
  const bucket = config.bucket.trim();
  const region = config.region.trim() || "auto";
  const objectKeyPrefix = config.objectKeyPrefix.trim();

  if (!endpointUrl || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("请完整填写 S3 Endpoint、Access Key、Secret Key 和 Bucket");
  }
  try {
    new URL(endpointUrl);
  } catch {
    throw new Error("S3 Endpoint 必须是合法 URL");
  }

  return { endpointUrl, accessKeyId, secretAccessKey, bucket, region, objectKeyPrefix };
}

function createS3ObjectUrl(config: S3ProviderConfig, prefix: string): URL {
  const baseUrl = config.endpointUrl.replace(/\/+$/, "");
  const keyPrefix = config.objectKeyPrefix.replace(/^\/+|\/+$/g, "");
  const objectKey = keyPrefix ? `${keyPrefix}/${prefix}.json` : `${prefix}.json`;
  return new URL(`${baseUrl}/${encodeURIComponent(config.bucket)}/${objectKey.split("/").map(encodeURIComponent).join("/")}`);
}
