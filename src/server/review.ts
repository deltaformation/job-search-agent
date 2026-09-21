import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { getActiveProfileVersion } from "../db/candidates";
import { getGenerationRequest, getLiveGenerationRequest } from "../db/generation";
import { candidateFacts, candidateProfileVersions } from "../db/schema/candidates";
import { jdSnapshots, jobAnalyses } from "../db/schema/analysis";
import { generationRequests } from "../db/schema/generation";
import { workItems } from "../db/schema/queue";
import {
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeReviews,
  resumeVersions,
  type ResumeVersion,
} from "../db/schema/resumes";
import {
  casJobTailoringState,
  getCandidateSnapshotById,
  getTailoringJob,
  type TailoringJobRow,
} from "../db/tailoring";
import { readPlan, readPreparationById, readStep2GenerationInputs } from "../db/step2";
import { readRequestInputs } from "../db/tailoringWorkspace";
import { withTransaction } from "../db/transactions";
import { appendWorkflowEvent, casUpdateJobBoard, getJobBoardRow } from "../db/workflow";
import { newId, utcNow } from "../db/utils";
import { checkRowVersion, planBoardMove } from "../domain/board";
import { CandidateSnapshotV1 } from "../domain/candidate";
import { canonicalJson } from "../domain/canonical";
import { EntityId, IsoUtcDateTime, RowVersion } from "../domain/fields";
import { planReviewTransition } from "../domain/review";
import type { WorkflowReviewV2 } from "../domain/workflowReview";
import { planTailoringTransition } from "../domain/tailoring";
import type { ReviewState, TailoringState } from "../domain/enums";
import { resolveArtifactPath } from "../security/paths";
import { adaptSnapshotProfile } from "../tailoring/adapt";
import {
  COACHING_OUTCOMES_VERSION,
  evaluateDirectiveOutcomes,
  evaluateTermOutcomes,
} from "../tailoring/coaching";
import type { CandidateProfileInput } from "../tailoring/schemas";
import {
  locateKeywordPlacements,
  planSkillRows,
  selectTopKeywords,
  type KeywordPlacement,
} from "../tailoring/keywords";
import { SteeringSnapshotV1 } from "../tailoring/requests";
import {
  resumeIdentityHash,
  storedArtifactDigests,
  type ArtifactDigests,
} from "./resumeDigests";

export { resumeIdentityHash };
import { requestGeneration, type RequestGenerationResult } from "./tailoring";
import { verifyCapturedEvidence } from "./preparation";
import { approveTailored, type WorkflowCommandFailure } from "./workflow";
import { buildWorkflowReview } from "./workflowReview";

/**
 * Resume review commands and read model (R4-F, WO-1.2-D).
 *
 * Approval is exact-version and human-only: the service re-hashes the three
 * stored artifacts from disk, verifies every binding (job NEW/TAILORED/
 * APPLIED/INTERVIEWED, tailoring AWAITING_REVIEW, active pointer, version
 * AWAITING_REVIEW), records an append-only review binding resume/content/
 * artifact hashes, and either lets the R3-A Tailored gate move the card
 * (NEW) or binds the version as the job's selected resume without moving
 * anything (post-board) — all in one transaction. A revision request runs
 * the full generation preflight and records a REVISION_REQUESTED review
 * plus a follow-up REVISION run in the same transaction, so every
 * revision leads to a new child version. A decline records a DECLINED
 * review, freezes the version, and moves tailoring to DECLINED with no
 * follow-up work and no board move.
 *
 * The actor is pinned to `human` at the schema level, and routes force it
 * server-side: no request body can approve as an agent. Filesystem reads
 * happen outside the transaction; the transaction itself only re-verifies
 * database state, writes review rows, and runs the gate.
 */

const HumanActor = z.literal("human");

const ReviewNote = z.string().trim().min(1).max(4000);

const OptionalReviewNote = z.string().trim().max(4000).optional();

export const ApproveResumeInput = z
  .object({
    jobId: EntityId,
    resumeVersionId: EntityId,
    observedRowVersion: RowVersion,
    actor: HumanActor,
    note: OptionalReviewNote,
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type ApproveResumeInput = z.infer<typeof ApproveResumeInput>;

export const RequestRevisionInput = z
  .object({
    jobId: EntityId,
    resumeVersionId: EntityId,
    observedRowVersion: RowVersion,
    actor: HumanActor,
    /** The human must say what is wrong; the note persists on the review. */
    note: ReviewNote,
    /** Optional guidance for the follow-up REVISION run (mirrors generation). */
    profileId: z.string().trim().min(1).max(64).optional(),
    selectedKeywords: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    directives: z.string().trim().max(1000).optional(),
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type RequestRevisionInput = z.infer<typeof RequestRevisionInput>;

export const DeclineVersionInput = z
  .object({
    jobId: EntityId,
    resumeVersionId: EntityId,
    observedRowVersion: RowVersion,
    actor: HumanActor,
    /** The human must say why; the note persists on the review. */
    note: ReviewNote,
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type DeclineVersionInput = z.infer<typeof DeclineVersionInput>;

export type ReviewCommandError =
  | "unknown-job"
  | "unknown-version"
  | "conflict"
  | "forbidden"
  | "stale-version"
  | "tailored-binding"
  | "artifact-incomplete"
  | "artifact-unreadable"
  | "artifact-mismatch";

export interface ReviewCommandFailure {
  ok: false;
  error: ReviewCommandError;
  detail: string;
  currentRowVersion?: number;
}

function failure(
  error: ReviewCommandError,
  detail: string,
  currentRowVersion?: number,
): ReviewCommandFailure {
  return currentRowVersion === undefined
    ? { ok: false, error, detail }
    : { ok: false, error, detail, currentRowVersion };
}

export type ApproveResumeResult =
  | {
      ok: true;
      jobId: string;
      resumeVersionId: string;
      version: number;
      reviewId: string;
      /** Null on bind-only approvals: no board move means no event. */
      eventId: string | null;
      /** `move` flipped NEW→TAILORED; `select` bound the version in place. */
      approvalCase: "move" | "select";
      newRowVersion: number;
      resumeHash: string;
      contentHash: string;
      artifactHashes: { markdown: string; docx: string; pdf: string };
    }
  | ReviewCommandFailure;

export type RequestRevisionResult =
  | {
      ok: true;
      jobId: string;
      resumeVersionId: string;
      version: number;
      reviewId: string;
      requestId: string;
      workItemId: string;
      newRowVersion: number;
    }
  | ReviewCommandFailure;

export type DeclineVersionResult =
  | {
      ok: true;
      jobId: string;
      resumeVersionId: string;
      version: number;
      reviewId: string;
      newRowVersion: number;
    }
  | ReviewCommandFailure;

interface ReviewTarget {
  job: TailoringJobRow;
  version: ResumeVersion;
}

type TargetResult = { ok: true; target: ReviewTarget } | { ok: false; failure: ReviewCommandFailure };

/**
 * Load the job and version and verify they belong together. G
 * (R-ADR-019): any owned version is addressable — eligible older
 * AWAITING_REVIEW versions stay decidable even when they are not
 * the active draft. Position checks live in the commands (the
 * active draft owns tailoring-state moves); `stale-version` now
 * means the version's frozen inputs went stale, never "not
 * active". A version from another job is `unknown-version`.
 */
function loadReviewTarget(
  handle: DatabaseHandle,
  jobId: string,
  resumeVersionId: string,
): TargetResult {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return { ok: false, failure: failure("unknown-job", `job ${jobId} does not exist`) };
  }
  const version = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, resumeVersionId))
    .get();
  if (version === undefined || version.jobId !== jobId) {
    return {
      ok: false,
      failure: failure("unknown-version", `resume version ${resumeVersionId} does not exist`),
    };
  }
  return { ok: true, target: { job, version } };
}

/** True when the target version is the job's active (latest) draft. */
function isActiveTarget(target: ReviewTarget): boolean {
  return target.job.activeResumeVersionId === target.version.id;
}

/**
 * Live-run exclusion: no decision lands while a TAILOR request or
 * work item is QUEUED/RUNNING for the job. Runs pre-transaction
 * and again inside the decision transaction (the job CAS serializes
 * against a concurrent submit either way).
 */
function checkNoLiveRun(
  handle: DatabaseHandle,
  target: ReviewTarget,
): ReviewCommandFailure | null {
  const liveRequest = getLiveGenerationRequest(handle, target.job.id);
  if (liveRequest !== null) {
    return failure(
      "conflict",
      `a tailoring run is live for this job (request ${liveRequest.id}); wait for it to finish before deciding resume v${target.version.version}`,
      target.job.rowVersion,
    );
  }
  const liveWork = handle.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.jobId, target.job.id),
        eq(workItems.kind, "TAILOR"),
        inArray(workItems.state, ["QUEUED", "RUNNING"]),
      ),
    )
    .get();
  if (liveWork !== undefined) {
    return failure(
      "conflict",
      `a tailoring run is live for this job (work ${liveWork.id}); wait for it to finish before deciding resume v${target.version.version}`,
      target.job.rowVersion,
    );
  }
  return null;
}

