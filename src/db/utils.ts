import { randomUUID } from "node:crypto";

/** Stable TEXT primary keys for product rows. */
export function newId(): string {
  return randomUUID();
}

/** Current UTC time as ISO-8601 text with millisecond precision. */
export function utcNow(): string {
  return new Date().toISOString();
}
