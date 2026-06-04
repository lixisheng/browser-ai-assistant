import { getChromeSyncQuotaMessage } from "../../background/syncBackupHandler";
import { assertValidSyncRemoteBackup, createSyncRemoteBackupMeta, type SyncRemoteBackup, type SyncRemoteBackupMeta, type SyncRemoteProvider } from "./types";

const BACKUP_KEY_PREFIX = "browserAiAssistantBackup:";
const DEFAULT_QUOTA_BYTES_PER_ITEM = 8192;

export function createChromeSyncProvider(storageArea: chrome.storage.StorageArea): SyncRemoteProvider {
  return {
    async write(prefix, backup) {
      const key = createChromeSyncBackupKey(prefix, backup.createdAt);
      assertChromeSyncItemSize(storageArea, key, backup);

      try {
        await storageArea.set({ [key]: backup });
      } catch (error) {
        if (isChromeSyncQuotaError(error)) {
          throw new Error(getChromeSyncQuotaMessage());
        }

        throw error;
      }
    },
    async list() {
      const keys = await getChromeSyncBackupKeys(storageArea);
      const backups = await Promise.all(
        keys.map(async (key) => {
          const backup = await readChromeSyncBackup(storageArea, key);
          return backup ? createSyncRemoteBackupMeta(key, backup) : undefined;
        }),
      );

      return backups.filter((backup): backup is SyncRemoteBackupMeta => Boolean(backup)).sort((left, right) => right.createdAt - left.createdAt);
    },
    async read(id) {
      const backup = await readChromeSyncBackup(storageArea, normalizeChromeSyncBackupId(id));
      if (backup === undefined) {
        return undefined;
      }

      return backup;
    },
    async delete(id) {
      await storageArea.remove(normalizeChromeSyncBackupId(id));
    },
  };
}

export function createChromeSyncBackupKey(prefix: string, createdAt?: number): string {
  return createdAt === undefined ? `${BACKUP_KEY_PREFIX}${prefix}` : `${BACKUP_KEY_PREFIX}${prefix}:${createdAt}`;
}

function normalizeChromeSyncBackupId(id: string): string {
  return id.startsWith(BACKUP_KEY_PREFIX) ? id : createChromeSyncBackupKey(id);
}

async function getChromeSyncBackupKeys(storageArea: chrome.storage.StorageArea): Promise<string[]> {
  const maybeStorageArea = storageArea as chrome.storage.StorageArea & { getKeys?: () => Promise<string[]> };
  if (typeof maybeStorageArea.getKeys === "function") {
    return (await maybeStorageArea.getKeys()).filter((key) => key.startsWith(BACKUP_KEY_PREFIX));
  }

  const result = await storageArea.get(null);
  return Object.keys(result).filter((key) => key.startsWith(BACKUP_KEY_PREFIX));
}

async function readChromeSyncBackup(storageArea: chrome.storage.StorageArea, key: string): Promise<SyncRemoteBackup | undefined> {
  if (!key.startsWith(BACKUP_KEY_PREFIX)) {
    return undefined;
  }

  const result = await storageArea.get(key);
  const backup = result[key] as unknown;
  if (backup === undefined) {
    return undefined;
  }

  assertValidSyncRemoteBackup(backup);
  return backup;
}

function assertChromeSyncItemSize(storageArea: chrome.storage.StorageArea, key: string, backup: SyncRemoteBackup): void {
  const quotaBytesPerItem = getStorageAreaQuotaBytesPerItem(storageArea) ?? DEFAULT_QUOTA_BYTES_PER_ITEM;
  const bytes = new TextEncoder().encode(JSON.stringify({ [key]: backup })).byteLength;

  if (bytes > quotaBytesPerItem) {
    throw new Error(getChromeSyncQuotaMessage());
  }
}

function getStorageAreaQuotaBytesPerItem(storageArea: chrome.storage.StorageArea): number | undefined {
  const maybeStorageArea = storageArea as chrome.storage.StorageArea & { QUOTA_BYTES_PER_ITEM?: unknown };
  return typeof maybeStorageArea.QUOTA_BYTES_PER_ITEM === "number" ? maybeStorageArea.QUOTA_BYTES_PER_ITEM : undefined;
}

function isChromeSyncQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|QUOTA|MAX_WRITE/.test(message);
}
