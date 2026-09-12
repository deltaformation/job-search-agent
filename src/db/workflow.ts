import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { BoardStatus } from "../domain/enums";
import {
  WORKFLOW_EVENT_METADATA_VERSION,
  WorkflowEventMetadataV1,
  type WorkflowEventReason,
} from "../domain/workflow";
import type { DatabaseHandle } from "./client";
import {
  applications,
  jobNotes,
  jobs,
  scrapeAttempts,
  workItems,
  workflowEvents,
} from "./schema";
import { newId } from "./utils";

/**
 * Workflow and application repositories: thin synchronous row operations for
 * board state, audit events, user notes, and human-recorded applications.
 * Transaction-agnostic — callers (the R3-A command service) own the
 * compare-and-swap transaction via `withTransaction`.
 */

export interface JobBoardRow {
  id: string;
  status: BoardStatus;
  rank: number;
  rowVersion: number;
  activeResumeVersionId: string | null;
}

export function getJobBoardRow(
  handle: DatabaseHandle,
  jobId: string,
): JobBoardRow | null {
  const row = handle.db
    .select({
      id: jobs.id,
      status: jobs.status,
      rank: jobs.rank,
      rowVersion: jobs.rowVersion,
      activeResumeVersionId: jobs.activeResumeVersionId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (row === undefined) {
    return null;
  }
  return { ...row, status: row.status as BoardStatus };
}

export interface CasUpdateJobBoardInput {
  jobId: string;
  expectedVersion: number;
  status: BoardStatus;
  rank: number;
  now: string;
  /**
   * Optional tailoring columns for the R4-F approval transaction: the
   * board move to TAILORED and the tailoring flip to APPROVED must land
   * in one compare-and-swap so concurrent writers fence each other.
   * Omitted by ordinary moves, which never touch tailoring state.
   */
  tailoringState?: string;
  tailoringReasonCode?: string | null;
}

/**
 * Compare-and-swap the board columns. Returns the updated row, or null when
 * the version moved underneath the caller (the caller pre-checked existence
 * in the same transaction, so null always means conflict, never unknown job).
 */
export function casUpdateJobBoard(
  handle: DatabaseHandle,
  input: CasUpdateJobBoardInput,
): JobBoardRow | null {
  handle.db
    .update(jobs)
    .set({
      status: input.status,
      rank: input.rank,
      rowVersion: input.expectedVersion + 1,
      updatedAt: input.now,
      ...(input.tailoringState === undefined
        ? {}
        : {
          tailoringState: input.tailoringState,
          tailoringReasonCode: input.tailoringReasonCode ?? null,
        }),
    })
    .where(
      and(eq(jobs.id, input.jobId), eq(jobs.rowVersion, input.expectedVersion)),
    )
    .run();
  const row = handle.db
    .select({
      id: jobs.id,
      status: jobs.status,
      rank: jobs.rank,
      rowVersion: jobs.rowVersion,
      activeResumeVersionId: jobs.activeResumeVersionId,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.rowVersion, input.expectedVersion + 1),
      ),
    )
    .get();
  if (row === undefined) {
    return null;
  }
  return { ...row, status: row.status as BoardStatus };
}

/** Highest rank in a column, or null when the column is empty. */
export function maxRankInColumn(
  handle: DatabaseHandle,
  status: BoardStatus,
): number | null {
  const row = handle.db
    .select({ maxRank: sql<number | null>`max(${jobs.rank})` })
    .from(jobs)
    .where(eq(jobs.status, status))
    .get();
  return row?.maxRank ?? null;
}

export type WorkflowEventMetadataInput = Omit<
  WorkflowEventMetadataV1,
  "schemaVersion"
>;

export interface AppendWorkflowEventInput {
  jobId: string;
  actor: string;
  from: BoardStatus | null;
  to: BoardStatus;
  rank: number;
  rowVersion: number;
  reason: WorkflowEventReason;
  metadata: WorkflowEventMetadataInput | null;
  now: string;
}

/** Append one audit event; metadata is schema-validated before it is stored. */
export function appendWorkflowEvent(
  handle: DatabaseHandle,
  input: AppendWorkflowEventInput,
): string {
  const id = newId();
  const metadataJson =
    input.metadata === null
      ? null
      : JSON.stringify(
          WorkflowEventMetadataV1.parse({
            ...input.metadata,
            schemaVersion: WORKFLOW_EVENT_METADATA_VERSION,
          }),
        );
  handle.db
    .insert(workflowEvents)
    .values({
      id,
      jobId: input.jobId,
      actor: input.actor,
      fromStatus: input.from,
      toStatus: input.to,
      rank: input.rank,
      rowVersion: input.rowVersion,
      reason: input.reason,
      metadataJson,
      createdAt: input.now,
    })
    .run();
  return id;
}

export interface InsertJobNoteResult {
  id: string;
  createdAt: string;
}

export function insertJobNote(
  handle: DatabaseHandle,
  input: { jobId: string; body: string; now: string },
): InsertJobNoteResult {
  const id = newId();
  handle.db
    .insert(jobNotes)
    .values({ id, jobId: input.jobId, body: input.body, createdAt: input.now })
    .run();
  return { id, createdAt: input.now };
}

export interface ApplicationRow {
  id: string;
  jobId: string;
  recordedBy: string;
  appliedAt: string;
  confirmationNumber: string | null;
}

export function getApplication(
  handle: DatabaseHandle,
  jobId: string,
): ApplicationRow | null {
  const row = handle.db
    .select({
      id: applications.id,
      jobId: applications.jobId,
      recordedBy: applications.recordedBy,
      appliedAt: applications.appliedAt,
      confirmationNumber: applications.confirmationNumber,
    })
    .from(applications)
    .where(eq(applications.jobId, jobId))
    .get();
  return row ?? null;
}

export interface UpsertApplicationResult {
  id: string;
  created: boolean;
}

/**
 * Record (or re-record) a human application. One row per job: re-entering
 * APPLIED updates the timestamp/confirmation, so the table always holds the
 * latest human record while the event log keeps every entry.
 */
export function upsertApplication(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    appliedAt: string;
    confirmationNumber: string | null;
    now: string;
  },
): UpsertApplicationResult {
  const existing = getApplication(handle, input.jobId);
  if (existing !== null) {
    handle.db
      .update(applications)
      .set({
        appliedAt: input.appliedAt,
        confirmationNumber: input.confirmationNumber,
        updatedAt: input.now,
      })
      .where(eq(applications.jobId, input.jobId))
      .run();
    return { id: existing.id, created: false };
  }
  const id = newId();
  handle.db
    .insert(applications)
    .values({
      id,
      jobId: input.jobId,
      recordedBy: "human",
      appliedAt: input.appliedAt,
      confirmationNumber: input.confirmationNumber,
      createdAt: input.now,
    })
    .run();
  return { id, created: true };
}

/**
 * Cancel a job's QUEUED work when it is rejected: directly job-linked items
 * plus requeued scrapes reachable through the intake items the job was
 * fetched from. RUNNING items are never yanked — their leases stay valid and
 * completion-side fencing (an R4-E follow-up) decides their output.
 */
export function cancelQueuedWorkForJob(
  handle: DatabaseHandle,
  input: { jobId: string; now: string },
): string[] {
  const linkedIntakeItems = handle.db
    .select({ intakeItemId: scrapeAttempts.intakeItemId })
    .from(scrapeAttempts)
    .where(eq(scrapeAttempts.jobId, input.jobId));
  const cancelled = handle.db
    .update(workItems)
    .set({ state: "CANCELLED", nextRunAt: null, updatedAt: input.now })
    .where(
      and(
        eq(workItems.state, "QUEUED"),
        or(
          eq(workItems.jobId, input.jobId),
          inArray(workItems.intakeItemId, linkedIntakeItems),
        ),
      ),
    )
    .returning({ id: workItems.id })
    .all();
  return cancelled.map((row) => row.id);
}