/**
 * Frozen-input freshness for exact-version decisions. Legacy rows
 * (no generation request or no frozen inputs) predate freezing and
 * decide on bytes + artifacts alone. v1.3 rows refuse with
 * `stale-version` (409) when the job description moved under the
 * frozen extraction, when a v1-format bound profile version is no
 * longer active, or when v2/v3 captured payload/evidence no longer
 * verifies. The recovery is always a new version, never a forced
 * decision on stale-frozen content.
 */
function checkFrozenFreshness(
  handle: DatabaseHandle,
  target: ReviewTarget,
): ReviewCommandFailure | null {
  const { job, version } = target;
  if (version.generationRequestId === null) {
    return null;
  }
  const request = getGenerationRequest(handle, version.generationRequestId);
  const inputs = readRequestInputs(handle, version.generationRequestId);
  if (request === null || inputs === null) {
    return null;
  }
  if (request.jobId !== job.id) {
    return failure(
      "stale-version",
      `resume v${version.version} has request lineage outside this job; generate a new version`,
      job.rowVersion,
    );
  }
  if (request.extractionId !== job.activeExtractionId) {
    return failure(
      "stale-version",
      `the job description changed since resume v${version.version} was generated; generate a new version`,
      job.rowVersion,
    );
  }
  const step2 = readStep2GenerationInputs(handle, request.id);
  if (step2 === null) {
    const active = getActiveProfileVersion(handle, request.profileId);
    if (active === null || active.id !== request.profileVersionId) {
      return failure(
        "stale-version",
        `the captured profile version for resume v${version.version} is no longer active; generate a new version`,
        job.rowVersion,
      );
    }
    return null;
  }
  const plan = readPlan(handle, step2.planId);
  if (plan === null) {
    return failure(
      "stale-version",
      `the frozen plan for resume v${version.version} is gone; generate a new version`,
      job.rowVersion,
    );
  }
  const preparation = readPreparationById(handle, plan.preparationId);
  if (preparation === null) {
    return failure(
      "stale-version",
      `the frozen preparation for resume v${version.version} is gone; generate a new version`,
      job.rowVersion,
    );
  }
  const verified = verifyCapturedEvidence(handle, {
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    profilePayloadHash: preparation.profilePayloadHash,
    evidenceHash: preparation.evidenceHash,
  });
  if (!verified.ok) {
    return failure(
      "stale-version",
      `the captured profile evidence for resume v${version.version} no longer verifies; generate a new version`,
      job.rowVersion,
    );
  }
  return null;
}

function checkVersionFreshness(
  target: ReviewTarget,
  observedRowVersion: number,
): ReviewCommandFailure | null {
  const version = checkRowVersion(target.job.rowVersion, observedRowVersion);
  if (!version.ok) {
    return failure(
      "conflict",
      `stale client: observed row_version ${version.observedRowVersion}, current is ${version.currentRowVersion}`,
      version.currentRowVersion,
    );
  }
  return null;
}

type ArtifactVerifyResult =
  | { ok: true; digests: ArtifactDigests }
  | { ok: false; failure: ReviewCommandFailure };

/**
 * Re-hash the version's three artifacts from disk and compare against the
 * recorded digests and byte sizes. Any drift — tampering, truncation, or
 * a replaced file — fails the approval loudly instead of binding the
 * wrong bytes. Callers must run this outside any transaction: it performs
 * filesystem reads.
 */
export function verifyVersionArtifacts(
  handle: DatabaseHandle,
  resumeVersionId: string,
  artifactsDir: string,
): ArtifactVerifyResult {
  const rows = handle.db
    .select()
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.resumeVersionId, resumeVersionId))
    .all();
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const markdown = byKind.get("MARKDOWN");
  const docx = byKind.get("DOCX");
  const pdf = byKind.get("PDF");
  if (markdown === undefined || docx === undefined || pdf === undefined) {
    const kinds = [...byKind.keys()].sort().join(", ") || "none";
    return {
      ok: false,
      failure: failure(
        "artifact-incomplete",
        `resume artifacts are incomplete (have: ${kinds}); all of MARKDOWN, DOCX, PDF are required`,
      ),
    };
  }
  const digests: ArtifactDigests = { markdown: "", docx: "", pdf: "" };
  for (const row of [markdown, docx, pdf] as const) {
    let absolute: string;
    try {
      absolute = resolveArtifactPath(artifactsDir, row.relativePath);
    } catch {
      return {
        ok: false,
        failure: failure(
          "artifact-unreadable",
          `${row.kind} artifact path is rejected by the data-root policy`,
        ),
      };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      return {
        ok: false,
        failure: failure(
          "artifact-unreadable",
          `${row.kind} artifact bytes are missing from the artifact store`,
        ),
      };
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== row.sha256 || bytes.length !== row.byteSize) {
      return {
        ok: false,
        failure: failure(
          "artifact-mismatch",
          `${row.kind} artifact bytes do not match the recorded digest`,
        ),
      };
    }
    if (row.kind === "MARKDOWN") {
      digests.markdown = sha256;
    } else if (row.kind === "DOCX") {
      digests.docx = sha256;
    } else {
      digests.pdf = sha256;
    }
  }
  return { ok: true, digests };
}



