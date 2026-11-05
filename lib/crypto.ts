import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM for account credentials at rest.
// CREDENTIALS_KEY must be 32 random bytes, base64 encoded:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function key(): Buffer {
  const k = Buffer.from(process.env.CREDENTIALS_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes (base64)");
  return k;
}

// Output format: base64(iv).base64(tag).base64(ciphertext)
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
