/**
 * Canonical bytes for hashing (architecture section 3): UTF-8, Unicode NFC,
 * LF line endings, lexicographically sorted object keys, caller-supplied UTC
 * timestamp strings, and finite JSON numbers. Arrays retain semantic order.
 *
 * Fail-closed: `NaN`, infinities, `bigint`, `undefined`, functions, symbols,
 * `Date` instances (callers must format UTC ISO-8601 first), cyclical
 * structures, and non-plain objects throw `CanonicalError` instead of
 * producing unstable bytes. Key order is UTF-16 code-unit order, the only
 * order this module ever emits or accepts.
 */

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
      return value.replace(/\r\n?/g, "\n").normalize("NFC");
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalError("canonical JSON rejects non-finite numbers");
      }
      return value;
    case "boolean":
      return value;
    case "bigint":
    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalError(`canonical JSON rejects ${typeof value} values`);
    case "object": {
      if (seen.has(value)) {
        throw new CanonicalError("canonical JSON rejects cyclical structures");
      }
      if (value instanceof Date) {
        throw new CanonicalError(
          "canonical JSON rejects Date instances; format UTC ISO-8601 first",
        );
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((entry) => canonicalize(entry, seen));
        }
        if (!isPlainObject(value)) {
          throw new CanonicalError(
            "canonical JSON rejects non-plain objects (Map, Set, class instances)",
          );
        }
        const entries = Object.entries(value).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        const out: Record<string, unknown> = {};
        for (const [key, entry] of entries) {
          out[key] = canonicalize(entry, seen);
        }
        return out;
      } finally {
        seen.delete(value);
      }
    }
  }
  throw new CanonicalError("unreachable typeof branch");
}

/** Canonical JSON string: sorted keys, compact separators, NFC strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

/**
 * Canonical free text (JD bodies, statements): strip NUL bytes, normalize to
 * NFC, fold CRLF/CR to LF, and trim surrounding whitespace. Mirrors the
 * legacy oracle's NUL-strip plus trim, extended to the NFC/LF contract that
 * requirement quotes cite against.
 */
export function canonicalText(text: string): string {
  return text.replace(/\0/g, "").normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

/**
 * Deterministic code-point-safe truncation for schema-bounded
 * server-built text (labels, summaries). Returns the input unchanged
 * when it already fits; otherwise keeps the first `maxChars` code
 * points. Never splits a surrogate pair. This bounds derived display
 * text only — user-authored guidance still fails 400 over limit
 * instead of truncating.
 */
export function truncateCodePoints(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  const points = [...text];
  if (points.length <= limit) {
    return text;
  }
  return points.slice(0, limit).join("");
}
