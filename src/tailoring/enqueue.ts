import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { getWorkItemByIdempotencyKey, insertTailorWorkItem } from "../db/tailoring";
import { ProfileId } from "../domain/candidate";
import { canonicalJson } from "../domain/canonical";
import { EntityId } from "../domain/fields";
import { sha256HexUtf8 } from "./hash";

/**
 * TAILOR queue payload and idempotent enqueue. Every successful new
 * extraction requests tailoring exactly once per extraction: the
 * idempotency key binds job + extraction, and re-enqueue returns the
 * existing item instead of duplicating work. Human guidance (career
 * profile, selected keywords, directives) travels on the same payload
 * and binds into a guidance-scoped key, so re-tailoring with new
 * guidance enqueues a fresh run while retrying identical guidance
 * dedupes.
 */

export const TAILOR_PAYLOAD_VERSION = "tailor-queue/v1";

export const MAX_SELECTED_KEYWORDS = 20;
export const MAX_DIRECTIVES_CHARS = 1000;

/** Human tailoring guidance: steering metadata, never fact evidence. */
export const TailoringGuidanceV1 = z
  .object({
    profileId: ProfileId.optional(),
    selectedKeywords: z.array(z.string().trim().min(1).max(128)).max(MAX_SELECTED_KEYWORDS).optional(),
    directives: z.string().trim().max(MAX_DIRECTIVES_CHARS).optional(),
  })
  .strict();
export type TailoringGuidanceV1 = z.infer<typeof TailoringGuidanceV1>;

export const TailorPayloadV1 = z
  .object({
    schemaVersion: z.literal(TAILOR_PAYLOAD_VERSION),
    jobId: EntityId,
    extractionId: EntityId,
    profileId: ProfileId.optional(),
    selectedKeywords: z.array(z.string().trim().min(1).max(128)).max(MAX_SELECTED_KEYWORDS).optional(),
    directives: z.string().trim().max(MAX_DIRECTIVES_CHARS).optional(),
  })
  .strict();
export type TailorPayloadV1 = z.infer<typeof TailorPayloadV1>;

export function tailorIdempotencyKey(jobId: string, extractionId: string): string {
  return `tailor:v1:${jobId}:${extractionId}`;
}

/**
 * Normalize validated guidance: drop empties, dedupe keywords keeping
 * first-seen order. Returns null when nothing actionable remains, so
 * callers fall back to the legacy unguided path. Routes must validate
 * with `TailoringGuidanceV1` first (invalid guidance is a 400, never a
 * silent downgrade); the null-on-unparseable branch below is
 * defense-in-depth for internal callers only.
 */
export function normalizeTailoringGuidance(raw: unknown): TailoringGuidanceV1 | null {
  const parsed = TailoringGuidanceV1.safeParse(raw ?? {});
  if (!parsed.success) {
    return null;
  }
  const seen = new Set<string>();
  const selectedKeywords = (parsed.data.selectedKeywords ?? []).filter((keyword) => {
    if (seen.has(keyword)) {
      return false;
    }
    seen.add(keyword);
    return true;
  });
  const directives = parsed.data.directives === "" ? undefined : parsed.data.directives;
  const guidance: TailoringGuidanceV1 = {
    ...(parsed.data.profileId === undefined ? {} : { profileId: parsed.data.profileId }),
    ...(selectedKeywords.length === 0 ? {} : { selectedKeywords }),
    ...(directives === undefined ? {} : { directives }),
  };
  return Object.keys(guidance).length === 0 ? null : guidance;
}

/**
 * Guided-run idempotency key. Binds the canonical guidance (keywords
 * sorted, so chip order never forks the key) so identical guidance
 * dedupes and any change enqueues a distinct run.
 */
export function tailorGuidedIdempotencyKey(
  jobId: string,
  extractionId: string,
  guidance: TailoringGuidanceV1,
): string {
  const digest = sha256HexUtf8(
    canonicalJson({
      p: guidance.profileId ?? null,
      k: [...(guidance.selectedKeywords ?? [])].sort(),
      d: guidance.directives ?? null,
    }),
  ).slice(0, 16);
  return `tailor-guide:v1:${jobId}:${extractionId}:${digest}`;
}

/**
 * Revision-run idempotency key. A revision request must cause a follow-up
 * run even though the original `tailor:v1:{job}:{extraction}` item already
 * succeeded — reusing that key would dedupe and no new version would ever
 * exist. Binding the parent version keeps the key stable across retries
 * of the same revision command (a version is revised at most once: the
 * review state is terminal afterwards) while remaining distinct per
 * revision round.
 */
