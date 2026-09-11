import { desc, eq } from "drizzle-orm";
// File imports: routes bundle this module into the Next server runtime,
// which resolves like the worker loader (no directory barrels).
import type { DatabaseHandle } from "../db/client";
import { intakeBatches, intakeItems } from "../db/schema/intake";
import {
  jobExtractions,
  jobSources,
  jobs,
  scrapeAttempts,
  sourceArtifacts,
} from "../db/schema/jobs";
import { workAttempts, workItems } from "../db/schema/queue";
import { canonicalizeUrl } from "../scraping/urls";
import { scrapeIdempotencyKey } from "./intake";

/**
 * Read-only views for the intake/attempt UI. Plain synchronous SELECTs;
 * no transactions, no writes, no side effects. Queue linkage re-derives
 * the deterministic idempotency key from the persisted canonical URL
 * (canonical form is a fixpoint, covered by test), because intake rows
 * predate the work rows they cause.
 */

export interface QueueLineState {
  workItemId: string;
  workState: string;
  attemptCount: number;
  maxAttempts: number;
}

export interface BatchItemView {
  id: string;
  lineNumber: number;
  rawInput: string;
  outcome: string;
  reasonCode: string | null;
  canonicalUrl: string | null;
  jobId: string | null;
  queue: QueueLineState | null;
}

export interface BatchView {
  id: string;
  createdAt: string;
  rawLineCount: number;
  enqueuedCount: number;
  duplicateCount: number;
  invalidCount: number;
  blockedCount: number;
  items: BatchItemView[];
}

export interface BatchSummary {
  id: string;
  createdAt: string;
  rawLineCount: number;
  enqueuedCount: number;
  duplicateCount: number;
  invalidCount: number;
  blockedCount: number;
}

export interface WorkAttemptView {
  attemptNumber: number;
  workerId: string | null;
  startedAt: string;
  finishedAt: string | null;
  result: string;
  errorCode: string | null;
  errorDetail: string | null;
}

export interface AttemptJobView {
  id: string;
  status: string;
  scrapeState: string;
  scrapeReasonCode: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  arrangement: string | null;
  salaryText: string | null;
  descriptionText: string | null;
  postedAt: string | null;
  submittedUrl: string | null;
  finalUrl: string | null;
  applyUrl: string | null;
  adapter: string | null;
  confidence: number | null;
  missingFields: string[];
}

export interface AttemptArtifactView {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}

export interface WorkItemView {
  workItem: {
    id: string;
    kind: string;
    state: string;
    attemptCount: number;
    maxAttempts: number;
    nextRunAt: string | null;
    updatedAt: string;
  };
  intakeItem: {
    id: string;
    batchId: string;
    lineNumber: number;
    rawInput: string;
    outcome: string;
    reasonCode: string | null;
    canonicalUrl: string | null;
  } | null;
  attempts: WorkAttemptView[];
  scrapeOutcome: string | null;
  scrapeReasonCode: string | null;
  scrapeDetail: string | null;
  job: AttemptJobView | null;
  artifacts: AttemptArtifactView[];
}

/** Re-derive the work row an intake line caused, if it caused one. */
export function findWorkForCanonicalUrl(
  handle: DatabaseHandle,
  canonicalUrl: string | null,
): QueueLineState | null {
  if (canonicalUrl === null) {
    return null;
  }
  const canonical = canonicalizeUrl(canonicalUrl);
  if (!canonical.ok) {
    return null;
  }
  const row = handle.db
    .select({
      id: workItems.id,
      state: workItems.state,
      attemptCount: workItems.attemptCount,
      maxAttempts: workItems.maxAttempts,
    })
    .from(workItems)
    .where(
      eq(workItems.idempotencyKey, scrapeIdempotencyKey(canonical.value.canonicalKey)),
    )
    .get();
  if (row === undefined) {
    return null;
  }
  return {
    workItemId: row.id,
    workState: row.state,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
  };
}

export function getBatchView(
  handle: DatabaseHandle,
  batchId: string,
): BatchView | null {
  const batch = handle.db
    .select()
    .from(intakeBatches)
    .where(eq(intakeBatches.id, batchId))
    .get();
  if (batch === undefined) {
    return null;
  }
  const rows = handle.db
    .select()
    .from(intakeItems)
    .where(eq(intakeItems.batchId, batchId))
    .orderBy(intakeItems.lineNumber)
    .all();
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    rawLineCount: batch.rawLineCount,
    enqueuedCount: batch.enqueuedCount,
    duplicateCount: batch.duplicateCount,
    invalidCount: batch.invalidCount,
    blockedCount: batch.blockedCount,
    items: rows.map((row) => ({
      id: row.id,
      lineNumber: row.lineNumber,
      rawInput: row.rawInput,
      outcome: row.outcome,
      reasonCode: row.reasonCode,
      canonicalUrl: row.canonicalUrl,
      jobId: row.jobId,
      queue: findWorkForCanonicalUrl(handle, row.canonicalUrl),
    })),
  };
}

