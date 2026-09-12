import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { getWorkItemByIdempotencyKey, insertTailorWorkItem } from "../db/tailoring";
import { EntityId } from "../domain/fields";

/**
 * TAILOR queue payload and idempotent enqueue. Every successful new
 * extraction requests tailoring exactly once per extraction: the
 * idempotency key binds job + extraction, and re-enqueue returns the
 * existing item instead of duplicating work.
 */

export const TAILOR_PAYLOAD_VERSION = "tailor-queue/v1";

export const TailorPayloadV1 = z
  .object({
    schemaVersion: z.literal(TAILOR_PAYLOAD_VERSION),
    jobId: EntityId,
    extractionId: EntityId,
  })
  .strict();
export type TailorPayloadV1 = z.infer<typeof TailorPayloadV1>;

export function tailorIdempotencyKey(jobId: string, extractionId: string): string {
  return `tailor:v1:${jobId}:${extractionId}`;
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
 */
export function requestTailoring(
  handle: DatabaseHandle,
  rawInput: { jobId: string; extractionId: string; maxAttempts?: number },
): RequestTailoringResult {
  const input = z
    .object({
      jobId: EntityId,
      extractionId: EntityId,
      maxAttempts: z.number().int().min(1).max(10).optional(),
    })
    .strict()
    .parse(rawInput);
  const idempotencyKey = tailorIdempotencyKey(input.jobId, input.extractionId);
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
