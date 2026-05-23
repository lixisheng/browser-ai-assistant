import { afterEach, describe, expect, it, vi } from "vitest";
import { backupNow, restoreNow } from "../../../src/shared/sync/backupService";
import type { SyncRemoteBackup } from "../../../src/shared/sync/types";
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
    await expect(backupNow({ provider: { write: vi.fn(), read: vi.fn() } })).rejects.toThrow("请先开启同步功能");
  });

  it("加密开启但没有本地密钥时拒绝备份", async () => {
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, encryptionEnabled: true, backupPrefix: "work" },
      updatedAt: 1,
    });

    await expect(backupNow({ provider: { write: vi.fn(), read: vi.fn() } })).rejects.toThrow("请先设置本地加密密钥");
  });

  it("备份前缀为空时拒绝备份", async () => {
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, backupPrefix: "   " },
      updatedAt: 1,
    });

    await expect(backupNow({ provider: { write: vi.fn(), read: vi.fn() } })).rejects.toThrow("请先设置备份文件前缀");
  });

  it.each(["work/dev", "work\\dev", "../work", "work..dev"])("备份前缀包含路径字符 %s 时拒绝备份", async (backupPrefix) => {
    await saveAppSetting({
      key: "syncSettings",
      value: { syncEnabled: true, backupPrefix },
      updatedAt: 1,
    });

    await expect(backupNow({ provider: { write: vi.fn(), read: vi.fn() } })).rejects.toThrow(
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

    await backupNow({ provider: { write, read: vi.fn() } });

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

  it("恢复会覆盖本地数据并更新恢复时间", async () => {
    const backup: SyncRemoteBackup = {
      version: 1,
      prefix: "work",
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

    await restoreNow({ provider: { read, write: vi.fn() } });

    expect(await getModelProviders()).toEqual([]);
  });
});
