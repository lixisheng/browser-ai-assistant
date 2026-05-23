export interface EncryptedPayload {
  version: 1;
  salt: string;
  iv: string;
  data: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BASE64_CHUNK_SIZE = 0x8000;

export async function encryptJson(value: unknown, password: string): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encoded = textEncoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBufferSource(iv) }, key, encoded);

  return {
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptJson<T = unknown>(payload: EncryptedPayload, password: string): Promise<T> {
  try {
    const salt = fromBase64(payload.salt);
    const iv = fromBase64(payload.iv);
    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(iv) },
      key,
      asBufferSource(fromBase64(payload.data)),
    );

    return JSON.parse(textDecoder.decode(decrypted)) as T;
  } catch {
    throw new Error("无法解密同步数据");
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asBufferSource(salt),
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBase64(value: Uint8Array): string {
  let binary = "";

  // 大备份直接展开 Uint8Array 会把每个字节都压进调用栈，浏览器会抛 Maximum call stack size exceeded。
  for (let index = 0; index < value.length; index += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...value.subarray(index, index + BASE64_CHUNK_SIZE));
  }

  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function asBufferSource(value: Uint8Array): BufferSource {
  return value as unknown as BufferSource;
}
