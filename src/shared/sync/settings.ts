import type { S3SyncSettings, SyncProviderType, SyncSecrets, SyncSettings, WebDavSyncSettings } from "./types";
import { getAppSetting, saveAppSetting } from "../storage/repositories";

export const SYNC_SETTINGS_KEY = "syncSettings";
export const SYNC_ENCRYPTION_SECRET_KEY = "syncEncryptionSecret";
export const SYNC_WEBDAV_PASSWORD_KEY = "syncWebDavPassword";
export const SYNC_S3_SECRET_KEY = "syncS3SecretKey";

export const SYNC_SECRET_SETTING_KEYS = [
  SYNC_ENCRYPTION_SECRET_KEY,
  SYNC_WEBDAV_PASSWORD_KEY,
  SYNC_S3_SECRET_KEY,
];

const DEFAULT_WEBDAV_SETTINGS: WebDavSyncSettings = {
  endpointUrl: "",
  username: "",
  remotePath: "browser-ai-assistant",
};

const DEFAULT_S3_SETTINGS: S3SyncSettings = {
  endpointUrl: "",
  accessKeyId: "",
  bucket: "",
  region: "auto",
  objectKeyPrefix: "browser-ai-assistant",
};

export const DEFAULT_SYNC_SECRETS: SyncSecrets = {
  encryptionSecret: "",
  webDavPassword: "",
  s3SecretKey: "",
};

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  syncEnabled: false,
  autoSyncEnabled: false,
  provider: "chrome_sync",
  backupPrefix: "device-local",
  encryptionEnabled: false,
  intervalMinutes: 60,
  webdav: DEFAULT_WEBDAV_SETTINGS,
  s3: DEFAULT_S3_SETTINGS,
};

export function normalizeSyncSettings(value: Partial<SyncSettings> | undefined): SyncSettings {
  return {
    syncEnabled: value?.syncEnabled ?? DEFAULT_SYNC_SETTINGS.syncEnabled,
    autoSyncEnabled: value?.autoSyncEnabled ?? DEFAULT_SYNC_SETTINGS.autoSyncEnabled,
    provider: normalizeProvider(value?.provider),
    backupPrefix: value?.backupPrefix === undefined ? DEFAULT_SYNC_SETTINGS.backupPrefix : String(value.backupPrefix).trim(),
    encryptionEnabled: value?.encryptionEnabled ?? DEFAULT_SYNC_SETTINGS.encryptionEnabled,
    intervalMinutes: normalizeIntervalMinutes(value?.intervalMinutes),
    webdav: normalizeWebDavSettings(value?.webdav),
    s3: normalizeS3Settings(value?.s3),
    lastBackupAt: normalizeOptionalTimestamp(value?.lastBackupAt),
    lastRestoreAt: normalizeOptionalTimestamp(value?.lastRestoreAt),
    lastStatus: normalizeLastStatus(value?.lastStatus),
    lastMessage: typeof value?.lastMessage === "string" ? value.lastMessage : undefined,
  };
}

export async function getSyncSettings(): Promise<SyncSettings> {
  return normalizeSyncSettings(await getAppSetting<Partial<SyncSettings>>(SYNC_SETTINGS_KEY));
}

export async function saveSyncSettings(settings: SyncSettings): Promise<void> {
  await saveAppSetting({
    key: SYNC_SETTINGS_KEY,
    value: settings,
    updatedAt: Date.now(),
  });
}

export async function getSyncSecrets(): Promise<SyncSecrets> {
  const [encryptionSecret, webDavPassword, s3SecretKey] = await Promise.all([
    getAppSetting<string>(SYNC_ENCRYPTION_SECRET_KEY),
    getAppSetting<string>(SYNC_WEBDAV_PASSWORD_KEY),
    getAppSetting<string>(SYNC_S3_SECRET_KEY),
  ]);

  return {
    encryptionSecret: typeof encryptionSecret === "string" ? encryptionSecret : "",
    webDavPassword: typeof webDavPassword === "string" ? webDavPassword : "",
    s3SecretKey: typeof s3SecretKey === "string" ? s3SecretKey : "",
  };
}

function normalizeProvider(value: unknown): SyncProviderType {
  return value === "webdav" || value === "s3" || value === "chrome_sync" ? value : DEFAULT_SYNC_SETTINGS.provider;
}

function normalizeIntervalMinutes(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return DEFAULT_SYNC_SETTINGS.intervalMinutes;
  }

  return Math.max(1, Math.round(numberValue));
}

function normalizeWebDavSettings(value: Partial<WebDavSyncSettings> | undefined): WebDavSyncSettings {
  return {
    endpointUrl: typeof value?.endpointUrl === "string" ? value.endpointUrl.trim() : DEFAULT_WEBDAV_SETTINGS.endpointUrl,
    username: typeof value?.username === "string" ? value.username.trim() : DEFAULT_WEBDAV_SETTINGS.username,
    remotePath: typeof value?.remotePath === "string" && value.remotePath.trim()
      ? value.remotePath.trim()
      : DEFAULT_WEBDAV_SETTINGS.remotePath,
  };
}

function normalizeS3Settings(value: Partial<S3SyncSettings> | undefined): S3SyncSettings {
  return {
    endpointUrl: typeof value?.endpointUrl === "string" ? value.endpointUrl.trim() : DEFAULT_S3_SETTINGS.endpointUrl,
    accessKeyId: typeof value?.accessKeyId === "string" ? value.accessKeyId.trim() : DEFAULT_S3_SETTINGS.accessKeyId,
    bucket: typeof value?.bucket === "string" ? value.bucket.trim() : DEFAULT_S3_SETTINGS.bucket,
    region: typeof value?.region === "string" && value.region.trim() ? value.region.trim() : DEFAULT_S3_SETTINGS.region,
    objectKeyPrefix:
      typeof value?.objectKeyPrefix === "string" && value.objectKeyPrefix.trim()
        ? value.objectKeyPrefix.trim()
        : DEFAULT_S3_SETTINGS.objectKeyPrefix,
  };
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLastStatus(value: unknown): SyncSettings["lastStatus"] {
  return value === "idle" || value === "success" || value === "error" ? value : undefined;
}
