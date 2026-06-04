import { assertValidSyncRemoteBackup, createSyncRemoteBackupMeta, type SyncRemoteBackup, type SyncRemoteBackupMeta, type SyncRemoteProvider } from "./types";

type Fetcher = typeof fetch;

interface WebDavProviderConfig {
  endpointUrl: string;
  username: string;
  password: string;
  remotePath: string;
}

export function createWebDavProvider(fetcher: Fetcher, config: WebDavProviderConfig): SyncRemoteProvider {
  const normalizedConfig = normalizeWebDavProviderConfig(config);

  return {
    async write(prefix, backup) {
      const body = JSON.stringify(backup);
      const response = await putWebDavBackup(fetcher, normalizedConfig, createWebDavBackupFileName(prefix, backup.createdAt), body);

      if (!response.ok) {
        const responseText = await readResponseText(response);
        if (isWebDavCollectionMissingResponse(response, responseText)) {
          await ensureWebDavCollection(fetcher, normalizedConfig);
          const retryResponse = await putWebDavBackup(fetcher, normalizedConfig, createWebDavBackupFileName(prefix, backup.createdAt), body);
          if (retryResponse.ok) {
            return;
          }
        }

        throw new Error("WebDAV 备份失败，请检查服务器地址、远程路径或权限");
      }
    },
    async list() {
      const response = await fetcher(createWebDavCollectionUrl(normalizedConfig), {
        method: "PROPFIND",
        headers: {
          Authorization: createBasicAuthHeader(normalizedConfig.username, normalizedConfig.password),
          Depth: "1",
        },
      });

      if (!response.ok) {
        throw new Error("WebDAV 备份列表读取失败，请检查远程目录是否存在");
      }

      const ids = parseWebDavBackupFileIds(await response.text());
      const backups = await Promise.all(
        ids.map(async (id) => {
          const backup = await readWebDavBackup(fetcher, normalizedConfig, id);
          return backup ? createSyncRemoteBackupMeta(id, backup) : undefined;
        }),
      );

      return backups.filter((backup): backup is SyncRemoteBackupMeta => Boolean(backup)).sort((left, right) => right.createdAt - left.createdAt);
    },
    async read(id) {
      return readWebDavBackup(fetcher, normalizedConfig, id);
    },
    async delete(id) {
      const response = await fetcher(createWebDavFileUrl(normalizedConfig, id), {
        method: "DELETE",
        headers: {
          Authorization: createBasicAuthHeader(normalizedConfig.username, normalizedConfig.password),
        },
      });

      if (!response.ok) {
        throw new Error("WebDAV 旧备份删除失败，请检查远程文件权限");
      }
    },
  };
}

async function readWebDavBackup(fetcher: Fetcher, config: WebDavProviderConfig, id: string): Promise<SyncRemoteBackup | undefined> {
  const response = await fetcher(createWebDavFileUrl(config, id), {
    method: "GET",
    headers: {
      Authorization: createBasicAuthHeader(config.username, config.password),
    },
  });

  if (!response.ok) {
    throw new Error("WebDAV 恢复失败，请检查备份文件是否存在");
  }

  const backup = JSON.parse(await response.text()) as unknown;
  assertValidSyncRemoteBackup(backup);
  return backup;
}

function normalizeWebDavProviderConfig(config: WebDavProviderConfig): WebDavProviderConfig {
  const endpointUrl = config.endpointUrl.trim();
  const username = config.username.trim();
  const password = config.password;
  const remotePath = config.remotePath.trim();

  if (!endpointUrl || !username || !password || !remotePath) {
    throw new Error("请完整填写 WebDAV 地址、用户名、密码和远程路径");
  }
  if (!/^https?:\/\//i.test(endpointUrl)) {
    throw new Error("WebDAV 地址必须以 http:// 或 https:// 开头");
  }
  if (remotePath.split(/[\\/]+/).some((part) => part === "..")) {
    throw new Error("WebDAV 远程路径不能包含路径穿越片段");
  }

  return { endpointUrl, username, password, remotePath };
}

function createWebDavCollectionUrl(config: WebDavProviderConfig): string {
  const baseUrl = config.endpointUrl.replace(/\/+$/, "");
  const remotePath = config.remotePath.replace(/^\/+|\/+$/g, "");

  return `${baseUrl}/${remotePath}`;
}

function createWebDavFileUrl(config: WebDavProviderConfig, fileName: string): string {
  return `${createWebDavCollectionUrl(config)}/${encodeURIComponent(fileName)}`;
}

function createWebDavBackupFileName(prefix: string, createdAt: number): string {
  return `${prefix}--${createdAt}.json`;
}

function createWebDavCollectionUrls(config: WebDavProviderConfig): string[] {
  const baseUrl = config.endpointUrl.replace(/\/+$/, "");
  const pathParts = config.remotePath.replace(/^\/+|\/+$/g, "").split(/[\\/]+/).filter(Boolean);

  return pathParts.map((_, index) => `${baseUrl}/${pathParts.slice(0, index + 1).map(encodeURIComponent).join("/")}`);
}

function parseWebDavBackupFileIds(xml: string): string[] {
  return Array.from(xml.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi))
    .map((match) => decodeURIComponent(match[1].split("/").filter(Boolean).pop() ?? ""))
    .filter((fileName) => fileName.endsWith(".json"));
}

async function ensureWebDavCollection(fetcher: Fetcher, config: WebDavProviderConfig): Promise<void> {
  const authHeader = createBasicAuthHeader(config.username, config.password);

  // WebDAV 要求父目录先存在；坚果云在父级缺失时会返回 AncestorsNotFound，因此这里按层级补齐目录。
  for (const collectionUrl of createWebDavCollectionUrls(config)) {
    const response = await fetcher(collectionUrl, {
      method: "MKCOL",
      headers: {
        Authorization: authHeader,
      },
    });

    if (!response.ok && response.status !== 405) {
      throw new Error("WebDAV 目录创建失败，请检查远程路径或权限");
    }
  }
}

async function putWebDavBackup(
  fetcher: Fetcher,
  config: WebDavProviderConfig,
  prefix: string,
  body: string,
): Promise<Response> {
  return fetcher(createWebDavFileUrl(config, prefix), {
    method: "PUT",
    headers: {
      Authorization: createBasicAuthHeader(config.username, config.password),
      "Content-Type": "application/json",
    },
    body,
  });
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isWebDavCollectionMissingResponse(response: Response, responseText: string): boolean {
  return response.status === 409 || responseText.includes("AncestorsNotFound");
}

function createBasicAuthHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}
