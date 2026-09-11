import { createHash, randomUUID } from "node:crypto";

/** Stable TEXT primary keys for product rows. */
export function newId(): string {
  return randomUUID();
}

/** Current UTC time as ISO-8601 text with millisecond precision. */
export function utcNow(): string {
  return new Date().toISOString();
}

/** SHA-256 hex digest of a UTF-8 string (snapshot and payload hashes). */
export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
