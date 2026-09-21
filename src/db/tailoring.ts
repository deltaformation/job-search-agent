import { and, desc, eq, sql } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import { workAttempts, workItems } from "./schema/queue";
import { withTransaction } from "./transactions";
import { newId, utcNow } from "./utils";
import { candidateSnapshots, type CandidateSnapshot } from "./schema/candidates";
import { jdSnapshots, jobAnalyses, type JdSnapshot, type JobAnalysis } from "./schema/analysis";
import { jobs } from "./schema/jobs";
import {
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeVersions,
  type ResumeArtifact,
  type ResumeClaim,
  type ResumeVersion,
} from "./schema/resumes";

/**
 * Row access for tailoring persistence. Single-statement helpers; the
 * caller composes them into short transactions (see
 * `src/tailoring/persist.ts`). State-machine and fencing decisions stay
 * out of this module. The salary backfill is the one exception: its
 * read-check-write must be atomic, so it owns its short transaction.
 */

export interface TailoringJobRow {
  id: string;
  status: string;
  rowVersion: number;
  title: string | null;
  company: string | null;
  descriptionText: string | null;
  tailoringState: string;
  tailoringReasonCode: string | null;
  activeExtractionId: string | null;
  activeResumeVersionId: string | null;
  selectedResumeVersionId: string | null;
}

