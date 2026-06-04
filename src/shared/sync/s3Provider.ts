import { createS3AuthorizationHeaders } from "./s3SigV4";
import { assertValidSyncRemoteBackup, createSyncRemoteBackupMeta, type SyncRemoteBackup, type SyncRemoteBackupMeta, type SyncRemoteProvider } from "./types";

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
      const url = createS3ObjectUrl(normalizedConfig, createS3BackupObjectKey(normalizedConfig, prefix, backup.createdAt));
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
    async list() {
      const ids = (await listS3ObjectKeys(fetcher, normalizedConfig)).filter((key) => key.endsWith(".json"));
      const backups = await Promise.all(
        ids.map(async (id) => {
          const backup = await readS3Backup(fetcher, normalizedConfig, id);
          return backup ? createSyncRemoteBackupMeta(id, backup) : undefined;
        }),
      );

      return backups.filter((backup): backup is SyncRemoteBackupMeta => Boolean(backup)).sort((left, right) => right.createdAt - left.createdAt);
    },
    async read(id) {
      return readS3Backup(fetcher, normalizedConfig, id);
    },
    async delete(id) {
      const url = createS3ObjectUrl(normalizedConfig, id);
      const authHeaders = await createS3AuthorizationHeaders({
        method: "DELETE",
        url,
        accessKeyId: normalizedConfig.accessKeyId,
        secretAccessKey: normalizedConfig.secretAccessKey,
        region: normalizedConfig.region,
        payload: "",
      });
      const response = await fetcher(url.toString(), {
        method: "DELETE",
        headers: authHeaders,
      });

      if (!response.ok) {
        throw new Error("S3 旧备份删除失败，请检查对象删除权限");
      }
    },
  };
}

async function listS3ObjectKeys(fetcher: Fetcher, config: S3ProviderConfig): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const url = createS3ListUrl(config, continuationToken);
    const authHeaders = await createS3AuthorizationHeaders({
      method: "GET",
      url,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      payload: "",
    });
    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: authHeaders,
    });

    if (!response.ok) {
      throw new Error("S3 备份列表读取失败，请检查 Bucket 或对象前缀权限");
    }

    const xml = await response.text();
    keys.push(...parseS3ObjectKeys(xml));
    continuationToken = parseS3IsTruncated(xml) ? parseS3NextContinuationToken(xml) : undefined;
  } while (continuationToken);

  return keys;
}

async function readS3Backup(fetcher: Fetcher, config: S3ProviderConfig, id: string): Promise<SyncRemoteBackup | undefined> {
  const url = createS3ObjectUrl(config, id);
  const authHeaders = await createS3AuthorizationHeaders({
    method: "GET",
    url,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
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

function createS3ListUrl(config: S3ProviderConfig, continuationToken?: string): URL {
  const baseUrl = config.endpointUrl.replace(/\/+$/, "");
  const keyPrefix = config.objectKeyPrefix.replace(/^\/+|\/+$/g, "");
  const url = new URL(`${baseUrl}/${encodeURIComponent(config.bucket)}`);
  url.searchParams.set("list-type", "2");
  if (keyPrefix) {
    url.searchParams.set("prefix", `${keyPrefix}/`);
  }
  if (continuationToken) {
    url.searchParams.set("continuation-token", continuationToken);
  }
  return url;
}

function createS3ObjectUrl(config: S3ProviderConfig, id: string): URL {
  const baseUrl = config.endpointUrl.replace(/\/+$/, "");
  const objectKey = id;
  return new URL(`${baseUrl}/${encodeURIComponent(config.bucket)}/${objectKey.split("/").map(encodeURIComponent).join("/")}`);
}

function createS3BackupObjectKey(config: S3ProviderConfig, prefix: string, createdAt: number): string {
  const keyPrefix = config.objectKeyPrefix.replace(/^\/+|\/+$/g, "");
  const fileName = `${createS3ObjectPrefixPart(prefix)}--${createdAt}.json`;
  return keyPrefix ? `${keyPrefix}/${fileName}` : fileName;
}

function createS3ObjectPrefixPart(prefix: string): string {
  return prefix;
}

function parseS3ObjectKeys(xml: string): string[] {
  return Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/gi)).map((match) => decodeXmlText(match[1]));
}

function parseS3IsTruncated(xml: string): boolean {
  return /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
}

function parseS3NextContinuationToken(xml: string): string | undefined {
  const match = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/i);
  return match ? decodeXmlText(match[1]) : undefined;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
