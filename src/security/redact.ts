/**
 * Log redaction. Structured logs pass through `redactSecrets` so a secret
 * that reaches a log field renders as `[REDACTED]` instead of leaking.
 * Key-based redaction is automatic; free-text PII uses the explicit
 * `redactEmail`/`redactPhone` helpers at the call site that knows a value
 * is an identifier.
 */

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|apikey|authorization|cookie|set-cookie|credential|private[_-]?key|session/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 12;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-clone a JSON-ish value, replacing values under secret-looking keys.
 * Circular references render as `[Circular]`; Error instances serialize to
 * name/message. The input is never mutated.
 */
export function redactSecrets<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > MAX_DEPTH) {
    return REDACTED as T;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message } as T;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]" as T;
    }
    seen.add(value);
    return value.map((entry) => redactSecrets(entry, depth + 1, seen)) as T;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      return "[Circular]" as T;
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? REDACTED
        : redactSecrets(entry, depth + 1, seen);
    }
    return out as T;
  }
  return value;
}

/** Mask the local part of an email address, keeping the domain for context. */
export function redactEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) {
    return REDACTED;
  }
  return `***@${value.slice(at + 1)}`;
}

/** Keep only the last four dialable characters of a phone number. */
export function redactPhone(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 4) {
    return REDACTED;
  }
  return `***${digits.slice(-4)}`;
}