export function getTailoringJob(handle: DatabaseHandle, jobId: string): TailoringJobRow | null {
  const row = handle.db
    .select({
      id: jobs.id,
      status: jobs.status,
      rowVersion: jobs.rowVersion,
      title: jobs.title,
      company: jobs.company,
      descriptionText: jobs.descriptionText,
      tailoringState: jobs.tailoringState,
      tailoringReasonCode: jobs.tailoringReasonCode,
      activeExtractionId: jobs.activeExtractionId,
      activeResumeVersionId: jobs.activeResumeVersionId,
      selectedResumeVersionId: jobs.selectedResumeVersionId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return row ?? null;
}

export function getCandidateSnapshotById(
  handle: DatabaseHandle,
  snapshotId: string,
): CandidateSnapshot | null {
  const row = handle.db
    .select()
    .from(candidateSnapshots)
    .where(eq(candidateSnapshots.id, snapshotId))
    .get();
  return row ?? null;
}

export function getJdSnapshotById(
  handle: DatabaseHandle,
  snapshotId: string,
): JdSnapshot | null {
  const row = handle.db.select().from(jdSnapshots).where(eq(jdSnapshots.id, snapshotId)).get();
  return row ?? null;
}

export interface LatestAnalysisDoc {
  requirementsJson: string;
  gapsJson: string;
}

/**
 * Latest analysis documents for a job (insertion order), or null when the
 * job was never analyzed. Powers the drawer's Top-5 keyword chips.
 */
export function getLatestAnalysisForJob(
  handle: DatabaseHandle,
  jobId: string,
): LatestAnalysisDoc | null {
  const row = handle.db
    .select({ requirementsJson: jobAnalyses.requirementsJson, gapsJson: jobAnalyses.gapsJson })
    .from(jobAnalyses)
    .where(eq(jobAnalyses.jobId, jobId))
    .orderBy(desc(jobAnalyses.createdAt), desc(jobAnalyses.id))
    .get();
  return row ?? null;
}

export function getAnalysisById(handle: DatabaseHandle, analysisId: string): JobAnalysis | null {
  const row = handle.db
    .select()
    .from(jobAnalyses)
    .where(eq(jobAnalyses.id, analysisId))
    .get();
  return row ?? null;
}

/** The one analysis a generation request produced, if it published already. */
export function getAnalysisByRequest(
  handle: DatabaseHandle,
  requestId: string,
): JobAnalysis | null {
  const row = handle.db
    .select()
    .from(jobAnalyses)
    .where(eq(jobAnalyses.generationRequestId, requestId))
    .get();
  return row ?? null;
}

export function insertAnalysis(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    jdSnapshotId: string;
    candidateSnapshotId: string;
    requirementsJson: string;
    gapsJson: string;
    provider: string | null;
    model: string | null;
    promptVersion: string;
    proposalSchemaVersion: string;
    inputHash: string | null;
    proposalHash: string | null;
    rationale: string | null;
    attemptJson: string | null;
    generationRequestId: string;
    workAttemptId: string;
  },
): JobAnalysis {
  const id = newId();
  handle.db.insert(jobAnalyses).values({ id, ...input }).run();
  const row = getAnalysisById(handle, id);
  if (row === null) {
    throw new Error("inserted analysis is not readable");
  }
  return row;
}

export interface LatestResumeVersion {
  id: string;
  version: number;
}

/** Latest version number for a job (max + 1 belongs to the caller's transaction). */
export function getLatestResumeVersion(
  handle: DatabaseHandle,
  jobId: string,
): LatestResumeVersion | null {
  const row = handle.db
    .select({ id: resumeVersions.id, version: resumeVersions.version })
    .from(resumeVersions)
    .where(eq(resumeVersions.jobId, jobId))
    .orderBy(sql`${resumeVersions.version} DESC`)
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Content-hash dedupe lookup: an identical version lets reruns converge.
 * The caller also needs the target's review state — converging onto a
 * terminally reviewed version would strand the job, so dedupe only
 * applies to live (AWAITING_REVIEW) targets.
 */
export function getResumeVersionByContentHash(
  handle: DatabaseHandle,
  jobId: string,
  contentHash: string,
): (LatestResumeVersion & { reviewState: string }) | null {
  const row = handle.db
    .select({
      id: resumeVersions.id,
      version: resumeVersions.version,
      reviewState: resumeVersions.reviewState,
    })
    .from(resumeVersions)
    .where(and(eq(resumeVersions.jobId, jobId), eq(resumeVersions.contentHash, contentHash)))
    .get();
  return row ?? null;
}

export function insertResumeVersion(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    version: number;
    parentVersionId: string | null;
    analysisId: string;
    templateId: string;
    templateVersion: string;
    templateHash: string;
    rankerVersion: string;
    policyVersion: string;
    configVersion: string;
    renderSchemaVersion: string;
    contentJson: string;
    contentHash: string;
    reviewState: string;
    generationRequestId: string;
    workAttemptId: string;
  },
): ResumeVersion {
  const id = newId();
  handle.db.insert(resumeVersions).values({ id, ...input }).run();
  const row = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, id))
    .get();
  if (row === undefined) {
    throw new Error("inserted resume version is not readable");
  }
  return row;
}

export function insertResumeClaim(
  handle: DatabaseHandle,
  input: {
    resumeVersionId: string;
    claimText: string;
    requirementRef: string | null;
    derivationKind: string | null;
    derivationPayload: string | null;
  },
): ResumeClaim {
  const id = newId();
  handle.db.insert(resumeClaims).values({ id, ...input }).run();
  const row = handle.db.select().from(resumeClaims).where(eq(resumeClaims.id, id)).get();
  if (row === undefined) {
    throw new Error("inserted resume claim is not readable");
  }
  return row;
}

export function insertResumeClaimFact(
  handle: DatabaseHandle,
  input: { claimId: string; factId: string },
): void {
  handle.db.insert(resumeClaimFacts).values(input).run();
}

export function insertResumeArtifact(
  handle: DatabaseHandle,
  input: {
    resumeVersionId: string;
    kind: string;
    relativePath: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  },
): ResumeArtifact {
  const id = newId();
  handle.db.insert(resumeArtifacts).values({ id, ...input }).run();
  const row = handle.db.select().from(resumeArtifacts).where(eq(resumeArtifacts.id, id)).get();
  if (row === undefined) {
    throw new Error("inserted resume artifact is not readable");
  }
  return row;
}