/** Thrown to roll back when the Tailored gate rejects after review writes. */
class GateRejected extends Error {
  readonly failure: WorkflowCommandFailure;

  constructor(failure: WorkflowCommandFailure) {
    super(`tailored gate rejected the approval: ${failure.error}`);
    this.name = "GateRejected";
    this.failure = failure;
  }
}

/**
 * Exact-version human approval (G). Pre-transaction: ownership,
 * CAS, eligibility, live-run exclusion, frozen-input freshness,
 * and disk artifact re-hash. In one transaction every database
 * predicate is re-verified, then the version flips APPROVED with
 * its review, and exactly one of:
 * - NEW + active version: the Tailored gate (board → TAILORED,
 *   tailoring → APPROVED, event, selected pointer);
 * - NEW + older version: the same board move + event + selected
 *   pointer, but tailoring follows the active (newer) version and
 *   is preserved;
 * - TAILORED/APPLIED/INTERVIEWED + active: bind-only select
 *   (tailoring → APPROVED, selected pointer, no move/event);
 * - TAILORED/APPLIED/INTERVIEWED + older: bind-only select with
 *   tailoring preserved.
 * The application row is never touched. A gate/CAS rejection
 * throws `GateRejected` so the review writes roll back with it —
 * an approval either lands completely or writes nothing.
 */
export function approveResume(
  handle: DatabaseHandle,
  rawInput: unknown,
  deps: { artifactsDir: string },
): ApproveResumeResult {
  const input = ApproveResumeInput.parse(rawInput);
  const now = input.now ?? utcNow();

  // Pre-transaction verification: filesystem reads must stay out of the
  // SQLite transaction. Every database predicate is re-verified inside.
  const pre = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
  if (!pre.ok) {
    return pre.failure;
  }
  const preFresh = checkVersionFreshness(pre.target, input.observedRowVersion);
  if (preFresh !== null) {
    return preFresh;
  }
  const preApprovable = checkApprovable(pre.target);
  if (preApprovable !== null) {
    return preApprovable;
  }
  const preLive = checkNoLiveRun(handle, pre.target);
  if (preLive !== null) {
    return preLive;
  }
  const preFrozen = checkFrozenFreshness(handle, pre.target);
  if (preFrozen !== null) {
    return preFrozen;
  }
  const verified = verifyVersionArtifacts(handle, input.resumeVersionId, deps.artifactsDir);
  if (!verified.ok) {
    return verified.failure;
  }
  const resumeHash = resumeIdentityHash(pre.target.version);
  const contentHash = pre.target.version.contentHash;

  try {
    return withTransaction(handle.sqlite, () => {
      const loaded = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
      if (!loaded.ok) {
        return loaded.failure;
      }
      const fresh = checkVersionFreshness(loaded.target, input.observedRowVersion);
      if (fresh !== null) {
        return fresh;
      }
      const approvable = checkApprovable(loaded.target);
      if (approvable !== null) {
        return approvable;
      }
      const live = checkNoLiveRun(handle, loaded.target);
      if (live !== null) {
        return live;
      }
      const frozen = checkFrozenFreshness(handle, loaded.target);
      if (frozen !== null) {
        return frozen;
      }
      handle.db
        .update(resumeVersions)
        .set({ reviewState: "APPROVED", updatedAt: now })
        .where(eq(resumeVersions.id, input.resumeVersionId))
        .run();
      const reviewId = newId();
      handle.db
        .insert(resumeReviews)
        .values({
          id: reviewId,
          resumeVersionId: input.resumeVersionId,
          action: "APPROVED",
          actor: "human",
          note: input.note ?? null,
          resumeHash,
          contentHash,
          artifactHashesJson: canonicalJson(verified.digests),
          createdAt: now,
        })
        .run();
      const active = isActiveTarget(loaded.target);
      if (loaded.target.job.status === "NEW") {
        if (active) {
          const gated = approveTailored(handle, {
            jobId: input.jobId,
            resumeVersionId: input.resumeVersionId,
            observedRowVersion: input.observedRowVersion,
            actor: "human",
            now,
          });
          if (!gated.ok) {
            throw new GateRejected(gated);
          }
          return {
            ok: true as const,
            jobId: input.jobId,
            resumeVersionId: input.resumeVersionId,
            version: loaded.target.version.version,
            reviewId,
            eventId: gated.eventId,
            approvalCase: "move" as const,
            newRowVersion: gated.newRowVersion,
            resumeHash,
            contentHash,
            artifactHashes: verified.digests,
          };
        }
        return approveOlderMove(handle, loaded.target, {
          resumeVersionId: input.resumeVersionId,
          observedRowVersion: input.observedRowVersion,
          reviewId,
          resumeHash,
          contentHash,
          digests: verified.digests,
          now,
        });
      }
      // Bind-only approval: the card already moved, so the version is
      // selected in place and no board move or event is recorded. The
      // active draft flips tailoring to APPROVED; an older decision
      // preserves the tailoring state that follows the active draft.
      const bound = casJobTailoringState(handle, {
        jobId: input.jobId,
        rowVersion: input.observedRowVersion,
        tailoringState: active ? "APPROVED" : loaded.target.job.tailoringState,
        reasonCode: active ? null : loaded.target.job.tailoringReasonCode,
        selectedResumeVersionId: input.resumeVersionId,
        now,
      });
      if (!bound) {
        // Throw so the staged version/review writes roll back with the
        // lost fence — a conflict must write nothing.
        const current = getTailoringJob(handle, input.jobId);
        throw new GateRejected({
          ok: false,
          error: "conflict",
          detail: `stale client: observed row_version ${input.observedRowVersion}`,
          currentRowVersion: current?.rowVersion ?? input.observedRowVersion,
        });
      }
      return {
        ok: true as const,
        jobId: input.jobId,
        resumeVersionId: input.resumeVersionId,
        version: loaded.target.version.version,
        reviewId,
        eventId: null,
        approvalCase: "select" as const,
        newRowVersion: input.observedRowVersion + 1,
        resumeHash,
        contentHash,
        artifactHashes: verified.digests,
      };
    });
  } catch (error: unknown) {
    if (error instanceof GateRejected) {
      const gated = error.failure;
      return gated.error === "conflict"
        ? failure(gated.error, gated.detail, gated.currentRowVersion)
        : failure(
            gated.error === "unknown-job" || gated.error === "tailored-binding"
              ? gated.error
              : "forbidden",
            gated.detail,
            gated.currentRowVersion,
          );
    }
    throw error;
  }
}

/**
 * Older-version NEW→TAILORED move: the same planned board move,
 * rank preservation, event, and selected pointer as the Tailored
 * gate, minus the active-pointer requirement, minus the tailoring
 * flip (tailoring follows the active newer draft). Runs inside the
 * approval transaction; CAS loss throws `GateRejected` so the
 * staged review rolls back with it.
 */
