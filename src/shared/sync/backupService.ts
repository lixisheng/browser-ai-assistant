import { decryptJson, encryptJson } from "../crypto/encryption";
import { getSyncSecrets, getSyncSettings, saveSyncSettings } from "./settings";
import { exportSyncSnapshot, restoreSyncSnapshot } from "./snapshot";
import { createChromeSyncProvider } from "./chromeSyncProvider";
import { createS3Provider } from "./s3Provider";
import { createWebDavProvider } from "./webDavProvider";
import type { SyncDataSnapshot, SyncRemoteBackup, SyncRemoteBackupMeta, SyncRemoteProvider, SyncSecrets, SyncSettings } from "./types";

interface SyncOperationInput {
  provider: SyncRemoteProvider;
}

interface SyncRestoreInput extends SyncOperationInput {
  backupId: string;
}

export async function backupNow(input: SyncOperationInput): Promise<SyncRemoteBackup> {
  const settings = await getSyncSettings();
  assertSyncEnabled(settings);
  assertBackupPrefix(settings.backupPrefix);
  const secrets = await getSyncSecrets();

  if (settings.encryptionEnabled && !secrets.encryptionSecret) {
    throw new Error("请先设置本地加密密钥");
  }

  const snapshot = await exportSyncSnapshot();
  const payload = settings.encryptionEnabled ? await encryptJson(snapshot, secrets.encryptionSecret) : snapshot;
  const backup: SyncRemoteBackup = {
    version: 1,
    createdAt: Date.now(),
    prefix: settings.backupPrefix,
    provider: settings.provider,
    encrypted: settings.encryptionEnabled,
    payload,
  };

  await input.provider.write(settings.backupPrefix, backup);
  await pruneOldBackups(input.provider, settings.backupPrefix, settings.maxBackupCount);
  await saveSyncSettings({
    ...settings,
    lastBackupAt: backup.createdAt,
    lastStatus: "success",
    lastMessage: "备份完成",
  });

  return backup;
}

export async function listRemoteBackups(input: SyncOperationInput): Promise<SyncRemoteBackupMeta[]> {
  const settings = await getSyncSettings();
  assertSyncEnabled(settings);
  return input.provider.list();
}

export async function restoreNow(input: SyncRestoreInput): Promise<void> {
  const settings = await getSyncSettings();
  assertSyncEnabled(settings);
  assertBackupPrefix(settings.backupPrefix);
  const backup = await input.provider.read(input.backupId);

  if (!backup) {
    throw new Error("未找到指定的同步备份");
  }
  if (backup.provider !== settings.provider) {
    throw new Error("备份目标不匹配，未覆盖本地数据");
  }

  const secrets = await getSyncSecrets();
  const snapshot = await resolveBackupSnapshot(backup, secrets.encryptionSecret);
  await restoreSyncSnapshot(snapshot);
  await saveSyncSettings({
    ...settings,
    lastRestoreAt: Date.now(),
    lastStatus: "success",
    lastMessage: "恢复完成",
  });
}

async function pruneOldBackups(provider: SyncRemoteProvider, prefix: string, maxBackupCount: number): Promise<void> {
  const backups = (await provider.list())
    .filter((backup) => backup.prefix === prefix)
    .sort((left, right) => left.createdAt - right.createdAt);
  const deleteCount = backups.length - maxBackupCount;

  if (deleteCount <= 0) {
    return;
  }

  await Promise.all(backups.slice(0, deleteCount).map((backup) => provider.delete(backup.id)));
}

export function resolveProviderFromSettings(
  settings: SyncSettings,
  secrets: SyncSecrets,
  chromeStorageArea: chrome.storage.StorageArea,
  fetcher: typeof fetch,
): SyncRemoteProvider {
  if (settings.provider === "webdav") {
    return createWebDavProvider(fetcher, {
      ...settings.webdav,
      password: secrets.webDavPassword,
    });
  }

  if (settings.provider === "s3") {
    return createS3Provider(fetcher, {
      ...settings.s3,
      secretAccessKey: secrets.s3SecretKey,
    });
  }

  return createChromeSyncProvider(chromeStorageArea);
}

function assertSyncEnabled(settings: SyncSettings): void {
  if (!settings.syncEnabled) {
    throw new Error("请先开启同步功能");
  }
}

function assertBackupPrefix(prefix: string): void {
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) {
    throw new Error("请先设置备份文件前缀");
  }
  if (/[\\/]/.test(normalizedPrefix) || normalizedPrefix.includes("..")) {
    throw new Error("备份文件前缀不能包含路径分隔符或连续点号");
  }
}

async function resolveBackupSnapshot(backup: SyncRemoteBackup, encryptionSecret: string): Promise<SyncDataSnapshot> {
  if (!backup.encrypted) {
    return backup.payload as SyncDataSnapshot;
  }
  if (!encryptionSecret) {
    throw new Error("请先设置本地加密密钥");
  }

  try {
    return await decryptJson<SyncDataSnapshot>(backup.payload as Parameters<typeof decryptJson>[0], encryptionSecret);
  } catch {
    throw new Error("无法解密同步数据，请确认本地密钥是否正确");
  }
}
