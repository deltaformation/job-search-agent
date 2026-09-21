import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { failGenerationRequest, getGenerationRequestByWorkItem } from "../db/generation";
import { resumeReviews, resumeVersions } from "../db/schema";
import { utcNow } from "../db/utils";
import { withTransaction } from "../db/transactions";
import {
  appendWorkflowEvent,
  cancelQueuedWorkForJob,
  casUpdateJobBoard,
  getJobBoardRow,
  insertJobNote,
  maxRankInColumn,
  upsertApplication,
  type WorkflowEventMetadataInput,
} from "../db/workflow";
import {
  checkRowVersion,
  planBoardMove,
  type BoardMoveError,
} from "../domain/board";
import { BoardStatus, type BoardStatus as BoardStatusValue } from "../domain/enums";
import { EntityId, IsoUtcDateTime, RowVersion } from "../domain/fields";

/**
 * Board workflow commands. Every command validates its input, rules the move
 * through the pure `planBoardMove` state machine, and commits status, rank,
 * audit event, and incremented `row_version` in one compare-and-swap
 * transaction — or commits nothing and returns a typed failure.
 *
 * R3-B routes and R4-F approval call these directly; `withTransaction` is
 * nest-safe, so the Tailored gate composes inside the larger R4-F approval
 * transaction. Schema violations throw `ZodError`; rule rejections return
 * `ok: false` with the stale caller's refresh data.
 */

const HumanActor = z.literal("human");

const FiniteRank = z
  .number()
  .refine((value) => Number.isFinite(value), {
    message: "rank must be a finite number",
  });

const NoteBody = z.string().trim().min(1).max(4000);

const DecisionReason = z.string().trim().min(1).max(280);

const ConfirmationNumber = z.string().trim().max(128);

const BaseCommand = z
  .object({
    jobId: EntityId,
    observedRowVersion: RowVersion,
    actor: HumanActor,
    now: IsoUtcDateTime.optional(),
  })
  .strict();

export const MoveJobInput = BaseCommand.extend({
  to: BoardStatus,
  /** Omit to append at the end of the target column. */
  rank: FiniteRank.optional(),
  appliedAt: IsoUtcDateTime.optional(),
  confirmationNumber: ConfirmationNumber.optional(),
  /** Required for ordinary moves into REJECTED. */
  reason: DecisionReason.optional(),
}).strict();
export type MoveJobInput = z.infer<typeof MoveJobInput>;

export const CorrectJobInput = BaseCommand.extend({
  to: BoardStatus,
  note: NoteBody,
  rank: FiniteRank.optional(),
  appliedAt: IsoUtcDateTime.optional(),
  confirmationNumber: ConfirmationNumber.optional(),
  reason: DecisionReason.optional(),
}).strict();
export type CorrectJobInput = z.infer<typeof CorrectJobInput>;

export const ReorderJobInput = BaseCommand.extend({
  rank: FiniteRank,
}).strict();
export type ReorderJobInput = z.infer<typeof ReorderJobInput>;

/**
 * Applied modal contract: the human confirms the application timestamp (and
 * an optional provider confirmation number) for a TAILORED job. Only the
 * ordinary TAILORED → APPLIED path is eligible here; anything else needs an
 * explicit correction with a note.
 */
export const RecordApplicationInput = BaseCommand.extend({
  appliedAt: IsoUtcDateTime,
  confirmationNumber: ConfirmationNumber.optional(),
  rank: FiniteRank.optional(),
}).strict();
export type RecordApplicationInput = z.infer<typeof RecordApplicationInput>;

/**
 * Tailored gate input. R4-F calls `approveTailored` inside its approval
 * transaction after recording the APPROVED review; the gate re-verifies the
 * exact-version binding before the board moves.
 */
export const ApproveTailoredInput = BaseCommand.extend({
  resumeVersionId: EntityId,
}).strict();
export type ApproveTailoredInput = z.infer<typeof ApproveTailoredInput>;

export const AddNoteInput = z
  .object({
    jobId: EntityId,
    body: NoteBody,
    now: IsoUtcDateTime.optional(),
  })
  .strict();
export type AddNoteInput = z.infer<typeof AddNoteInput>;