function approveOlderMove(
  handle: DatabaseHandle,
  target: ReviewTarget,
  input: {
    resumeVersionId: string;
    observedRowVersion: number;
    reviewId: string;
    resumeHash: string;
    contentHash: string;
    digests: ArtifactDigests;
    now: string;
  },
): Extract<ApproveResumeResult, { ok: true }> {
  const board = getJobBoardRow(handle, target.job.id);
  if (board === null) {
    throw new GateRejected({
      ok: false,
      error: "unknown-job",
      detail: `job ${target.job.id} does not exist`,
      currentRowVersion: target.job.rowVersion,
    });
  }
  const planned = planBoardMove(
    { status: board.status, rowVersion: board.rowVersion },
    { kind: "approval", to: "TAILORED", observedRowVersion: input.observedRowVersion },
  );
  if (!planned.ok) {
    throw new GateRejected({
      ok: false,
      error: planned.error === "conflict" ? "conflict" : "forbidden",
      detail: planned.detail,
      currentRowVersion: board.rowVersion,
    });
  }
  const updated = casUpdateJobBoard(handle, {
    jobId: target.job.id,
    expectedVersion: input.observedRowVersion,
    status: "TAILORED",
    rank: board.rank,
    selectedResumeVersionId: input.resumeVersionId,
    now: input.now,
  });
  if (updated === null) {
    const current = getTailoringJob(handle, target.job.id);
    throw new GateRejected({
      ok: false,
      error: "conflict",
      detail: `stale client: observed row_version ${input.observedRowVersion}`,
      currentRowVersion: current?.rowVersion ?? input.observedRowVersion,
    });
  }
  const eventId = appendWorkflowEvent(handle, {
    jobId: target.job.id,
    actor: "human",
    from: planned.from,
    to: planned.to,
    rank: board.rank,
    rowVersion: planned.newRowVersion,
    reason: "approval",
    metadata: {
      resumeVersionId: input.resumeVersionId,
      reviewId: input.reviewId,
      approvalCase: "move",
    },
    now: input.now,
  });
  return {
    ok: true as const,
    jobId: target.job.id,
    resumeVersionId: input.resumeVersionId,
    version: target.version.version,
    reviewId: input.reviewId,
    eventId,
    approvalCase: "move" as const,
    newRowVersion: planned.newRowVersion,
    resumeHash: input.resumeHash,
    contentHash: input.contentHash,
    artifactHashes: input.digests,
  };
}

function checkApprovable(target: ReviewTarget): ReviewCommandFailure | null {
  if (
    target.job.status !== "NEW" &&
    target.job.status !== "TAILORED" &&
    target.job.status !== "APPLIED" &&
    target.job.status !== "INTERVIEWED"
  ) {
    return failure(
      "forbidden",
      `approval is not available on ${target.job.status} jobs`,
      target.job.rowVersion,
    );
  }
  // No tailoring-state gate: eligible older versions stay decidable
  // whatever the active draft is doing; the explicit live-run check
  // owns liveness instead.
  const planned = planReviewTransition(target.version.reviewState as ReviewState, {
    to: "APPROVED",
  });
  if (!planned.ok) {
    return failure(
      "forbidden",
      `resume v${target.version.version} is ${target.version.reviewState}: ${planned.detail}`,
      target.job.rowVersion,
    );
  }
  return null;
}

/**
 * Map a generation preflight failure into the review failure vocabulary.
 * Preflight detail stays actionable (detail + action); conflicts keep the
 * current version so the client can refresh.
 */
function mapGenerationFailure(
  generated: Extract<RequestGenerationResult, { ok: false }>,
  currentRowVersion: number,
): ReviewCommandFailure {
  const detail = `${generated.detail} ${generated.action}`;
  switch (generated.error) {
    case "unknown-job":
      return failure("unknown-job", detail);
    case "conflict":
    case "idempotency-mismatch":
    case "generation-busy":
      return failure("conflict", detail, currentRowVersion);
    case "parent-mismatch":
      return failure("stale-version", detail, currentRowVersion);
    default:
      return failure("forbidden", detail, currentRowVersion);
  }
}

/**
 * Human revision request. In one transaction: verify the review target,
 * run the full generation preflight and record the follow-up REVISION
 * run (fenced inside `requestGeneration`, so a lost race returns
 * `conflict` with nothing written), then mark the version
 * REVISION_REQUESTED and append the review with the human note bound to
 * the stored digests. The command either lands completely — review plus
 * follow-up run — or writes nothing.
 */
export function requestRevision(
  handle: DatabaseHandle,
  rawInput: unknown,
  deps?: { providerAvailable?: () => boolean },
): RequestRevisionResult {
  const input = RequestRevisionInput.parse(rawInput);
  const now = input.now ?? utcNow();
  return withTransaction(handle.sqlite, () => {
    const loaded = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
    if (!loaded.ok) {
      return loaded.failure;
    }
    const { job, version } = loaded.target;
    const fresh = checkVersionFreshness(loaded.target, input.observedRowVersion);
    if (fresh !== null) {
      return fresh;
    }
    if (job.status === "REJECTED") {
      return failure(
        "forbidden",
        "rejected jobs cannot request revision; correct the job back first",
        job.rowVersion,
      );
    }
    const tailorPlanned = planTailoringTransition(job.tailoringState as TailoringState, {
      to: "REVISION_REQUESTED",
    });
    if (!tailorPlanned.ok) {
      return failure(
        "forbidden",
        `job tailoring is ${job.tailoringState}: ${tailorPlanned.detail}`,
        job.rowVersion,
      );
    }
    const planned = planReviewTransition(version.reviewState as ReviewState, {
      to: "REVISION_REQUESTED",
    });
    if (!planned.ok) {
      return failure(
        "forbidden",
        `resume v${version.version} is ${version.reviewState}: ${planned.detail}`,
        job.rowVersion,
      );
    }
    const digests = storedArtifactDigests(handle, version.id);
    if (digests === null) {
      return failure(
        "artifact-incomplete",
        "resume artifacts are incomplete; the review cannot bind its digests",
        job.rowVersion,
      );
    }
    // Delegate the fence, preflight, request row, and queue insert to the
    // explicit generation command (nest-safe): profile readiness,
    // evidence, JD content, and provider availability are all verified
    // before anything is written.
    const generated = requestGeneration(
      handle,
      {
        jobId: job.id,
        observedRowVersion: input.observedRowVersion,
        actor: "human",
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(input.selectedKeywords === undefined ? {} : { selectedKeywords: input.selectedKeywords }),
        ...(input.directives === undefined ? {} : { directives: input.directives }),
        revisionNote: input.note,
        parentVersionId: version.id,
        requestId: newId(),
        ...(input.now === undefined ? {} : { now: input.now }),
      },
      ...(deps === undefined ? [] : [{ providerAvailable: deps.providerAvailable }] as const),
    );
    if (!generated.ok) {
      return mapGenerationFailure(generated, job.rowVersion);
    }
    handle.db
      .update(resumeVersions)
      .set({ reviewState: "REVISION_REQUESTED", updatedAt: now })
      .where(eq(resumeVersions.id, version.id))
      .run();
    const reviewId = newId();
    handle.db
      .insert(resumeReviews)
      .values({
        id: reviewId,
        resumeVersionId: version.id,
        action: "REVISION_REQUESTED",
        actor: "human",
        note: input.note,
        resumeHash: resumeIdentityHash(version),
        contentHash: version.contentHash,
        artifactHashesJson: canonicalJson(digests),
        createdAt: now,
      })
      .run();
    return {
      ok: true,
      jobId: job.id,
      resumeVersionId: version.id,
      version: version.version,
      reviewId,
      requestId: generated.requestId,
      workItemId: generated.workItemId,
      newRowVersion: generated.newRowVersion,
    };
  });
}

