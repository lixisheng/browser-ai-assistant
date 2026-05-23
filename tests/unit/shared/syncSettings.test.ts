import { describe, expect, it } from "vitest";
import { normalizeSyncSettings, SYNC_SECRET_SETTING_KEYS } from "../../../src/shared/sync/settings";

describe("同步设置", () => {
  it("默认关闭同步和自动同步，并默认使用 Chrome Sync", () => {
    expect(normalizeSyncSettings(undefined)).toMatchObject({
      syncEnabled: false,
      autoSyncEnabled: false,
      provider: "chrome_sync",
      encryptionEnabled: false,
      intervalMinutes: 60,
    });
  });

  it("定时同步间隔按分钟保存且最小为 1", () => {
    expect(normalizeSyncSettings({ intervalMinutes: 0 }).intervalMinutes).toBe(1);
    expect(normalizeSyncSettings({ intervalMinutes: 5.6 }).intervalMinutes).toBe(6);
  });

  it("S3 Region 默认使用 auto", () => {
    expect(normalizeSyncSettings({ provider: "s3" }).s3.region).toBe("auto");
  });

  it("密钥类设置键集中声明，供备份过滤复用", () => {
    expect(SYNC_SECRET_SETTING_KEYS).toEqual([
      "syncEncryptionSecret",
      "syncWebDavPassword",
      "syncS3SecretKey",
    ]);
  });
});