export function listBatches(
  handle: DatabaseHandle,
  limit = 20,
): BatchSummary[] {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return handle.db
    .select({
      id: intakeBatches.id,
      createdAt: intakeBatches.createdAt,
      rawLineCount: intakeBatches.rawLineCount,
      enqueuedCount: intakeBatches.enqueuedCount,
      duplicateCount: intakeBatches.duplicateCount,
      invalidCount: intakeBatches.invalidCount,
      blockedCount: intakeBatches.blockedCount,
    })
    .from(intakeBatches)
    .orderBy(desc(intakeBatches.createdAt), desc(intakeBatches.id))
    .limit(bounded)
    .all();
}

export function getWorkItemView(
  handle: DatabaseHandle,
  workItemId: string,
): WorkItemView | null {
  const item = handle.db
    .select()
    .from(workItems)
    .where(eq(workItems.id, workItemId))
    .get();
  if (item === undefined) {
    return null;
  }
  const attempts = handle.db
    .select({
      attemptNumber: workAttempts.attemptNumber,
      workerId: workAttempts.workerId,
      startedAt: workAttempts.startedAt,
      finishedAt: workAttempts.finishedAt,
      result: workAttempts.result,
      errorCode: workAttempts.errorCode,
      errorDetail: workAttempts.errorDetail,
    })
    .from(workAttempts)
    .where(eq(workAttempts.workItemId, workItemId))
    .orderBy(workAttempts.attemptNumber)
    .all();
  const intake =
    item.intakeItemId === null
      ? undefined
      : handle.db
        .select()
        .from(intakeItems)
        .where(eq(intakeItems.id, item.intakeItemId))
        .get();
  // Retries share one intake item; the latest scrape attempt is current.
  const scrape =
    item.intakeItemId === null
      ? undefined
      : handle.db
        .select()
        .from(scrapeAttempts)
        .where(eq(scrapeAttempts.intakeItemId, item.intakeItemId))
        .orderBy(desc(scrapeAttempts.createdAt), desc(scrapeAttempts.id))
        .limit(1)
        .get();
  const job =
    scrape?.jobId === undefined || scrape.jobId === null
      ? undefined
      : handle.db.select().from(jobs).where(eq(jobs.id, scrape.jobId)).get();
  const extraction =
    job?.activeExtractionId === undefined || job.activeExtractionId === null
      ? undefined
      : handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.id, job.activeExtractionId))
        .get();
  const source =
    job === undefined
      ? undefined
      : handle.db
        .select()
        .from(jobSources)
        .where(eq(jobSources.jobId, job.id))
        .get();
  const artifactRows =
    scrape === undefined
      ? []
      : handle.db
        .select({
          id: sourceArtifacts.id,
          kind: sourceArtifacts.kind,
          mediaType: sourceArtifacts.mediaType,
          byteSize: sourceArtifacts.byteSize,
          sha256: sourceArtifacts.sha256,
        })
        .from(sourceArtifacts)
        .where(eq(sourceArtifacts.scrapeAttemptId, scrape.id))
        .orderBy(sourceArtifacts.kind)
        .all();
  let missingFields: string[] = [];
  if (extraction?.missingFieldsJson !== undefined && extraction.missingFieldsJson !== null) {
    try {
      const parsed: unknown = JSON.parse(extraction.missingFieldsJson);
      if (Array.isArray(parsed)) {
        missingFields = parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      missingFields = [];
    }
  }
  return {
    workItem: {
      id: item.id,
      kind: item.kind,
      state: item.state,
      attemptCount: item.attemptCount,
      maxAttempts: item.maxAttempts,
      nextRunAt: item.nextRunAt,
      updatedAt: item.updatedAt,
    },
    intakeItem:
      intake === undefined
        ? null
        : {
          id: intake.id,
          batchId: intake.batchId,
          lineNumber: intake.lineNumber,
          rawInput: intake.rawInput,
          outcome: intake.outcome,
          reasonCode: intake.reasonCode,
          canonicalUrl: intake.canonicalUrl,
        },
    attempts,
    scrapeOutcome: scrape?.outcome ?? null,
    scrapeReasonCode: scrape?.reasonCode ?? null,
    scrapeDetail: scrape?.errorDetail ?? null,
    job:
      job === undefined
        ? null
        : {
          id: job.id,
          status: job.status,
          scrapeState: job.scrapeState,
          scrapeReasonCode: job.scrapeReasonCode,
          title: job.title,
          company: job.company,
          location: job.location,
          arrangement: job.arrangement,
          salaryText: job.salaryText,
          descriptionText: job.descriptionText,
          postedAt: job.postedAt,
          submittedUrl: source?.submittedUrl ?? null,
          finalUrl: source?.finalUrl ?? null,
          applyUrl: source?.applyUrl ?? null,
          adapter: extraction?.adapter ?? null,
          confidence: extraction?.confidence ?? null,
          missingFields,
        },
    artifacts: artifactRows,
  };
}

export function getArtifact(
  handle: DatabaseHandle,
  artifactId: string,
): {
  id: string;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
} | null {
  const row = handle.db
    .select({
      id: sourceArtifacts.id,
      relativePath: sourceArtifacts.relativePath,
      mediaType: sourceArtifacts.mediaType,
      byteSize: sourceArtifacts.byteSize,
      sha256: sourceArtifacts.sha256,
    })
    .from(sourceArtifacts)
    .where(eq(sourceArtifacts.id, artifactId))
    .get();
  return row ?? null;
}
