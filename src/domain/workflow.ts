import { z } from "zod";
import { parseVersionedPayload } from "./envelopes";
import { EntityId, IsoUtcDateTime } from "./fields";

/**
 * Workflow-event audit contract. `reason` is the machine-readable cause of
 * the event; every human-supplied string (rejection reasons, correction
 * notes, confirmation numbers) lives in versioned `metadataJson` so readers
 * route on `schemaVersion` instead of guessing keys.
 */

export const WorkflowEventReason = z.enum([
  "move",
  "correction",
  "reorder",
  "approval",
]);
export type WorkflowEventReason = z.infer<typeof WorkflowEventReason>;

export const WORKFLOW_EVENT_METADATA_VERSION = "workflow-event-metadata-v1";

export const WorkflowEventMetadataV1 = z
  .object({
    schemaVersion: z.literal(WORKFLOW_EVENT_METADATA_VERSION),
    /** Human rejection/decision reason (required for ordinary REJECTED moves). */
    reason: z.string().trim().min(1).max(280).optional(),
    /** Correction note; mirrored to `job_notes` for the notes view. */
    note: z.string().trim().min(1).max(4000).optional(),
    /** Human-recorded application timestamp for entries into APPLIED. */
    appliedAt: IsoUtcDateTime.optional(),
    confirmationNumber: z.string().trim().min(1).max(128).optional(),
    /** Exact-version approval binding for NEW → TAILORED. */
    resumeVersionId: EntityId.optional(),
    reviewId: EntityId.optional(),
    /** D4: `move` flipped NEW→TAILORED (bind-only approvals emit no event). */
    approvalCase: z.enum(["move", "select"]).optional(),
    /** QUEUED work cancelled by a move into REJECTED. */
    cancelledWorkItems: z.array(EntityId).optional(),
  })
  .strict();
export type WorkflowEventMetadataV1 = z.infer<
  typeof WorkflowEventMetadataV1
>;

/** Parse stored event metadata; unknown versions fail closed, never guessed. */
export function parseWorkflowEventMetadata(
  metadataJson: string | null,
): WorkflowEventMetadataV1 | null {
  if (metadataJson === null) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(metadataJson) as unknown;
  } catch {
    throw new Error("workflow event metadata is not valid JSON");
  }
  const parsed = parseVersionedPayload(
    { [WORKFLOW_EVENT_METADATA_VERSION]: WorkflowEventMetadataV1 },
    data,
  );
  if (!parsed.ok) {
    throw new Error(`workflow event metadata rejected: ${parsed.detail}`);
  }
  return parsed.value as WorkflowEventMetadataV1;
}
