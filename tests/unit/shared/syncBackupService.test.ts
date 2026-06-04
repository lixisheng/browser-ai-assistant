import { afterEach, describe, expect, it, vi } from "vitest";
import { backupNow, listRemoteBackups, restoreNow } from "../../../src/shared/sync/backupService";
import type { SyncRemoteBackup, SyncRemoteBackupMeta, SyncRemoteProvider } from "../../../src/shared/sync/types";
import {
  clearDatabase,
  getModelProviders,
  saveAppSetting,
  saveModelProvider,
} from "../../../src/shared/storage/repositories";

describe("同步备份服务", () => {
  afterEach(async () => {
    await clearDatabase();
  });

  it("同步未开启时拒绝备份", async () => {
    await expect(backupNow({ provider: createProviderMock() })).rejects.toThrow("请先开启同步功能");
  });

  it("加密开启但没有本地密钥时拒绝备份", async () => {
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, encryptionEnabled: true, backupPrefix: "work" },
      updatedAt: 1,
    });

    await expect(backupNow({ provider: createProviderMock() })).rejects.toThrow("请先设置本地加密密钥");
  });

  it("备份前缀为空时拒绝备份", async () => {
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, backupPrefix: "   " },
      updatedAt: 1,
    });

    await expect(backupNow({ provider: createProviderMock() })).rejects.toThrow("请先设置备份文件前缀");
  });

  it.each(["work/dev", "work\\dev", "../work", "work..dev"])("备份前缀包含路径字符 %s 时拒绝备份", async (backupPrefix) => {
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, backupPrefix },
      updatedAt: 1,
    });

    await expect(backupNow({ provider: createProviderMock() })).rejects.toThrow(
      "备份文件前缀不能包含路径分隔符或连续点号",
    );
  });

  it("明文模式允许备份，并写入当前前缀", async () => {
    const write = vi.fn();
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, encryptionEnabled: false, backupPrefix: "work" },
      updatedAt: 1,
    });
    await saveModelProvider({
      id: "provider-1",
      name: "渠道",
      endpointType: "openai_chat",
      endpointUrl: "https://api.example.com",
      apiKey: "sk-local",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });

    await backupNow({ provider: { write, read: vi.fn(), list: vi.fn(async () => []), delete: vi.fn() } });

    expect(write).toHaveBeenCalledWith(
      "work",
      expect.objectContaining({
        version: 1,
        prefix: "work",
        encrypted: false,
        payload: expect.objectContaining({
          modelProviders: [expect.objectContaining({ apiKey: "sk-local" })],
        }),
      }),
    );
  });

  it("备份后只清理同一前缀最早的超额备份", async () => {
    const backups: SyncRemoteBackupMeta[] = [
      { id: "work-1", prefix: "work", createdAt: 1, provider: "chrome_sync", encrypted: false },
      { id: "work-2", prefix: "work", createdAt: 2, provider: "chrome_sync", encrypted: false },
      { id: "other-1", prefix: "other", createdAt: 1, provider: "chrome_sync", encrypted: false },
    ];
    const provider = {
      write: vi.fn(async (_prefix: string, backup: SyncRemoteBackup) => {
        backups.push({
          id: `work-${backup.createdAt}`,
          prefix: backup.prefix,
          createdAt: backup.createdAt,
          provider: backup.provider,
          encrypted: backup.encrypted,
        });
      }),
      read: vi.fn(),
      list: vi.fn(async () => backups),
      delete: vi.fn(async (id: string) => {
        const index = backups.findIndex((backup) => backup.id === id);
        if (index >= 0) {
          backups.splice(index, 1);
        }
      }),
    };
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, encryptionEnabled: false, backupPrefix: "work", maxBackupCount: 2 },
      updatedAt: 1,
    });

    await backupNow({ provider });

    expect(provider.delete).toHaveBeenCalledWith("work-1");
    expect(provider.delete).not.toHaveBeenCalledWith("other-1");
  });

  it("列出当前备份目标下所有远程备份", async () => {
    const backups: SyncRemoteBackupMeta[] = [
      { id: "work-1", prefix: "work", createdAt: 1, provider: "chrome_sync", encrypted: false },
      { id: "home-1", prefix: "home", createdAt: 2, provider: "chrome_sync", encrypted: true },
    ];
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, backupPrefix: "work" },
      updatedAt: 1,
    });

    await expect(listRemoteBackups({ provider: { write: vi.fn(), read: vi.fn(), list: vi.fn(async () => backups), delete: vi.fn() } })).resolves.toEqual(backups);
  });

  it("恢复指定远程备份会覆盖本地数据并允许前缀不同", async () => {
    const backup: SyncRemoteBackup = {
      version: 1,
      prefix: "home",
      createdAt: 1,
      provider: "chrome_sync" as const,
      encrypted: false,
      payload: {
        version: 1,
        modelConfigs: [],
        modelProviders: [],
        providerModels: [],
        extractionRules: [],
        chatSessions: [],
        chatFolders: [],
        appSettings: [],
      },
    };
    const read = vi.fn(async () => backup);
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, backupPrefix: "work" },
      updatedAt: 1,
    });
    await saveModelProvider({
      id: "provider-1",
      name: "渠道",
      endpointType: "openai_chat",
      endpointUrl: "https://api.example.com",
      apiKey: "sk-local",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });

    await restoreNow({ provider: { read, write: vi.fn(), list: vi.fn(), delete: vi.fn() }, backupId: "home-1" });

    expect(await getModelProviders()).toEqual([]);
    expect(read).toHaveBeenCalledWith("home-1");
  });

  it("恢复指定备份时拒绝 provider 不匹配的远程数据", async () => {
    const backup: SyncRemoteBackup = {
      version: 1,
      prefix: "home",
      createdAt: 1,
      provider: "s3",
      encrypted: false,
      payload: {
        version: 1,
        modelConfigs: [],
        modelProviders: [],
        providerModels: [],
        extractionRules: [],
        chatSessions: [],
        chatFolders: [],
        appSettings: [],
      },
    };
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, provider: "chrome_sync", backupPrefix: "work" },
      updatedAt: 1,
    });
    await saveModelProvider({
      id: "provider-1",
      name: "渠道",
      endpointType: "openai_chat",
      endpointUrl: "https://api.example.com",
      apiKey: "sk-local",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      restoreNow({ provider: { read: vi.fn(async () => backup), write: vi.fn(), list: vi.fn(), delete: vi.fn() }, backupId: "home-1" }),
    ).rejects.toThrow("备份目标不匹配，未覆盖本地数据");
    expect(await getModelProviders()).toHaveLength(1);
  });
});

function createProviderMock(): SyncRemoteProvider {
  return {
    write: vi.fn(),
    list: vi.fn(async () => []),
    read: vi.fn(),
    delete: vi.fn(),
  };
}
