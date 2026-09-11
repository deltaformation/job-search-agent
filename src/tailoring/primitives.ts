/**
 * Shared Python-semantics primitives for the oracle port: `str()`
 * formatting, truthiness, and record checks used identically by the
 * validator, ranker, planner, summary, and staleness ports.
 */

/** Python `str()` for JSON values in f-string positions. */
export function pyString(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => `'${pyScalar(entry)}`).join(", ")}]`;
  }
  return JSON.stringify(value) ?? "None";
}

/** Single-quote escaping for members of Python-style list reprs. */
export function pyScalar(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }
  return pyString(value);
}

/** Python truthiness for JSON values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "number") {
    return value !== 0 && !Number.isNaN(value);
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (typeof value === "bigint") {
    return value !== BigInt(0);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
