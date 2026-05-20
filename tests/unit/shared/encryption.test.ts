import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "../../../src/shared/crypto/encryption";
import { getChromeSyncQuotaMessage } from "../../../src/background/syncBackupHandler";

describe("加密同步", () => {
  it("使用正确密钥可以解密加密后的 JSON", async () => {
    const encrypted = await encryptJson({ hello: "world" }, "secret");

    await expect(decryptJson(encrypted, "secret")).resolves.toEqual({ hello: "world" });
  });

  it("使用错误密钥无法恢复数据", async () => {
    const encrypted = await encryptJson({ hello: "world" }, "secret");

    await expect(decryptJson(encrypted, "wrong-secret")).rejects.toThrow("无法解密同步数据");
  });

  it("Chrome Sync 配额超限时返回明确提示", () => {
    expect(getChromeSyncQuotaMessage()).toBe(
      "备份失败：同步数据超过 Chrome Sync 配额，请减少历史记录或关闭部分同步内容",
    );
  });
});