export function tailorRevisionIdempotencyKey(jobId: string, parentVersionId: string): string {
  return `tailor-rev:v1:${jobId}:${parentVersionId}`;
}

export interface RequestTailoringResult {
  workItemId: string;
  deduped: boolean;
}

/**
 * Enqueue a TAILOR run, joining the caller's transaction when present so
 * extraction persistence and its tailor request commit atomically.
 * Guidance selects the guidance-scoped idempotency key and rides the
 * payload; absent guidance keeps the legacy job+extraction key.
 */
export function requestTailoring(
  handle: DatabaseHandle,
  rawInput: {
    jobId: string;
    extractionId: string;
    maxAttempts?: number;
    profileId?: string;
    selectedKeywords?: string[];
    directives?: string;
  },
): RequestTailoringResult {
  const input = z
    .object({
      jobId: EntityId,
      extractionId: EntityId,
      maxAttempts: z.number().int().min(1).max(10).optional(),
      profileId: ProfileId.optional(),
      selectedKeywords: z
        .array(z.string().trim().min(1).max(128))
        .max(MAX_SELECTED_KEYWORDS)
        .optional(),
      directives: z.string().trim().max(MAX_DIRECTIVES_CHARS).optional(),
    })
    .strict()
    .parse(rawInput);
  const guidance = normalizeTailoringGuidance({
    profileId: input.profileId,
    selectedKeywords: input.selectedKeywords,
    directives: input.directives,
  });
  const idempotencyKey =
    guidance === null
      ? tailorIdempotencyKey(input.jobId, input.extractionId)
      : tailorGuidedIdempotencyKey(input.jobId, input.extractionId, guidance);
  const existing = getWorkItemByIdempotencyKey(handle, idempotencyKey);
  if (existing !== null) {
    return { workItemId: existing.id, deduped: true };
  }
  const payload = TailorPayloadV1.parse({
    schemaVersion: TAILOR_PAYLOAD_VERSION,
    jobId: input.jobId,
    extractionId: input.extractionId,
    ...(guidance === null ? {} : guidance),
  });
  const id = insertTailorWorkItem(handle, {
    idempotencyKey,
    jobId: input.jobId,
    payloadJson: JSON.stringify(payload),
    maxAttempts: input.maxAttempts ?? 3,
  });
  const raced = getWorkItemByIdempotencyKey(handle, idempotencyKey);
  if (raced === null) {
    throw new Error("tailor enqueue is not readable after insert");
  }
  return { workItemId: raced.id, deduped: raced.id !== id };
}

/**
 * Enqueue the follow-up run for a human revision request. Same TAILOR
 * payload shape (the handler needs no changes: REVISION_REQUESTED runs
 * are an allowed transition), but the revision-scoped idempotency key
 * so the request is not swallowed by the original run's key. Joins the
 * caller's transaction like `requestTailoring`, so the review rows and
 * the follow-up run commit atomically.
 */
export function requestRevisionRun(
  handle: DatabaseHandle,
  rawInput: { jobId: string; extractionId: string; parentVersionId: string; maxAttempts?: number },
): RequestTailoringResult {
  const input = z
    .object({
      jobId: EntityId,
      extractionId: EntityId,
      parentVersionId: EntityId,
      maxAttempts: z.number().int().min(1).max(10).optional(),
    })
    .strict()
    .parse(rawInput);
  const idempotencyKey = tailorRevisionIdempotencyKey(input.jobId, input.parentVersionId);
  const existing = getWorkItemByIdempotencyKey(handle, idempotencyKey);
  if (existing !== null) {
    return { workItemId: existing.id, deduped: true };
  }
  const payload = TailorPayloadV1.parse({
    schemaVersion: TAILOR_PAYLOAD_VERSION,
    jobId: input.jobId,
    extractionId: input.extractionId,
  });
  const id = insertTailorWorkItem(handle, {
    idempotencyKey,
    jobId: input.jobId,
    payloadJson: JSON.stringify(payload),
    maxAttempts: input.maxAttempts ?? 3,
  });
  const raced = getWorkItemByIdempotencyKey(handle, idempotencyKey);
  if (raced === null) {
    throw new Error("revision enqueue is not readable after insert");
  }
  return { workItemId: raced.id, deduped: raced.id !== id };
}
