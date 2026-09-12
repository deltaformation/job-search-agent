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
