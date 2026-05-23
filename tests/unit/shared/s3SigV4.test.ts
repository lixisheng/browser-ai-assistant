import { describe, expect, it } from "vitest";
import { createS3AuthorizationHeaders } from "../../../src/shared/sync/s3SigV4";

describe("S3 SigV4", () => {
  it("为 S3 请求生成 Authorization、x-amz-date 和 x-amz-content-sha256", async () => {
    const headers = await createS3AuthorizationHeaders({
      method: "PUT",
      url: new URL("https://r2.example.com/bucket/backups/work.json"),
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      region: "auto",
      payload: "hello",
      now: new Date("2026-05-23T00:00:00.000Z"),
    });

    expect(headers["x-amz-date"]).toBe("20260523T000000Z");
    expect(headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers.Authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIA_TEST/20260523/auto/s3/aws4_request");
    expect(headers.Authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(headers.Authorization).toMatch(/Signature=[a-f0-9]{64}$/);
  });
});
