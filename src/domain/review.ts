import { z } from "zod";
import { ReasonCode, ReviewState } from "./enums";
import { EntityId, RequiredNote, Sha256Hex } from "./fields";

/**
 * Human review lifecycle for one immutable resume version. A revision request
 * freezes the old row; the follow-up work is a new child version. `FAILED`
 * covers generation failures and requires a reason code.
 *
 * Only humans review: every command and record pins `actor` to `human` at
 * the schema level. Service layers still must prove the action came from the
 * local user (explicit UI gesture + CSRF), since a label alone is not consent.
 */

export const REVIEW_TRANSITIONS: Readonly<
  Record<ReviewState, readonly ReviewState[]>
> = {
  DRAFT: ["AWAITING_REVIEW", "FAILED"],
  AWAITING_REVIEW: ["APPROVED", "REVISION_REQUESTED", "FAILED"],
  APPROVED: [],
  REVISION_REQUESTED: [],
  FAILED: [],
};

export type ReviewTransitionResult =
  | { ok: true; from: ReviewState; to: ReviewState }
  | {
      ok: false;
      error: "forbidden" | "reason-required";
      from: ReviewState;
      to: ReviewState;
      detail: string;
    };

export function planReviewTransition(
  from: ReviewState,
  input: { to: ReviewState; reasonCode?: ReasonCode },
): ReviewTransitionResult {
  const { to } = input;
  if (!REVIEW_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: "forbidden",
      from,
      to,
      detail: `review cannot move from ${from} to ${to}`,
    };
  }
  if (to === "FAILED" && input.reasonCode === undefined) {
    return {
      ok: false,
      error: "reason-required",
      from,
      to,
      detail: "review FAILED requires a reason code",
    };
  }
  return { ok: true, from, to };
}

export const ReviewCommand = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("APPROVED"),
      resumeVersionId: EntityId,
      actor: z.literal("human"),
      note: z.string().trim().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("REVISION_REQUESTED"),
      resumeVersionId: EntityId,
      actor: z.literal("human"),
      note: RequiredNote,
    })
    .strict(),
]);
export type ReviewCommand = z.infer<typeof ReviewCommand>;

/**
 * Exact-version approval binding. The approval transaction re-hashes the
 * stored artifacts and must produce these digests before recording.
 */
export const ApprovalRecord = z
  .object({
    resumeVersionId: EntityId,
    action: z.literal("APPROVED"),
    actor: z.literal("human"),
    note: z.string().trim().optional(),
    resumeHash: Sha256Hex,
    contentHash: Sha256Hex,
    artifactHashes: z
      .object({
        markdown: Sha256Hex,
        docx: Sha256Hex,
        pdf: Sha256Hex,
      })
      .strict(),
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;
