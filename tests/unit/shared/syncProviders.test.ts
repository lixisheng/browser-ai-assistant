import { describe, expect, it, vi } from "vitest";
import { getChromeSyncQuotaMessage } from "../../../src/background/syncBackupHandler";
import { createChromeSyncProvider } from "../../../src/shared/sync/chromeSyncProvider";
import { createS3Provider } from "../../../src/shared/sync/s3Provider";
import { createWebDavProvider } from "../../../src/shared/sync/webDavProvider";

describe("Chrome Sync provider", () => {
  it("按前缀写入和读取单个备份", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.entries(items).forEach(([key, value]) => values.set(key, value));
      }),
      get: vi.fn(async (key: string) => ({ [key]: values.get(key) })),
      remove: vi.fn(),
    };
    const provider = createChromeSyncProvider(storage as unknown as chrome.storage.StorageArea);

    await provider.write("work", {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "chrome_sync",
      encrypted: false,
      payload: { hello: "world" },
    });

    expect(await provider.read("work")).toEqual({
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "chrome_sync",
      encrypted: false,
      payload: { hello: "world" },
    });
    expect(storage.set).toHaveBeenCalledWith({
      "browserAiAssistantBackup:work": {
        version: 1,
        createdAt: 1,
        prefix: "work",
        provider: "chrome_sync",
        encrypted: false,
        payload: { hello: "world" },
      },
    });
  });

  it("配额超限时返回统一中文提示", async () => {
    const provider = createChromeSyncProvider({
      set: vi.fn(async () => {
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }),
      get: vi.fn(),
      remove: vi.fn(),
    } as unknown as chrome.storage.StorageArea);

    await expect(
      provider.write("work", {
        version: 1,
        createdAt: 1,
        prefix: "work",
        provider: "chrome_sync",
        encrypted: false,
        payload: { value: "x" },
      }),
    ).rejects.toThrow("备份失败：同步数据超过 Chrome Sync 配额，请减少本地历史记录或改用 WebDAV/S3");
  });

  it("Chrome Sync 配额检查优先使用注入 storageArea 的配额值", async () => {
    const storage = {
      QUOTA_BYTES_PER_ITEM: 64,
      set: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
    };
    const provider = createChromeSyncProvider(storage as unknown as chrome.storage.StorageArea);

    await expect(
      provider.write("work", {
        version: 1,
        createdAt: 1,
        prefix: "work",
        provider: "chrome_sync",
        encrypted: false,
        payload: { value: "x".repeat(100) },
      }),
    ).rejects.toThrow("备份失败：同步数据超过 Chrome Sync 配额，请减少本地历史记录或改用 WebDAV/S3");
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("Chrome Sync 读取到非法备份格式时返回中文错误", async () => {
    const provider = createChromeSyncProvider({
      set: vi.fn(),
      get: vi.fn(async (key: string) => ({ [key]: { ok: true } })),
      remove: vi.fn(),
    } as unknown as chrome.storage.StorageArea);

    await expect(provider.read("work")).rejects.toThrow("备份文件格式无效，未覆盖本地数据");
  });

  it("配额文案与 provider 使用一致", () => {
    expect(getChromeSyncQuotaMessage()).toBe("备份失败：同步数据超过 Chrome Sync 配额，请减少本地历史记录或改用 WebDAV/S3");
  });
});

describe("S3 provider", () => {
  it("S3 使用 path-style URL 写入和读取当前前缀对象", async () => {
    const backup = {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "s3",
      encrypted: false,
      payload: { ok: true },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn() })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) });
    const provider = createS3Provider(fetcher, {
      endpointUrl: "https://r2.example.com",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      bucket: "browser-ai",
      region: "auto",
      objectKeyPrefix: "backups",
    });

    await provider.write("work", {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "s3",
      encrypted: false,
      payload: { ok: true },
    });
    const restored = await provider.read("work");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://r2.example.com/browser-ai/backups/work.json",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("AWS4-HMAC-SHA256"),
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(restored).toEqual(backup);
  });

  it("S3 读取到非法备份格式时返回中文错误", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
    });
    const provider = createS3Provider(fetcher, {
      endpointUrl: "https://r2.example.com",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      bucket: "browser-ai",
      region: "auto",
      objectKeyPrefix: "backups",
    });

    await expect(provider.read("work")).rejects.toThrow("备份文件格式无效，未覆盖本地数据");
  });
});

describe("WebDAV provider", () => {
  it("WebDAV 使用 PUT 写入当前前缀 JSON 文件，并用 GET 读取", async () => {
    const backup = {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "webdav",
      encrypted: false,
      payload: { ok: true },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn() })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) });
    const provider = createWebDavProvider(fetcher, {
      endpointUrl: "https://dav.example.com/backups",
      username: "me",
      password: "pwd",
      remotePath: "browser-ai",
    });

    await provider.write("work", {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "webdav",
      encrypted: false,
      payload: { ok: true },
    });
    const restored = await provider.read("work");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://dav.example.com/backups/browser-ai/work.json",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(restored).toEqual(backup);
  });

  it("WebDAV 读取到非法备份格式时返回中文错误", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
    });
    const provider = createWebDavProvider(fetcher, {
      endpointUrl: "https://dav.example.com/backups",
      username: "me",
      password: "pwd",
      remotePath: "browser-ai",
    });

    await expect(provider.read("work")).rejects.toThrow("备份文件格式无效，未覆盖本地数据");
  });

  it("WebDAV 远程目录不存在时先创建目录再重试写入", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: vi
          .fn()
          .mockResolvedValue(
            '<?xml version="1.0" encoding="UTF-8"?><d:error><s:exception>AncestorsNotFound</s:exception></d:error>',
          ),
      })
      .mockResolvedValueOnce({ ok: true, status: 201, text: vi.fn() })
      .mockResolvedValueOnce({ ok: true, status: 201, text: vi.fn() })
      .mockResolvedValueOnce({ ok: true, text: vi.fn() });
    const provider = createWebDavProvider(fetcher, {
      endpointUrl: "https://dav.example.com/dav",
      username: "me",
      password: "pwd",
      remotePath: "browser-ai/nested",
    });

    await provider.write("work", {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "webdav",
      encrypted: false,
      payload: { ok: true },
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://dav.example.com/dav/browser-ai/nested/work.json",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://dav.example.com/dav/browser-ai",
      expect.objectContaining({
        method: "MKCOL",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://dav.example.com/dav/browser-ai/nested",
      expect.objectContaining({
        method: "MKCOL",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "https://dav.example.com/dav/browser-ai/nested/work.json",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("WebDAV 配置缺失时返回中文错误", async () => {
    expect(() =>
      createWebDavProvider(fetch, {
        endpointUrl: "",
        username: "",
        password: "",
        remotePath: "",
      }),
    ).toThrow("请完整填写 WebDAV 地址、用户名、密码和远程路径");
  });
});
