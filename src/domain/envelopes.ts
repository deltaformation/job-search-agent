import { z } from "zod";

/**
 * Versioned JSON envelope convention for persisted structured payloads
 * (extractions, analyses, resume content, queue payloads). Every payload
 * carries a `schemaVersion`; readers route on it and reject unknown
 * versions instead of guessing. Each versioned schema stays strict about
 * its own keys; the envelope tolerates none of its own beyond the tag.
 */

export const VersionedEnvelope = z
  .object({ schemaVersion: z.string().min(1).max(64) })
  .catchall(z.unknown());
export type VersionedEnvelope = z.infer<typeof VersionedEnvelope>;

export type VersionedParsers = Readonly<Record<string, z.ZodType>>;

export type VersionedPayloadResult =
  | { ok: true; schemaVersion: string; value: unknown }
  | {
      ok: false;
      error: "invalid-envelope" | "unsupported-version" | "invalid-payload";
      detail: string;
    };

export function parseVersionedPayload(
  parsers: VersionedParsers,
  data: unknown,
): VersionedPayloadResult {
  const envelope = VersionedEnvelope.safeParse(data);
  if (!envelope.success) {
    return {
      ok: false,
      error: "invalid-envelope",
      detail: "payload must be an object with a schemaVersion string",
    };
  }
  const parser = parsers[envelope.data.schemaVersion];
  if (parser === undefined) {
    return {
      ok: false,
      error: "unsupported-version",
      detail: `unsupported schemaVersion: ${envelope.data.schemaVersion}`,
    };
  }
  const parsed = parser.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid-payload",
      detail: `payload does not match ${envelope.data.schemaVersion}`,
    };
  }
  return {
    ok: true,
    schemaVersion: envelope.data.schemaVersion,
    value: parsed.data,
  };
}
