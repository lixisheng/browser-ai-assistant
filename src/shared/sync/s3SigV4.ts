interface S3AuthorizationInput {
  method: string;
  url: URL;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  payload: string;
  now?: Date;
}

const textEncoder = new TextEncoder();

export async function createS3AuthorizationHeaders(input: S3AuthorizationInput): Promise<Record<string, string>> {
  const now = input.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(input.payload);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method.toUpperCase(),
    createCanonicalUri(input.url),
    input.url.searchParams.toString(),
    `host:${input.url.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await createSigningKey(input.secretAccessKey, dateStamp, input.region);
  const signature = await hmacHex(signingKey, stringToSign);

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

function formatAmzDate(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes(),
  )}${pad(date.getUTCSeconds())}Z`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function createCanonicalUri(url: URL): string {
  return url.pathname
    .split("/")
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join("/");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return toHex(new Uint8Array(digest));
}

async function createSigningKey(secretAccessKey: string, dateStamp: string, region: string): Promise<CryptoKey> {
  const dateKey = await hmacBytes(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmacBytes(dateKey, region);
  const serviceKey = await hmacBytes(regionKey, "s3");
  const signingKey = await hmacBytes(serviceKey, "aws4_request");
  return crypto.subtle.importKey("raw", asBufferSource(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmacBytes(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(typeof key === "string" ? textEncoder.encode(key) : key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(value));
  return new Uint8Array(signature);
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return toHex(new Uint8Array(signature));
}

function toHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function asBufferSource(value: Uint8Array): BufferSource {
  return value as unknown as BufferSource;
}