export function getWorkItemByIdempotencyKey(
  handle: DatabaseHandle,
  idempotencyKey: string,
): { id: string } | null {
  const row = handle.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.idempotencyKey, idempotencyKey))
    .get();
  return row ?? null;
}

export interface JobSalaryState {
  title: string | null;
  company: string | null;
  location: string | null;
  descriptionText: string | null;
  salaryText: string | null;
  activeExtractionId: string | null;
}

/**
 * Live salary inputs for the R4-G Step-2 fallback: one row read. The
 * caller double-checks `activeExtractionId` against the run's bound
 * extraction before and inside the backfill write, so a superseding
 * scrape can never receive another extraction's salary.
 */
export function getJobSalaryState(handle: DatabaseHandle, jobId: string): JobSalaryState | null {
  const row = handle.db
    .select({
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      descriptionText: jobs.descriptionText,
      salaryText: jobs.salaryText,
      activeExtractionId: jobs.activeExtractionId,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return row ?? null;
}

export interface SalaryBackfillWrite {
  salaryText: string | null;
  currency: string | null;
  salaryMinMinor: number | null;
  salaryMaxMinor: number | null;
  compensationHighlights: string[];
}

export type SalaryBackfillOutcome =
  | "written"
  | "skipped-missing-job"
  | "skipped-drift"
  | "skipped-present"
  | "skipped-empty";

/**
 * Conditional salary backfill in one short transaction. Writes only when
 * the run's extraction is still the job's active one and no salary text
 * landed meanwhile (a concurrent scrape or an earlier backfill wins).
 * Highlights overwrite only when the facts carry some; a highlight-less
 * result preserves whatever is stored. Never bumps `row_version`:
 * disjoint columns, invisible to board moves and the tailor fence.
 */
export function writeJobSalaryBackfill(
  handle: DatabaseHandle,
  input: { jobId: string; extractionId: string; facts: SalaryBackfillWrite },
): SalaryBackfillOutcome {
  const { jobId, extractionId, facts } = input;
  return withTransaction(handle.sqlite, () => {
    const current = handle.db
      .select({
        activeExtractionId: jobs.activeExtractionId,
        salaryText: jobs.salaryText,
        compensationHighlightsJson: jobs.compensationHighlightsJson,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (current === undefined) {
      return "skipped-missing-job" as const;
    }
    if (current.activeExtractionId !== extractionId) {
      return "skipped-drift" as const;
    }
    if (current.salaryText !== null && current.salaryText.trim() !== "") {
      return "skipped-present" as const;
    }
    if (facts.salaryText === null && facts.compensationHighlights.length === 0) {
      return "skipped-empty" as const;
    }
    const changed = handle.db
      .update(jobs)
      .set({
        salaryText: facts.salaryText,
        salaryCurrency: facts.currency,
        salaryMinMinor: facts.salaryMinMinor,
        salaryMaxMinor: facts.salaryMaxMinor,
        compensationHighlightsJson:
          facts.compensationHighlights.length > 0
            ? JSON.stringify(facts.compensationHighlights)
            : current.compensationHighlightsJson,
        updatedAt: utcNow(),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.activeExtractionId, extractionId)))
      .run().changes;
    return changed === 1 ? ("written" as const) : ("skipped-drift" as const);
  });
}

export interface LatestTailorWorkItem {
  id: string;
  state: string;
  createdAt: string;
}

/**
 * Most recent TAILOR queue item for a job (insertion order), or null
 * when tailoring was never enqueued. The retry command keys off this
 * row: FAILED items requeue, live items no-op, successes stay final.
 */
export function getLatestTailorWorkItem(
  handle: DatabaseHandle,
  jobId: string,
): LatestTailorWorkItem | null {
  const row = handle.db
    .select({ id: workItems.id, state: workItems.state, createdAt: workItems.createdAt })
    .from(workItems)
    .where(and(eq(workItems.jobId, jobId), eq(workItems.kind, "TAILOR")))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
    .get();
  return row ?? null;
}

/** One TAILOR queue item's state by id, or null when unknown. */
export function getTailorWorkItemState(
  handle: DatabaseHandle,
  workItemId: string,
): string | null {
  const row = handle.db
    .select({ state: workItems.state })
    .from(workItems)
    .where(and(eq(workItems.id, workItemId), eq(workItems.kind, "TAILOR")))
    .get();
  return row?.state ?? null;
}

export interface LatestTailorAttempt {
  workItemId: string;
  attemptNumber: number;
  result: string;
  errorCode: string | null;
  errorDetail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Most recent attempt across a job's TAILOR items, or null when no
 * attempt was ever recorded (e.g. a queued item no worker claimed yet).
 * Powers the drawer's actionable tailoring-error card.
 */
export function getLatestTailorAttempt(
  handle: DatabaseHandle,
  jobId: string,
): LatestTailorAttempt | null {
  const row = handle.db
    .select({
      workItemId: workAttempts.workItemId,
      attemptNumber: workAttempts.attemptNumber,
      result: workAttempts.result,
      errorCode: workAttempts.errorCode,
      errorDetail: workAttempts.errorDetail,
      startedAt: workAttempts.startedAt,
      finishedAt: workAttempts.finishedAt,
    })
    .from(workAttempts)
    .innerJoin(workItems, eq(workAttempts.workItemId, workItems.id))
    .where(and(eq(workItems.jobId, jobId), eq(workItems.kind, "TAILOR")))
    .orderBy(desc(workAttempts.startedAt), desc(workAttempts.attemptNumber))
    .get();
  return row ?? null;
}

export function insertTailorWorkItem(
  handle: DatabaseHandle,
  input: { idempotencyKey: string; jobId: string; payloadJson: string; maxAttempts: number },
): string {
  const id = newId();
  handle.db
    .insert(workItems)
    .values({
      id,
      kind: "TAILOR",
      idempotencyKey: input.idempotencyKey,
      jobId: input.jobId,
      intakeItemId: null,
      payloadJson: input.payloadJson,
      maxAttempts: input.maxAttempts,
    })
    .onConflictDoNothing({ target: workItems.idempotencyKey })
    .run();
  return id;
}

/**
 * Compare-and-swap tailoring state: updates only when the row still
 * carries the observed version, so a concurrent board move fences the
 * write instead of being silently overwritten. Bumps `row_version` like
 * board moves so the two writers fence each other.
 */
/**
 * Compare-and-swap the job row version without touching board or
 * tailoring state (WO-1.3-S2-B): preparation commands bump the
 * version so concurrent reviewers observe the change while the
 * card stays exactly where it is.
 */
export function casJobRowVersion(
  handle: DatabaseHandle,
  input: { jobId: string; rowVersion: number; now: string },
): boolean {
  const changed = handle.db
    .update(jobs)
    .set({ rowVersion: sql`${jobs.rowVersion} + 1`, updatedAt: input.now })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.rowVersion, input.rowVersion)))
    .run().changes;
  return changed === 1;
}

export function casJobTailoringState(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    rowVersion: number;
    tailoringState: string;
    reasonCode: string | null;
    activeResumeVersionId?: string | null;
    selectedResumeVersionId?: string | null;
    now: string;
  },
): boolean {
  const changed = handle.db
    .update(jobs)
    .set({
      tailoringState: input.tailoringState,
      tailoringReasonCode: input.reasonCode,
      ...(input.activeResumeVersionId === undefined
        ? {}
        : { activeResumeVersionId: input.activeResumeVersionId }),
      ...(input.selectedResumeVersionId === undefined
        ? {}
        : { selectedResumeVersionId: input.selectedResumeVersionId }),
      rowVersion: sql`${jobs.rowVersion} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.rowVersion, input.rowVersion)))
    .run().changes;
  return changed === 1;
}
