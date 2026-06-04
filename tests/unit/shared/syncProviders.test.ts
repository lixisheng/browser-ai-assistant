import { describe, expect, it, vi } from "vitest";
import { getChromeSyncQuotaMessage } from "../../../src/background/syncBackupHandler";
import { createChromeSyncProvider } from "../../../src/shared/sync/chromeSyncProvider";
import { createS3Provider } from "../../../src/shared/sync/s3Provider";
import { createWebDavProvider } from "../../../src/shared/sync/webDavProvider";

describe("Chrome Sync provider", () => {
  it("按前缀和创建时间写入、列出、读取和删除多份备份", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.entries(items).forEach(([key, value]) => values.set(key, value));
      }),
      get: vi.fn(async (key: string) => ({ [key]: values.get(key) })),
      getKeys: vi.fn(async () => Array.from(values.keys())),
      remove: vi.fn(async (key: string) => {
        values.delete(key);
      }),
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

    expect(await provider.list()).toEqual([
      {
        id: "browserAiAssistantBackup:work:1",
        prefix: "work",
        createdAt: 1,
        provider: "chrome_sync",
        encrypted: false,
      },
    ]);
    expect(await provider.read("browserAiAssistantBackup:work:1")).toEqual({
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "chrome_sync",
      encrypted: false,
      payload: { hello: "world" },
    });
    expect(storage.set).toHaveBeenCalledWith({
      "browserAiAssistantBackup:work:1": {
        version: 1,
        createdAt: 1,
        prefix: "work",
        provider: "chrome_sync",
        encrypted: false,
        payload: { hello: "world" },
      },
    });

    await provider.delete("browserAiAssistantBackup:work:1");
    expect(storage.remove).toHaveBeenCalledWith("browserAiAssistantBackup:work:1");
  });

  it("Chrome Sync 列表兼容旧单文件备份 key", async () => {
    const storage = {
      set: vi.fn(),
      getKeys: vi.fn(async () => ["browserAiAssistantBackup:work"]),
      get: vi.fn(async () => ({
        "browserAiAssistantBackup:work": {
          version: 1,
          createdAt: 1,
          prefix: "work",
          provider: "chrome_sync",
          encrypted: false,
          payload: { hello: "world" },
        },
      })),
      remove: vi.fn(),
    };
    const provider = createChromeSyncProvider(storage as unknown as chrome.storage.StorageArea);

    expect(await provider.list()).toEqual([
      {
        id: "browserAiAssistantBackup:work",
        prefix: "work",
        createdAt: 1,
        provider: "chrome_sync",
        encrypted: false,
      },
    ]);
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
  it("S3 使用 path-style URL 写入、列出、读取和删除多份备份对象", async () => {
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
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents><Key>backups/work--1.json</Key></Contents>
</ListBucketResult>`),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn() });
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
    const listed = await provider.list();
    const restored = await provider.read("backups/work--1.json");
    await provider.delete("backups/work--1.json");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://r2.example.com/browser-ai/backups/work--1.json",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("AWS4-HMAC-SHA256"),
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://r2.example.com/browser-ai?list-type=2&prefix=backups%2F",
      expect.objectContaining({ method: "GET" }),
    );
    expect(listed).toEqual([
      {
        id: "backups/work--1.json",
        prefix: "work",
        createdAt: 1,
        provider: "s3",
        encrypted: false,
      },
    ]);
    expect(restored).toEqual(backup);
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "https://r2.example.com/browser-ai/backups/work--1.json",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("S3 使用中文备份前缀时远程对象名不保存为百分号编码文本", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, text: vi.fn() });
    const provider = createS3Provider(fetcher, {
      endpointUrl: "https://r2.example.com",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      bucket: "browser-ai",
      region: "auto",
      objectKeyPrefix: "backups",
    });

    await provider.write("联想", {
      version: 1,
      createdAt: 1,
      prefix: "联想",
      provider: "s3",
      encrypted: false,
      payload: { ok: true },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://r2.example.com/browser-ai/backups/%E8%81%94%E6%83%B3--1.json",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetcher).not.toHaveBeenCalledWith(
      expect.stringContaining("%25E8%2581%2594%25E6%2583%25B3"),
      expect.anything(),
    );
  });

  it("S3 列表兼容旧单文件备份对象", async () => {
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
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents><Key>backups/work.json</Key></Contents>
</ListBucketResult>`),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) });
    const provider = createS3Provider(fetcher, {
      endpointUrl: "https://r2.example.com",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      bucket: "browser-ai",
      region: "auto",
      objectKeyPrefix: "backups",
    });

    expect(await provider.list()).toEqual([
      {
        id: "backups/work.json",
        prefix: "work",
        createdAt: 1,
        provider: "s3",
        encrypted: false,
      },
    ]);
  });

  it("S3 列表会读取 ListObjectsV2 分页结果", async () => {
    const firstBackup = {
      version: 1,
      createdAt: 1,
      prefix: "work",
      provider: "s3",
      encrypted: false,
      payload: { ok: true },
    };
    const secondBackup = {
      version: 1,
      createdAt: 2,
      prefix: "home",
      provider: "s3",
      encrypted: true,
      payload: { ok: true },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>next-token</NextContinuationToken>
  <Contents><Key>backups/work--1.json</Key></Contents>
</ListBucketResult>`),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>backups/home--2.json</Key></Contents>
</ListBucketResult>`),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(firstBackup)) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(secondBackup)) });
    const provider = createS3Provider(fetcher, {
      endpointUrl: "https://r2.example.com",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      bucket: "browser-ai",
      region: "auto",
      objectKeyPrefix: "backups",
    });

    await expect(provider.list()).resolves.toEqual([
      {
        id: "backups/home--2.json",
        prefix: "home",
        createdAt: 2,
        provider: "s3",
        encrypted: true,
      },
      {
        id: "backups/work--1.json",
        prefix: "work",
        createdAt: 1,
        provider: "s3",
        encrypted: false,
      },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://r2.example.com/browser-ai?list-type=2&prefix=backups%2F&continuation-token=next-token",
      expect.objectContaining({ method: "GET" }),
    );
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
  it("WebDAV 使用 PUT 写入、列出、读取和删除多份备份文件", async () => {
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
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/backups/browser-ai/work--1.json</d:href></d:response>
</d:multistatus>`),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn() });
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
    const listed = await provider.list();
    const restored = await provider.read("work--1.json");
    await provider.delete("work--1.json");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://dav.example.com/backups/browser-ai/work--1.json",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://dav.example.com/backups/browser-ai",
      expect.objectContaining({ method: "PROPFIND" }),
    );
    expect(listed).toEqual([
      {
        id: "work--1.json",
        prefix: "work",
        createdAt: 1,
        provider: "webdav",
        encrypted: false,
      },
    ]);
    expect(restored).toEqual(backup);
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "https://dav.example.com/backups/browser-ai/work--1.json",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("WebDAV 列表兼容旧单文件备份", async () => {
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
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/backups/browser-ai/work.json</d:href></d:response>
</d:multistatus>`),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(backup)) });
    const provider = createWebDavProvider(fetcher, {
      endpointUrl: "https://dav.example.com/backups",
      username: "me",
      password: "pwd",
      remotePath: "browser-ai",
    });

    expect(await provider.list()).toEqual([
      {
        id: "work.json",
        prefix: "work",
        createdAt: 1,
        provider: "webdav",
        encrypted: false,
      },
    ]);
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
      "https://dav.example.com/dav/browser-ai/nested/work--1.json",
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
      "https://dav.example.com/dav/browser-ai/nested/work--1.json",
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