function checkDeclinable(target: ReviewTarget): ReviewCommandFailure | null {
  if (target.job.status === "REJECTED") {
    return failure(
      "forbidden",
      "rejected jobs cannot decline versions; correct the job back first",
      target.job.rowVersion,
    );
  }
  const planned = planReviewTransition(target.version.reviewState as ReviewState, {
    to: "DECLINED",
  });
  if (!planned.ok) {
    return failure(
      "forbidden",
      `resume v${target.version.version} is ${target.version.reviewState}: ${planned.detail}`,
      target.job.rowVersion,
    );
  }
  return null;
}

/**
 * Human decline (G). Pre-transaction: ownership, CAS, eligibility,
 * live-run exclusion, and frozen-input freshness. In one
 * transaction the predicates re-verify, the version freezes as
 * DECLINED with its terminal review, and the job CAS-bumps: the
 * active draft moves tailoring to DECLINED with
 * `VERSION_DECLINED`, while an older decision preserves the
 * tailoring state that follows the active draft. Stored (not
 * re-hashed) digests bind the review — damaged bytes are a reason
 * to decline, never a blocker. Queues no work, moves no board,
 * touches no pointer.
 */
export function declineVersion(
  handle: DatabaseHandle,
  rawInput: unknown,
): DeclineVersionResult {
  const input = DeclineVersionInput.parse(rawInput);
  const now = input.now ?? utcNow();
  const pre = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
  if (!pre.ok) {
    return pre.failure;
  }
  const preFresh = checkVersionFreshness(pre.target, input.observedRowVersion);
  if (preFresh !== null) {
    return preFresh;
  }
  const preDeclinable = checkDeclinable(pre.target);
  if (preDeclinable !== null) {
    return preDeclinable;
  }
  const preLive = checkNoLiveRun(handle, pre.target);
  if (preLive !== null) {
    return preLive;
  }
  const preFrozen = checkFrozenFreshness(handle, pre.target);
  if (preFrozen !== null) {
    return preFrozen;
  }
  return withTransaction(handle.sqlite, () => {
    const loaded = loadReviewTarget(handle, input.jobId, input.resumeVersionId);
    if (!loaded.ok) {
      return loaded.failure;
    }
    const { job, version } = loaded.target;
    const fresh = checkVersionFreshness(loaded.target, input.observedRowVersion);
    if (fresh !== null) {
      return fresh;
    }
    const declinable = checkDeclinable(loaded.target);
    if (declinable !== null) {
      return declinable;
    }
    const live = checkNoLiveRun(handle, loaded.target);
    if (live !== null) {
      return live;
    }
    const frozen = checkFrozenFreshness(handle, loaded.target);
    if (frozen !== null) {
      return frozen;
    }
    // Stored digests, like revision: damaged bytes are a reason to
    // decline, never a blocker.
    const digests = storedArtifactDigests(handle, version.id);
    if (digests === null) {
      return failure(
        "artifact-incomplete",
        "resume artifacts are incomplete; the review cannot bind its digests",
        job.rowVersion,
      );
    }
    const active = isActiveTarget(loaded.target);
    if (active) {
      const tailorPlanned = planTailoringTransition(job.tailoringState as TailoringState, {
        to: "DECLINED",
        reasonCode: "VERSION_DECLINED",
      });
      if (!tailorPlanned.ok) {
        return failure(
          "forbidden",
          `job tailoring is ${job.tailoringState}: ${tailorPlanned.detail}`,
          job.rowVersion,
        );
      }
    }
    const fenced = casJobTailoringState(handle, {
      jobId: job.id,
      rowVersion: job.rowVersion,
      tailoringState: active ? "DECLINED" : job.tailoringState,
      reasonCode: active ? "VERSION_DECLINED" : job.tailoringReasonCode,
      now,
    });
    if (!fenced) {
      const current = getTailoringJob(handle, job.id);
      return failure(
        "conflict",
        `stale client: observed row_version ${input.observedRowVersion}`,
        current?.rowVersion ?? job.rowVersion,
      );
    }
    handle.db
      .update(resumeVersions)
      .set({ reviewState: "DECLINED", updatedAt: now })
      .where(eq(resumeVersions.id, version.id))
      .run();
    const reviewId = newId();
    handle.db
      .insert(resumeReviews)
      .values({
        id: reviewId,
        resumeVersionId: version.id,
        action: "DECLINED",
        actor: "human",
        note: input.note,
        resumeHash: resumeIdentityHash(version),
        contentHash: version.contentHash,
        artifactHashesJson: canonicalJson(digests),
        createdAt: now,
      })
      .run();
    return {
      ok: true,
      jobId: job.id,
      resumeVersionId: version.id,
      version: version.version,
      reviewId,
      newRowVersion: job.rowVersion + 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Review read model
// ---------------------------------------------------------------------------

export interface ReviewRequirementView {
  requirementId: string;
  jdQuote: string;
  category: string;
  importance: string;
  matchStatus: string;
  evidenceFactIds: string[];
  reviewStatus: string;
}

export interface ReviewGapView {
  requirementId: string;
  jdQuote: string;
  category: string;
  importance: string;
  matchStatus: string;
  /** Directive-gap explanation; null for requirement gaps and legacy rows. */
  explanation: string | null;
}

export interface TermCoachingView {
  term: string;
  outcome: "used" | "omitted-by-budget" | "unsupported" | "not-applicable" | "not-assessed";
  requirementIds: string[];
  evidenceFactIds: string[];
  detail: string;
}

export interface DirectiveCoachingView {
  index: number;
  directive: string;
  outcome: "used" | "unsupported" | "not-assessed";
  explanation: string | null;
}

export interface CoachingView {
  policyVersion: string;
  /**
   * False when the bound run data is incomplete or unreadable: term
   * outcomes degrade to not-assessed rather than inventing verdicts.
   */
  assessed: boolean;
  terms: TermCoachingView[];
  directivesRecorded: boolean;
  directives: DirectiveCoachingView[];
}

/**
 * Exact recorded guidance for one version (WO-1.2-F, F7): the frozen
 * bindings from the bound `generation_requests` row — profile identity
 * (live id plus the generation-time display name from the immutable
 * steering snapshot), the recorded keyword set in its stored canonical
 * order, directive text, and the applicable revision note. Submission
 * chip order is not recorded by design (R-ADR-017 canonical set
 * semantics), so the view surfaces the recorded set, never a
 * reconstructed order. Null when the version has no bound request
 * (legacy rows predate recorded guidance — the not-recorded rule).
 */
export interface RecordedGuidanceView {
  profileId: string;
  profileVersionId: string;
  /** Bound master version number; null when the version row is unresolvable. */
  profileVersionNumber: number | null;
  /** Generation-time display name; null only when the steering record is unreadable. */
  profileDisplayName: string | null;
  selectedKeywords: string[];
  directives: string | null;
  revisionNote: string | null;
}

export interface TopKeywordAuditView {
  keyword: string;
  requirementId: string;
  category: string;
  importance: string;
  evidenced: boolean;
  evidenceFactIds: string[];
  /** Rendered sections mentioning the keyword; gap keywords may list none. */
  placements: KeywordPlacement[];
}

export interface ReviewClaimView {
  id: string;
  claimText: string;
  requirementRef: string | null;
  derivationKind: string | null;
  facts: Array<{ factId: string; statement: string; kind: string }>;
}

export interface ReviewContentView {
  summaryStrategy: string;
  omittedUnsupported: string[];
  changeSummary: {
    addedBullets: string[];
    removedBullets: string[];
    summaryChanged: boolean;
    baselineLines: number;
    tailoredLines: number;
  } | null;
  audit: {
    requirementsTotal: number;
    supportedCount: number;
    gapCount: number;
    validatedClaims: number;
    totalClaims: number;
    rationale: string;
    questions: string[];
  } | null;
}

export interface ResumeReviewArtifactView {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}

export interface ResumeReviewRowView {
  id: string;
  action: string;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface ResumeReviewView {
  job: {
    id: string;
    status: string;
    rowVersion: number;
    tailoringState: string;
    activeResumeVersionId: string | null;
  };
  version: {
    id: string;
    jobId: string;
    version: number;
    parentVersionId: string | null;
    reviewState: string;
    contentHash: string;
    templateId: string;
    templateVersion: string;
    rankerVersion: string;
    policyVersion: string;
    configVersion: string;
    renderSchemaVersion: string;
    createdAt: string;
  };
  /** Null when the analysis row is missing or unparseable. */
  analysis: {
    id: string;
    requirements: ReviewRequirementView[];
    gaps: ReviewGapView[];
    rationale: string | null;
    provider: string | null;
    model: string | null;
    promptVersion: string;
  } | null;
  claims: ReviewClaimView[];
  /** Top-5 ATS keyword audit; empty when the analysis is unparseable. */
  topKeywords: TopKeywordAuditView[];
  /**
   * Requested-emphasis coaching (WO-1.2-E): per-term and per-directive
   * outcomes derived from the bound run. Null when the version has no
   * bound generation request (legacy rows predate requested emphasis).
   */
  coaching: CoachingView | null;
  /**
   * Exact recorded guidance (WO-1.2-F, F7). Null for legacy versions
   * without request linkage — never fabricated.
   */
  guidance: RecordedGuidanceView | null;
  /** Null when the stored content envelope is unparseable. */
  content: ReviewContentView | null;
  artifacts: ResumeReviewArtifactView[];
  reviews: ResumeReviewRowView[];
  actions: {
    canApprove: boolean;
    canRequestRevision: boolean;
    canDecline: boolean;
    reason: string | null;
  };
  /**
   * Exact-version extension (WO-1.3-G): frozen identities, master,
   * operations, segments with provenance, assessment, insights,
   * exact allowed actions, and markers. Null when the extension
   * cannot be built (the v1 view above still serves).
   */
  workflowReview: WorkflowReviewV2 | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? [...value]
    : null;
}

function parseRequirement(entry: unknown): ReviewRequirementView | null {
  const record = asRecord(entry);
  const requirementId = record === null ? null : asString(record["requirement_id"]);
  const jdQuote = record === null ? null : asString(record["jd_quote"]);
  if (requirementId === null || jdQuote === null) {
    return null;
  }
  const evidence = record !== null ? asStringArray(record["evidence_fact_ids"]) : null;
  return {
    requirementId,
    jdQuote,
    category: asString(record?.["category"]) ?? "unknown",
    importance: asString(record?.["importance"]) ?? "unknown",
    matchStatus: asString(record?.["match_status"]) ?? "unknown",
    evidenceFactIds: evidence ?? [],
    reviewStatus: asString(record?.["review_status"]) ?? "unknown",
  };
}

function parseGap(entry: unknown): ReviewGapView | null {
  const record = asRecord(entry);
  const requirementId = record === null ? null : asString(record["requirement_id"]);
  const jdQuote = record === null ? null : asString(record["jd_quote"]);
  if (requirementId === null || jdQuote === null) {
    return null;
  }
  return {
    requirementId,
    jdQuote,
    category: asString(record?.["category"]) ?? "unknown",
    importance: asString(record?.["importance"]) ?? "unknown",
    matchStatus: asString(record?.["match_status"]) ?? "unknown",
    explanation: asString(record?.["explanation"]),
  };
}

function parseChangeSummary(value: unknown): ReviewContentView["changeSummary"] {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const added = asStringArray(record["addedBullets"]);
  const removed = asStringArray(record["removedBullets"]);
  const summaryChanged = record["summaryChanged"];
  const baselineLines = record["baselineLines"];
  const tailoredLines = record["tailoredLines"];
  if (
    added === null ||
    removed === null ||
    typeof summaryChanged !== "boolean" ||
    typeof baselineLines !== "number" ||
    typeof tailoredLines !== "number"
  ) {
    return null;
  }
  return { addedBullets: added, removedBullets: removed, summaryChanged, baselineLines, tailoredLines };
}

function parseDraftClaims(value: unknown): Array<{ section: string; text: string }> {
  const record = asRecord(value);
  const draft = record === null ? null : asRecord(record["draft"]);
  const claims = draft === null ? null : draft["claims"];
  if (!Array.isArray(claims)) {
    return [];
  }
  const parsed: Array<{ section: string; text: string }> = [];
  for (const entry of claims) {
    const item = asRecord(entry);
    const section = item === null ? null : asString(item["section"]);
    const text = item === null ? null : asString(item["text"]);
    if (section !== null && text !== null) {
      parsed.push({ section, text });
    }
  }
  return parsed;
}

/**
 * Requested-emphasis coaching for one version (WO-1.2-E): per-term and
 * per-directive outcomes derived from the bound generation request,
 * the pinned JD text, and the stored requirements/gaps/claims.
 * Fail-soft like the rest of the view — no bound request yields null
 * (legacy), and unreadable run data degrades every outcome to
 * not-assessed rather than inventing verdicts.
 */
function buildCoachingView(
  handle: DatabaseHandle,
  analysis: { generationRequestId: string | null; jdSnapshotId: string } | undefined,
  analysisView: ResumeReviewView["analysis"],
  claims: ReviewClaimView[],
): CoachingView | null {
  if (analysis === undefined || analysis.generationRequestId === null) {
    return null;
  }
  const request = handle.db
    .select({
      selectedKeywordsJson: generationRequests.selectedKeywordsJson,
      directivesText: generationRequests.directivesText,
    })
    .from(generationRequests)
    .where(eq(generationRequests.id, analysis.generationRequestId))
    .get();
  if (request === undefined) {
    return null;
  }
  let selectedKeywords: string[] = [];
  try {
    const parsed: unknown = JSON.parse(request.selectedKeywordsJson);
    if (Array.isArray(parsed)) {
      selectedKeywords = parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      );
    }
  } catch {
    selectedKeywords = [];
  }
  if (analysisView === null) {
    return {
      policyVersion: COACHING_OUTCOMES_VERSION,
      assessed: false,
      terms: selectedKeywords.map((term) => ({
        term,
        outcome: "not-assessed",
        requirementIds: [],
        evidenceFactIds: [],
        detail: "Run data is incomplete or unreadable — no verdict is claimed.",
      })),
      directivesRecorded: request.directivesText !== null,
      directives: [],
    };
  }
  const snapshot = handle.db
    .select({ jdText: jdSnapshots.jdText })
    .from(jdSnapshots)
    .where(eq(jdSnapshots.id, analysis.jdSnapshotId))
    .get();
  const jdText = snapshot?.jdText ?? "";
  const directiveGaps = analysisView.gaps.filter((gap) => gap.category === "directive");
  const requirementGaps = analysisView.gaps.filter((gap) => gap.category !== "directive");
  const directives = evaluateDirectiveOutcomes({
    directivesText: request.directivesText,
    directiveGaps: directiveGaps.map((gap) => ({
      requirementId: gap.requirementId,
      explanation: gap.explanation,
    })),
  });
  return {
    policyVersion: COACHING_OUTCOMES_VERSION,
    assessed: true,
    terms: evaluateTermOutcomes({
      selectedKeywords,
      requirements: analysisView.requirements,
      gaps: requirementGaps,
      claims,
      jdText,
    }),
    directivesRecorded: directives.recorded,
    directives: directives.outcomes,
  };
}

/**
 * Exact recorded guidance for one version (WO-1.2-F, F7): the frozen
 * bindings from the bound generation request. Fail-soft like the rest
 * of the view — no bound request yields null (legacy not-recorded
 * rule), and unreadable steering/keyword JSON degrades the affected
 * field (null/[]) rather than inventing guidance or failing the view.
 */
function buildGuidanceView(
  handle: DatabaseHandle,
  analysis: { generationRequestId: string | null } | undefined,
): RecordedGuidanceView | null {
  if (analysis === undefined || analysis.generationRequestId === null) {
    return null;
  }
  const request = handle.db
    .select({
      profileId: generationRequests.profileId,
      profileVersionId: generationRequests.profileVersionId,
      steeringSnapshotJson: generationRequests.steeringSnapshotJson,
      selectedKeywordsJson: generationRequests.selectedKeywordsJson,
      directivesText: generationRequests.directivesText,
      revisionNote: generationRequests.revisionNote,
    })
    .from(generationRequests)
    .where(eq(generationRequests.id, analysis.generationRequestId))
    .get();
  if (request === undefined) {
    return null;
  }
  let selectedKeywords: string[] = [];
  try {
    const parsed: unknown = JSON.parse(request.selectedKeywordsJson);
    if (Array.isArray(parsed)) {
      selectedKeywords = parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      );
    }
  } catch {
    selectedKeywords = [];
  }
  let profileDisplayName: string | null = null;
  try {
    const steering = SteeringSnapshotV1.parse(JSON.parse(request.steeringSnapshotJson));
    profileDisplayName = steering.profileDisplayName;
  } catch {
    profileDisplayName = null;
  }
  const profileVersion = handle.db
    .select({ version: candidateProfileVersions.version })
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.id, request.profileVersionId))
    .get();
  return {
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    profileVersionNumber: profileVersion?.version ?? null,
    profileDisplayName,
    selectedKeywords,
    directives: request.directivesText,
    revisionNote: request.revisionNote,
  };
}

/**
 * Top-5 ATS keyword audit for one version: deterministic selection over
 * the stored analysis requirements plus a placement check against the
 * stored draft, the rebuilt skill rows, and the header text. Fail-soft
 * like the rest of the view — a missing snapshot or corrupt envelope
 * yields keywords without placements (or none at all), never an error.
 */
function buildTopKeywordAudit(
  handle: DatabaseHandle,
  analysis: { candidateSnapshotId: string | null } | undefined,
  contentJson: string,
  requirementEntries: unknown[] | null,
  gapEntries: unknown[] | null,
): TopKeywordAuditView[] {
  if (requirementEntries === null) {
    return [];
  }
  const keywords = selectTopKeywords([...requirementEntries, ...(gapEntries ?? [])]);
  if (keywords.length === 0) {
    return [];
  }
  let profile: CandidateProfileInput | null = null;
  const snapshotId = analysis?.candidateSnapshotId ?? null;
  if (snapshotId !== null) {
    try {
      const snapshot = getCandidateSnapshotById(handle, snapshotId);
      if (snapshot !== null) {
        profile = adaptSnapshotProfile(
          CandidateSnapshotV1.parse(JSON.parse(snapshot.canonicalJson)),
        );
      }
    } catch {
      profile = null;
    }
  }
  let draftClaims: Array<{ section: string; text: string }> = [];
  try {
    draftClaims = parseDraftClaims(JSON.parse(contentJson));
  } catch {
    draftClaims = [];
  }
  const skillTerms =
    profile === null
      ? []
      : planSkillRows({ profile, requirements: requirementEntries }).flatMap((row) => row.terms);
  const headerText = profile === null ? "" : `${profile.full_name} ${profile.headline ?? ""}`;
  const summaryText = draftClaims
    .filter((claim) => claim.section === "summary")
    .map((claim) => claim.text)
    .join("\n");
  const bulletTexts = draftClaims
    .filter((claim) => claim.section === "experience")
    .map((claim) => claim.text);
  return keywords.map((entry) => ({
    ...entry,
    placements: locateKeywordPlacements({
      keyword: entry.keyword,
      headerText,
      summaryText,
      skillTerms,
      bulletTexts,
    }),
  }));
}

function parseAudit(value: unknown): ReviewContentView["audit"] {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const numbers = [
    "requirementsTotal",
    "supportedCount",
    "gapCount",
    "validatedClaims",
    "totalClaims",
  ].map((key) => record[key]);
  if (!numbers.every((entry): entry is number => typeof entry === "number")) {
    return null;
  }
  const rationale = asString(record["rationale"]);
  const questions = asStringArray(record["questions"]);
  if (rationale === null || questions === null) {
    return null;
  }
  const [requirementsTotal, supportedCount, gapCount, validatedClaims, totalClaims] =
    numbers as [number, number, number, number, number];
  return {
    requirementsTotal,
    supportedCount,
    gapCount,
    validatedClaims,
    totalClaims,
    rationale,
    questions,
  };
}

/**
 * Side-by-side review projection for one resume version: proposal
 * requirements with evidence, explicit gaps, claim-level fact citations,
 * the deterministic change summary, and artifact handles. Plain
 * synchronous SELECTs with fail-soft JSON parsing — one corrupt row
 * nulls its section instead of failing the review.
 */
export function getResumeReviewView(
  handle: DatabaseHandle,
  resumeVersionId: string,
  options: { artifactsDir?: string } = {},
): ResumeReviewView | null {
  const version = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, resumeVersionId))
    .get();
  if (version === undefined) {
    return null;
  }
  const job = getTailoringJob(handle, version.jobId);
  if (job === null) {
    return null;
  }
  const analysis = handle.db
    .select()
    .from(jobAnalyses)
    .where(eq(jobAnalyses.id, version.analysisId))
    .get();

  let analysisView: ResumeReviewView["analysis"] = null;
  let keywordEntries: unknown[] | null = null;
  let keywordGaps: unknown[] | null = null;
  if (analysis !== undefined) {
    try {
      const requirementsDoc = asRecord(JSON.parse(analysis.requirementsJson));
      const gapsDoc = asRecord(JSON.parse(analysis.gapsJson));
      const requirementEntries = Array.isArray(requirementsDoc?.["requirements"])
        ? (requirementsDoc?.["requirements"] as unknown[])
        : null;
      const gapEntries = Array.isArray(gapsDoc?.["gaps"]) ? (gapsDoc?.["gaps"] as unknown[]) : null;
      keywordEntries = requirementEntries;
      keywordGaps = gapEntries;
      if (requirementEntries !== null && gapEntries !== null) {
        const requirements: ReviewRequirementView[] = [];
        const gaps: ReviewGapView[] = [];
        let malformed = false;
        for (const entry of requirementEntries) {
          const parsed = parseRequirement(entry);
          if (parsed === null) {
            malformed = true;
            break;
          }
          requirements.push(parsed);
        }
        if (!malformed) {
          for (const entry of gapEntries) {
            const parsed = parseGap(entry);
            if (parsed === null) {
              malformed = true;
              break;
            }
            gaps.push(parsed);
          }
        }
        if (!malformed) {
          analysisView = {
            id: analysis.id,
            requirements,
            gaps,
            rationale: analysis.rationale,
            provider: analysis.provider,
            model: analysis.model,
            promptVersion: analysis.promptVersion,
          };
        }
      }
    } catch {
      analysisView = null;
    }
  }

  const claimRows = handle.db
    .select()
    .from(resumeClaims)
    .where(eq(resumeClaims.resumeVersionId, version.id))
    .orderBy(asc(resumeClaims.createdAt), asc(resumeClaims.id))
    .all();
  const claims: ReviewClaimView[] = claimRows.map((claim) => {
    const links = handle.db
      .select({ factId: resumeClaimFacts.factId })
      .from(resumeClaimFacts)
      .where(eq(resumeClaimFacts.claimId, claim.id))
      .all();
    const facts: ReviewClaimView["facts"] = [];
    for (const link of links) {
      const fact = handle.db
        .select({
          factId: candidateFacts.factId,
          statement: candidateFacts.statement,
          kind: candidateFacts.kind,
        })
        .from(candidateFacts)
        .where(eq(candidateFacts.factId, link.factId))
        .get();
      if (fact !== undefined) {
        facts.push(fact);
      }
    }
    return {
      id: claim.id,
      claimText: claim.claimText,
      requirementRef: claim.requirementRef,
      derivationKind: claim.derivationKind,
      facts,
    };
  });

  let contentView: ResumeReviewView["content"] = null;
  try {
    const doc = asRecord(JSON.parse(version.contentJson));
    if (doc !== null) {
      const summaryStrategy = asString(doc["summaryStrategy"]);
      const omittedUnsupported = asStringArray(doc["omittedUnsupported"]);
      if (summaryStrategy !== null && omittedUnsupported !== null) {
        contentView = {
          summaryStrategy,
          omittedUnsupported,
          changeSummary: parseChangeSummary(doc["changeSummary"]),
          audit: parseAudit(doc["audit"]),
        };
      }
    }
  } catch {
    contentView = null;
  }

  const artifacts = handle.db
    .select({
      id: resumeArtifacts.id,
      kind: resumeArtifacts.kind,
      mediaType: resumeArtifacts.mediaType,
      byteSize: resumeArtifacts.byteSize,
      sha256: resumeArtifacts.sha256,
    })
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.resumeVersionId, version.id))
    .orderBy(resumeArtifacts.kind)
    .all();

  const reviews = handle.db
    .select({
      id: resumeReviews.id,
      action: resumeReviews.action,
      actor: resumeReviews.actor,
      note: resumeReviews.note,
      createdAt: resumeReviews.createdAt,
    })
    .from(resumeReviews)
    .where(eq(resumeReviews.resumeVersionId, version.id))
    .orderBy(asc(resumeReviews.createdAt), asc(resumeReviews.id))
    .all();

  const isActive = job.activeResumeVersionId === version.id;
  const liveReview = version.reviewState === "AWAITING_REVIEW";
  const liveTailoring = job.tailoringState === "AWAITING_REVIEW";
  const decidable = isActive && liveReview && liveTailoring && job.status !== "REJECTED";
  const canRequestRevision = decidable;
  const canDecline = decidable;
  const canApprove = decidable;
  let reason: string | null = null;
  if (!isActive) {
    reason = "A newer resume version is active; this version is read-only.";
  } else if (!liveReview) {
    reason = `This version is ${version.reviewState}; only versions awaiting review can be decided.`;
  } else if (!liveTailoring) {
    reason = `A follow-up run is already in progress (${job.tailoringState}).`;
  } else if (job.status === "REJECTED") {
    reason = "Rejected jobs cannot be approved, revised, or declined.";
  } else if (job.status !== "NEW") {
    reason =
      `This job already moved to ${job.status}; approval binds this version as the ` +
      "selected resume without moving the card.";
  }

  // G extension (one batched statement): strict exact-version model
  // or null. A failure here never breaks the v1 view above.
  let workflowReview: WorkflowReviewV2 | null = null;
  try {
    workflowReview = buildWorkflowReview(handle, {
      version,
      job,
      gapKeys: (analysisView?.gaps ?? []).map((gap) => gap.requirementId),
      artifactsDir: options.artifactsDir,
    });
  } catch {
    workflowReview = null;
  }

  return {
    job: {
      id: job.id,
      status: job.status,
      rowVersion: job.rowVersion,
      tailoringState: job.tailoringState,
      activeResumeVersionId: job.activeResumeVersionId,
    },
    version: {
      id: version.id,
      jobId: version.jobId,
      version: version.version,
      parentVersionId: version.parentVersionId,
      reviewState: version.reviewState,
      contentHash: version.contentHash,
      templateId: version.templateId,
      templateVersion: version.templateVersion,
      rankerVersion: version.rankerVersion,
      policyVersion: version.policyVersion,
      configVersion: version.configVersion,
      renderSchemaVersion: version.renderSchemaVersion,
      createdAt: version.createdAt,
    },
    analysis: analysisView,
    claims,
    topKeywords: buildTopKeywordAudit(
      handle,
      analysis,
      version.contentJson,
      keywordEntries,
      keywordGaps,
    ),
    coaching: buildCoachingView(handle, analysis, analysisView, claims),
    guidance: buildGuidanceView(handle, analysis),
    content: contentView,
    artifacts,
    reviews,
    actions: { canApprove, canRequestRevision, canDecline, reason },
    workflowReview,
  };
}

/** Artifact file metadata for the preview/download route (no paths leak). */
export function getResumeArtifact(
  handle: DatabaseHandle,
  artifactId: string,
): {
  id: string;
  resumeVersionId: string;
  kind: string;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
} | null {
  const row = handle.db
    .select({
      id: resumeArtifacts.id,
      resumeVersionId: resumeArtifacts.resumeVersionId,
      kind: resumeArtifacts.kind,
      relativePath: resumeArtifacts.relativePath,
      mediaType: resumeArtifacts.mediaType,
      byteSize: resumeArtifacts.byteSize,
      sha256: resumeArtifacts.sha256,
    })
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.id, artifactId))
    .get();
  return row ?? null;
}
