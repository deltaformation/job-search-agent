import { z } from "zod";
import { Arrangement } from "./enums";

/**
 * Stored extraction envelope version. Defined here (the domain owns
 * the contract) and re-exported by `src/extraction/types.ts` for the
 * scraping pipeline's single writer.
 */
export const JOB_EXTRACTION_VERSION = "job-extraction-v1";

/**
 * Strict reader for the stored `job-extraction-v1` envelope
 * (WO-1.3-D). The single writer (`persistFetchOutcome`) stamps every
 * key, so every key is required here: partial or restamped rows fail
 * closed instead of feeding recommendations or Step 1 unchecked
 * bytes. Nullable fields stay nullable — absent extraction values
 * are honest Unknowns, never invented.
 */

export const StoredExtractionFields = z
  .object({
    title: z.string().nullable(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    arrangement: Arrangement,
    salaryText: z.string().nullable(),
    salaryCurrency: z.string().nullable(),
    salaryMinMinor: z.number().int().nonnegative().nullable(),
    salaryMaxMinor: z.number().int().nonnegative().nullable(),
    descriptionText: z.string().nullable(),
    postedAt: z.string().nullable(),
    applyUrl: z.string().nullable(),
  })
  .strict();
export type StoredExtractionFields = z.infer<typeof StoredExtractionFields>;

export const StoredExtractionEnvelope = z
  .object({
    schemaVersion: z.literal(JOB_EXTRACTION_VERSION),
    fields: StoredExtractionFields,
    provenance: z.record(z.string(), z.string()),
    adapterId: z.string(),
    adapterVersion: z.string(),
    confidence: z.number().min(0).max(1),
    missingFields: z.array(z.string()),
    contentHash: z.string(),
  })
  .strict();
export type StoredExtractionEnvelope = z.infer<typeof StoredExtractionEnvelope>;

/**
 * Parse one stored extraction envelope by its stamped literal.
 * Unknown versions fail closed — never guessed.
 */
export function parseStoredExtraction(data: unknown): StoredExtractionEnvelope {
  const version =
    typeof data === "object" && data !== null && "schemaVersion" in data
      ? (data as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version !== JOB_EXTRACTION_VERSION) {
    throw new Error(`unsupported stored extraction version: ${JSON.stringify(version)}`);
  }
  return StoredExtractionEnvelope.parse(data);
}