export type WorkflowCommandError =
  | "unknown-job"
  | BoardMoveError
  | "reason-required"
  | "tailored-binding";

export interface WorkflowCommandFailure {
  ok: false;
  error: WorkflowCommandError;
  detail: string;
  from?: BoardStatusValue;
  to?: BoardStatusValue;
  /** Present on conflicts so a stale client can refresh and retry. */
  currentRowVersion?: number;
}

function failure(
  error: WorkflowCommandError,
  detail: string,
  context: {
    from?: BoardStatusValue;
    to?: BoardStatusValue;
    currentRowVersion?: number;
  } = {},
): WorkflowCommandFailure {
  return { ok: false, error, detail, ...context };
}

export type MoveJobResult =
  | {
      ok: true;
      jobId: string;
      from: BoardStatusValue;
      to: BoardStatusValue;
      newRowVersion: number;
      rank: number;
      eventId: string;
      viaCorrection: boolean;
      /** Set when entering APPLIED; otherwise null. */
      applicationId: string | null;
      /** QUEUED work cancelled by a move into REJECTED. */
      cancelledWorkItems: string[];
    }
  | WorkflowCommandFailure;

export type ReorderJobResult =
  | {
      ok: true;
      jobId: string;
      status: BoardStatusValue;
      newRowVersion: number;
      rank: number;
      /** Null when the rank already matched and nothing was written. */
      eventId: string | null;
      moved: boolean;
    }
  | WorkflowCommandFailure;

export type RecordApplicationResult =
  | {
      ok: true;
      jobId: string;
      from: BoardStatusValue;
      newRowVersion: number;
      rank: number;
      eventId: string;
      applicationId: string;
      appliedAt: string;
    }
  | WorkflowCommandFailure;

export type ApproveTailoredResult =
  | {
      ok: true;
      jobId: string;
      newRowVersion: number;
      rank: number;
      eventId: string;
      resumeVersionId: string;
      reviewId: string;
    }
  | WorkflowCommandFailure;

export type AddNoteResult =
  | { ok: true; jobId: string; noteId: string; createdAt: string }
  | WorkflowCommandFailure;

function endOfColumn(handle: DatabaseHandle, status: BoardStatusValue): number {
  return (maxRankInColumn(handle, status) ?? -1) + 1;
}

