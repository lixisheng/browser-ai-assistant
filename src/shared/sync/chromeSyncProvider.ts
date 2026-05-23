import { getChromeSyncQuotaMessage } from "../../background/syncBackupHandler";
import { assertValidSyncRemoteBackup, type SyncRemoteBackup, type SyncRemoteProvider } from "./types";

const BACKUP_KEY_PREFIX = "browserAiAssistantBackup:";
const DEFAULT_QUOTA_BYTES_PER_ITEM = 8192;

export function createChromeSyncProvider(storageArea: chrome.storage.StorageArea): SyncRemoteProvider {
  return {
    async write(prefix, backup) {
      const key = createChromeSyncBackupKey(prefix);
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
    async read(prefix) {
      const key = createChromeSyncBackupKey(prefix);
      const result = await storageArea.get(key);
      const backup = result[key] as unknown;
      if (backup === undefined) {
        return undefined;
      }

      assertValidSyncRemoteBackup(backup);
      return backup;
    },
  };
}

export function createChromeSyncBackupKey(prefix: string): string {
  return `${BACKUP_KEY_PREFIX}${prefix}`;
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
