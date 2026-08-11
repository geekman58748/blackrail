import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1";

function keys(): Buffer[] {
  const values = [process.env.FACADE_ENCRYPTION_KEY, ...(process.env.FACADE_ENCRYPTION_KEY_PREVIOUS ?? "").split(",")]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  if (!values.length) throw new Error("FACADE_ENCRYPTION_KEY is required when settlement is enabled");
  return values.map((value) => createHash("sha256").update(value).digest());
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys()[0], iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(`${PREFIX}:`)) {
    if (process.env.ALLOW_LEGACY_PLAINTEXT_FACADE_KEYS === "true") return value;
    throw new Error("plaintext facade key rejected");
  }
  const [, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error("invalid encrypted facade key");
  for (const key of keys()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
      decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // Try the next key during rotation.
    }
  }
  throw new Error("unable to decrypt facade key");
}

export function hashCapability(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}