function normalizeConfirmation(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

interface StatusMoveArgs {
  handle: DatabaseHandle;
  jobId: string;
  to: BoardStatusValue;
  observedRowVersion: number;
  kind: "move" | "correction";
  rank?: number;
  appliedAt?: string;
  confirmationNumber?: string;
  reason?: string;
  note?: string;
  now: string;
}

function executeStatusMove(args: StatusMoveArgs): MoveJobResult {
  const { handle } = args;
  return withTransaction(handle.sqlite, () => {
    const job = getJobBoardRow(handle, args.jobId);
    if (job === null) {
      return failure("unknown-job", `job ${args.jobId} does not exist`, {
        to: args.to,
      });
    }
    const planned = planBoardMove(
      { status: job.status, rowVersion: job.rowVersion },
      args.kind === "correction"
        ? {
            kind: "correction",
            to: args.to,
            observedRowVersion: args.observedRowVersion,
            note: args.note ?? "",
            appliedAt: args.appliedAt,
          }
        : {
            kind: "move",
            to: args.to,
            observedRowVersion: args.observedRowVersion,
            appliedAt: args.appliedAt,
          },
    );
    if (!planned.ok) {
      return failure(planned.error, planned.detail, {
        from: planned.from,
        to: planned.to,
        currentRowVersion:
          planned.error === "conflict" ? job.rowVersion : undefined,
      });
    }
    if (
      args.kind === "move" &&
      args.to === "REJECTED" &&
      args.reason === undefined
    ) {
      return failure(
        "reason-required",
        "ordinary moves into REJECTED must carry a reason",
        { from: job.status, to: args.to, currentRowVersion: job.rowVersion },
      );
    }
    const rank = args.rank ?? endOfColumn(handle, args.to);
    const updated = casUpdateJobBoard(handle, {
      jobId: args.jobId,
      expectedVersion: args.observedRowVersion,
      status: args.to,
      rank,
      now: args.now,
    });
    if (updated === null) {
      return failure(
        "conflict",
        `stale client: observed row_version ${args.observedRowVersion}, current is ${job.rowVersion}`,
        { from: job.status, to: args.to, currentRowVersion: job.rowVersion },
      );
    }
    let applicationId: string | null = null;
    if (args.to === "APPLIED") {
      const applied = upsertApplication(handle, {
        jobId: args.jobId,
        // The planner rejects APPLIED entries without appliedAt above.
        appliedAt: args.appliedAt ?? "",
        confirmationNumber:
          normalizeConfirmation(args.confirmationNumber) ?? null,
        // D4: pin the selected version at record time (null when the
        // job never had an approval — honest unknown, not a default).
        resumeVersionId: job.selectedResumeVersionId,
        now: args.now,
      });
      applicationId = applied.id;
    }
    let cancelledWorkItems: string[] = [];
    if (args.to === "REJECTED") {
      cancelledWorkItems = cancelQueuedWorkForJob(handle, {
        jobId: args.jobId,
        now: args.now,
      });
      // Retire the requests behind cancelled TAILOR items so no live
      // request outlives the rejection.
      for (const workItemId of cancelledWorkItems) {
        const request = getGenerationRequestByWorkItem(handle, workItemId);
        if (request !== null) {
          failGenerationRequest(handle, {
            requestId: request.id,
            errorCode: "STALE_INPUT",
            errorDetail: "job was rejected; the queued run was cancelled",
            now: args.now,
          });
        }
      }
    }
    const metadata: WorkflowEventMetadataInput = {};
    if (args.reason !== undefined) {
      metadata.reason = args.reason;
    }
    if (args.note !== undefined) {
      metadata.note = args.note;
    }
    if (args.to === "APPLIED" && args.appliedAt !== undefined) {
      metadata.appliedAt = args.appliedAt;
      const confirmation = normalizeConfirmation(args.confirmationNumber);
      if (confirmation !== undefined) {
        metadata.confirmationNumber = confirmation;
      }
    }
    if (cancelledWorkItems.length > 0) {
      metadata.cancelledWorkItems = cancelledWorkItems;
    }
    const eventId = appendWorkflowEvent(handle, {
      jobId: args.jobId,
      actor: "human",
      from: planned.from,
      to: planned.to,
      rank,
      rowVersion: planned.newRowVersion,
      reason: args.kind === "correction" ? "correction" : "move",
      metadata: Object.keys(metadata).length === 0 ? null : metadata,
      now: args.now,
    });
    if (args.kind === "correction" && args.note !== undefined) {
      insertJobNote(handle, { jobId: args.jobId, body: args.note, now: args.now });
    }
    return {
      ok: true,
      jobId: args.jobId,
      from: planned.from,
      to: planned.to,
      newRowVersion: planned.newRowVersion,
      rank,
      eventId,
      viaCorrection: planned.viaCorrection,
      applicationId,
      cancelledWorkItems,
    };
  });
}

/** Ordinary drag/menu/status move along the fixed board graph. */
export function moveJob(
  handle: DatabaseHandle,
  rawInput: unknown,
): MoveJobResult {
  const input = MoveJobInput.parse(rawInput);
  return executeStatusMove({
    handle,
    jobId: input.jobId,
    to: input.to,
    observedRowVersion: input.observedRowVersion,
    kind: "move",
    rank: input.rank,
    appliedAt: input.appliedAt,
    confirmationNumber: input.confirmationNumber,
    reason: input.reason,
    now: input.now ?? utcNow(),
  });
}

/**
 * Explicit correction/reopen with a mandatory human note. Anything outside
 * the ordinary graph — including leaving REJECTED — goes through here, is
 * flagged `viaCorrection`, and mirrors the note into `job_notes`. Entering
 * TAILORED stays approval-only even as a correction.
 */
export function correctJob(
  handle: DatabaseHandle,
  rawInput: unknown,
): MoveJobResult {
  const input = CorrectJobInput.parse(rawInput);
  return executeStatusMove({
    handle,
    jobId: input.jobId,
    to: input.to,
    observedRowVersion: input.observedRowVersion,
    kind: "correction",
    rank: input.rank,
    appliedAt: input.appliedAt,
    confirmationNumber: input.confirmationNumber,
    reason: input.reason,
    note: input.note,
    now: input.now ?? utcNow(),
  });
}

/** Rank-only reorder inside the current column. */
export function reorderJob(
  handle: DatabaseHandle,
  rawInput: unknown,
): ReorderJobResult {
  const input = ReorderJobInput.parse(rawInput);
  const now = input.now ?? utcNow();
  return withTransaction(handle.sqlite, () => {
    const job = getJobBoardRow(handle, input.jobId);
    if (job === null) {
      return failure("unknown-job", `job ${input.jobId} does not exist`);
    }
    const version = checkRowVersion(job.rowVersion, input.observedRowVersion);
    if (!version.ok) {
      return failure(
        "conflict",
        `stale client: observed row_version ${version.observedRowVersion}, current is ${version.currentRowVersion}`,
        { from: job.status, to: job.status, currentRowVersion: job.rowVersion },
      );
    }
    if (input.rank === job.rank) {
      return {
        ok: true,
        jobId: input.jobId,
        status: job.status,
        newRowVersion: job.rowVersion,
        rank: job.rank,
        eventId: null,
        moved: false,
      };
    }
    const updated = casUpdateJobBoard(handle, {
      jobId: input.jobId,
      expectedVersion: input.observedRowVersion,
      status: job.status,
      rank: input.rank,
      now,
    });
    if (updated === null) {
      return failure(
        "conflict",
        `stale client: observed row_version ${input.observedRowVersion}, current is ${job.rowVersion}`,
        { from: job.status, to: job.status, currentRowVersion: job.rowVersion },
      );
    }
    const eventId = appendWorkflowEvent(handle, {
      jobId: input.jobId,
      actor: "human",
      from: job.status,
      to: job.status,
      rank: input.rank,
      rowVersion: job.rowVersion + 1,
      reason: "reorder",
      metadata: null,
      now,
    });
    return {
      ok: true,
      jobId: input.jobId,
      status: job.status,
      newRowVersion: job.rowVersion + 1,
      rank: input.rank,
      eventId,
      moved: true,
    };
  });
}

/** Applied modal submission: human-confirmed TAILORED → APPLIED. */
export function recordApplication(
  handle: DatabaseHandle,
  rawInput: unknown,
): RecordApplicationResult {
  const input = RecordApplicationInput.parse(rawInput);
  const moved = moveJob(handle, {
    jobId: input.jobId,
    observedRowVersion: input.observedRowVersion,
    actor: input.actor,
    now: input.now,
    to: "APPLIED",
    rank: input.rank,
    appliedAt: input.appliedAt,
    confirmationNumber: input.confirmationNumber,
  });
  if (!moved.ok) {
    return moved;
  }
  if (moved.applicationId === null) {
    throw new Error("recordApplication reached APPLIED without an application row");
  }
  return {
    ok: true,
    jobId: moved.jobId,
    from: moved.from,
    newRowVersion: moved.newRowVersion,
    rank: moved.rank,
    eventId: moved.eventId,
    applicationId: moved.applicationId,
    appliedAt: input.appliedAt,
  };
}

/**
 * Tailored gate: NEW → TAILORED after an exact-version human approval. R4-F
 * calls this inside its approval transaction; the nest-safe transaction
 * makes the review rows it just wrote visible to the binding checks below.
 * The gate verifies the job's active pointer, the version's APPROVED state,
 * and a human APPROVED review binding the version's content hash — hash
 * re-computation itself stays R4-F's job, before this call. The single
 * compare-and-swap also flips tailoring to APPROVED: one logical approval,
 * one row_version bump. If this gate rejects after R4-F wrote review rows,
 * the caller must roll the transaction back (a throw does that).
 */
export function approveTailored(
  handle: DatabaseHandle,
  rawInput: unknown,
): ApproveTailoredResult {
  const input = ApproveTailoredInput.parse(rawInput);
  const now = input.now ?? utcNow();
  return withTransaction(handle.sqlite, () => {
    const job = getJobBoardRow(handle, input.jobId);
    if (job === null) {
      return failure("unknown-job", `job ${input.jobId} does not exist`, {
        to: "TAILORED",
      });
    }
    const planned = planBoardMove(
      { status: job.status, rowVersion: job.rowVersion },
      {
        kind: "approval",
        to: "TAILORED",
        observedRowVersion: input.observedRowVersion,
      },
    );
    if (!planned.ok) {
      return failure(planned.error, planned.detail, {
        from: planned.from,
        to: planned.to,
        currentRowVersion:
          planned.error === "conflict" ? job.rowVersion : undefined,
      });
    }
    if (job.activeResumeVersionId === null) {
      return failure(
        "tailored-binding",
        "job has no active resume version to approve",
        { from: job.status, to: "TAILORED", currentRowVersion: job.rowVersion },
      );
    }
    if (job.activeResumeVersionId !== input.resumeVersionId) {
      return failure(
        "tailored-binding",
        `job's active resume version is ${job.activeResumeVersionId}, not ${input.resumeVersionId}`,
        { from: job.status, to: "TAILORED", currentRowVersion: job.rowVersion },
      );
    }
    const version = handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, input.resumeVersionId))
      .get();
    if (version === undefined || version.jobId !== input.jobId) {
      return failure(
        "tailored-binding",
        "approved resume version does not belong to this job",
        { from: job.status, to: "TAILORED", currentRowVersion: job.rowVersion },
      );
    }
    if (version.reviewState !== "APPROVED") {
      return failure(
        "tailored-binding",
        `resume version is ${version.reviewState}, not APPROVED`,
        { from: job.status, to: "TAILORED", currentRowVersion: job.rowVersion },
      );
    }
    const review = handle.db
      .select()
      .from(resumeReviews)
      .where(
        and(
          eq(resumeReviews.resumeVersionId, input.resumeVersionId),
          eq(resumeReviews.action, "APPROVED"),
          eq(resumeReviews.actor, "human"),
          eq(resumeReviews.contentHash, version.contentHash),
        ),
      )
      .orderBy(desc(resumeReviews.createdAt), desc(resumeReviews.id))
      .limit(1)
      .get();
    if (review === undefined) {
      return failure(
        "tailored-binding",
        "no human APPROVED review binds this version's content hash",
        { from: job.status, to: "TAILORED", currentRowVersion: job.rowVersion },
      );
    }
    // Approval is not a positioning gesture: the card keeps its rank and
    // the user reorders it in TAILORED afterwards. The tailoring flip rides
    // in the same compare-and-swap so the two states can never diverge.
    const updated = casUpdateJobBoard(handle, {
      jobId: input.jobId,
      expectedVersion: input.observedRowVersion,
      status: "TAILORED",
      rank: job.rank,
      tailoringState: "APPROVED",
      tailoringReasonCode: null,
      selectedResumeVersionId: input.resumeVersionId,
      now,
    });
    if (updated === null) {
      return failure(
        "conflict",
        `stale client: observed row_version ${input.observedRowVersion}, current is ${job.rowVersion}`,
        { from: job.status, to: "TAILORED", currentRowVersion: job.rowVersion },
      );
    }
    const eventId = appendWorkflowEvent(handle, {
      jobId: input.jobId,
      actor: "human",
      from: planned.from,
      to: planned.to,
      rank: job.rank,
      rowVersion: planned.newRowVersion,
      reason: "approval",
      metadata: {
        resumeVersionId: input.resumeVersionId,
        reviewId: review.id,
        approvalCase: "move",
      },
      now,
    });
    return {
      ok: true,
      jobId: input.jobId,
      newRowVersion: planned.newRowVersion,
      rank: job.rank,
      eventId,
      resumeVersionId: input.resumeVersionId,
      reviewId: review.id,
    };
  });
}

/** Append one user note. Notes never move the card or bump its version. */
export function addNote(
  handle: DatabaseHandle,
  rawInput: unknown,
): AddNoteResult {
  const input = AddNoteInput.parse(rawInput);
  const now = input.now ?? utcNow();
  return withTransaction(handle.sqlite, () => {
    const job = getJobBoardRow(handle, input.jobId);
    if (job === null) {
      return failure("unknown-job", `job ${input.jobId} does not exist`);
    }
    const note = insertJobNote(handle, {
      jobId: input.jobId,
      body: input.body,
      now,
    });
    return {
      ok: true,
      jobId: input.jobId,
      noteId: note.id,
      createdAt: note.createdAt,
    };
  });
}
