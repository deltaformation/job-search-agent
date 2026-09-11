import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
// File imports: routes bundle this module into the Next server runtime,
// which resolves like the worker loader (no directory barrels).
import type { DatabaseHandle } from "../db/client";
import { applications, jobNotes, workflowEvents } from "../db/schema/workflow";
import { intakeItems } from "../db/schema/intake";
import {
  jobExtractions,
  jobSources,
  jobs,
  scrapeAttempts,
  sourceArtifacts,
} from "../db/schema/jobs";
import {
  resumeArtifacts,
  resumeReviews,
  resumeVersions,
} from "../db/schema/resumes";
import type { BoardStatus } from "../domain/enums";
import {
  parseWorkflowEventMetadata,
  type WorkflowEventMetadataV1,
} from "../domain/workflow";

/**
 * Board and card-detail read models. Plain synchronous SELECTs; no
 * transactions, no writes, no side effects.
 *
 * Safety contract: these views never serialize filesystem paths (artifacts
 * resolve by id through `/api/evidence`), validate every URL as http(s)
 * before inclusion, and fail soft (null) on unparseable stored JSON so one
 * corrupt row cannot 500 the whole board. Text fields (titles, notes,
 * descriptions) travel as raw strings — consumers must escape on render
 * (React does by default); the API transforms nothing.
 */

export const BOARD_STATUSES: readonly BoardStatus[] = [
  "NEW",
  "TAILORED",
  "APPLIED",
  "INTERVIEWED",
  "REJECTED",
];

export type BoardSort = "rank" | "updated" | "created";

export const DEFAULT_BOARD_LIMIT = 50;
export const MAX_BOARD_LIMIT = 200;

/** Null unless the value is an absolute http(s) URL. */
export function safeHttpUrl(value: string | null): string | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** Escape user search text so % and _ match literally, never as wildcards. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface BoardCardView {
  id: string;
  status: BoardStatus;
  rank: number;
  /** Observed version for R3-A compare-and-swap moves. */
  rowVersion: number;
  title: string | null;
  company: string | null;
  location: string | null;
  arrangement: string | null;
  salaryText: string | null;
  scrapeState: string;
  scrapeReasonCode: string | null;
  tailoringState: string;
  tailoringReasonCode: string | null;
  resume: {
    versionId: string;
    version: number;
    reviewState: string;
  } | null;
  notesCount: number;
  /** Validated posting URL for the "open original" action. */
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardColumnView {
  status: BoardStatus;
  total: number;
  cards: BoardCardView[];
}

export interface BoardView {
  columns: BoardColumnView[];
}

export interface BoardQuery {
  q?: string;
  sort?: BoardSort;
  limit?: number;
  offset?: number;
}

function boardOrder(sort: BoardSort) {
  if (sort === "updated") {
    return [desc(jobs.updatedAt), desc(jobs.id)] as const;
  }
  if (sort === "created") {
    return [desc(jobs.createdAt), desc(jobs.id)] as const;
  }
  return [asc(jobs.rank), asc(jobs.createdAt), asc(jobs.id)] as const;
}

function searchFilter(q: string | undefined) {
  if (q === undefined || q.trim() === "") {
    return undefined;
  }
  const pattern = `%${escapeLikePattern(q.trim())}%`;
  const match = (
    column: typeof jobs.title | typeof jobs.company | typeof jobs.location,
  ) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
  return or(match(jobs.title), match(jobs.company), match(jobs.location));
}

/**
 * Five-column board projection. Every column always appears (empty ones
 * carry `total: 0`); search/pagination apply per column so column totals
 * stay meaningful under load-more.
 */
export function getBoardView(
  handle: DatabaseHandle,
  query: BoardQuery = {},
): BoardView {
  const sort: BoardSort = query.sort ?? "rank";
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? DEFAULT_BOARD_LIMIT), 1),
    MAX_BOARD_LIMIT,
  );
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const filter = searchFilter(query.q);
  const order = boardOrder(sort);

  const columns: BoardColumnView[] = BOARD_STATUSES.map((status) => {
    const where = filter === undefined
      ? eq(jobs.status, status)
      : and(eq(jobs.status, status), filter);
    const totalRow = handle.db
      .select({ total: sql<number>`count(*)` })
      .from(jobs)
      .where(where)
      .get();
    const rows = handle.db
      .select({
        id: jobs.id,
        status: jobs.status,
        rank: jobs.rank,
        rowVersion: jobs.rowVersion,
        title: jobs.title,
        company: jobs.company,
        location: jobs.location,
        arrangement: jobs.arrangement,
        salaryText: jobs.salaryText,
        scrapeState: jobs.scrapeState,
        scrapeReasonCode: jobs.scrapeReasonCode,
        tailoringState: jobs.tailoringState,
        tailoringReasonCode: jobs.tailoringReasonCode,
        activeResumeVersionId: jobs.activeResumeVersionId,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
        submittedUrl: jobSources.submittedUrl,
      })
      .from(jobs)
      .leftJoin(jobSources, eq(jobSources.jobId, jobs.id))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset)
      .all();

    const cards: BoardCardView[] = rows.map((row) => {
      const resumeVersion =
        row.activeResumeVersionId === null
          ? undefined
          : handle.db
            .select({
              id: resumeVersions.id,
              version: resumeVersions.version,
              reviewState: resumeVersions.reviewState,
            })
            .from(resumeVersions)
            .where(eq(resumeVersions.id, row.activeResumeVersionId))
            .get();
      const notesRow = handle.db
        .select({ total: sql<number>`count(*)` })
        .from(jobNotes)
        .where(eq(jobNotes.jobId, row.id))
        .get();
      return {
        id: row.id,
        status: row.status as BoardStatus,
        rank: row.rank,
        rowVersion: row.rowVersion,
        title: row.title,
        company: row.company,
        location: row.location,
        arrangement: row.arrangement,
        salaryText: row.salaryText,
        scrapeState: row.scrapeState,
        scrapeReasonCode: row.scrapeReasonCode,
        tailoringState: row.tailoringState,
        tailoringReasonCode: row.tailoringReasonCode,
        resume:
          resumeVersion === undefined
            ? null
            : {
              versionId: resumeVersion.id,
              version: resumeVersion.version,
              reviewState: resumeVersion.reviewState,
            },
        notesCount: notesRow?.total ?? 0,
        sourceUrl: safeHttpUrl(row.submittedUrl),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
    return { status, total: totalRow?.total ?? 0, cards };
  });
  return { columns };
}

export interface CardSourceView {
  submittedUrl: string | null;
  canonicalUrl: string | null;
  finalUrl: string | null;
  applyUrl: string | null;
  sourceIdentity: string | null;
}

export interface ScrapeAttemptView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  reasonCode: string | null;
  errorDetail: string | null;
  workerId: string | null;
  adapter: string | null;
  createdAt: string;
}

export interface SourceArtifactView {
  id: string;
  attemptId: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}

export interface ExtractionView {
  id: string;
  adapter: string;
  adapterVersion: string | null;
  confidence: number | null;
  missingFields: string[];
  contentHash: string | null;
  fields: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
}

export interface ResumeArtifactRef {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}

export interface ResumeReviewView {
  id: string;
  action: string;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface ResumeVersionView {
  id: string;
  version: number;
  parentVersionId: string | null;
  reviewState: string;
  contentHash: string;
  createdAt: string;
  artifacts: ResumeArtifactRef[];
  reviews: ResumeReviewView[];
}

export interface JobNoteView {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationView {
  appliedAt: string;
  confirmationNumber: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface WorkflowEventView {
  id: string;
  actor: string;
  fromStatus: string | null;
  toStatus: string;
  rank: number | null;
  rowVersion: number;
  reason: string | null;
  metadata: WorkflowEventMetadataV1 | null;
  createdAt: string;
}

export interface CardIntakeView {
  batchId: string;
  lineNumber: number;
  rawInput: string;
}

export interface JobDetailView {
  job: {
    id: string;
    status: BoardStatus;
    rank: number;
    rowVersion: number;
    title: string | null;
    company: string | null;
    location: string | null;
    arrangement: string | null;
    salaryText: string | null;
    salaryCurrency: string | null;
    salaryMinMinor: number | null;
    salaryMaxMinor: number | null;
    descriptionText: string | null;
    postedAt: string | null;
    scrapeState: string;
    scrapeReasonCode: string | null;
    tailoringState: string;
    tailoringReasonCode: string | null;
    activeExtractionId: string | null;
    activeResumeVersionId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  source: CardSourceView | null;
  attempts: ScrapeAttemptView[];
  /** Evidence across all attempts; bytes resolve by id via /api/evidence. */
  artifacts: SourceArtifactView[];
  extraction: ExtractionView | null;
  resumes: ResumeVersionView[];
  notes: JobNoteView[];
  application: ApplicationView | null;
  history: WorkflowEventView[];
  intake: CardIntakeView | null;
}

/** Complete card detail, or null for unknown jobs. */
export function getJobDetail(
  handle: DatabaseHandle,
  jobId: string,
): JobDetailView | null {
  const job = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (job === undefined) {
    return null;
  }
  const source = handle.db
    .select()
    .from(jobSources)
    .where(eq(jobSources.jobId, jobId))
    .get();
  const attempts = handle.db
    .select()
    .from(scrapeAttempts)
    .where(eq(scrapeAttempts.jobId, jobId))
    .orderBy(asc(scrapeAttempts.createdAt), asc(scrapeAttempts.id))
    .all();
  const attemptIds = attempts.map((attempt) => attempt.id);
  const artifacts =
    attemptIds.length === 0
      ? []
      : handle.db
        .select({
          id: sourceArtifacts.id,
          attemptId: sourceArtifacts.scrapeAttemptId,
          kind: sourceArtifacts.kind,
          mediaType: sourceArtifacts.mediaType,
          byteSize: sourceArtifacts.byteSize,
          sha256: sourceArtifacts.sha256,
        })
        .from(sourceArtifacts)
        .where(inArray(sourceArtifacts.scrapeAttemptId, attemptIds))
        .orderBy(sourceArtifacts.kind)
        .all();
  const extraction =
    job.activeExtractionId === null
      ? undefined
      : handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.id, job.activeExtractionId))
        .get();
  const versions = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.jobId, jobId))
    .orderBy(asc(resumeVersions.version))
    .all();
  const notes = handle.db
    .select()
    .from(jobNotes)
    .where(eq(jobNotes.jobId, jobId))
    .orderBy(asc(jobNotes.createdAt), asc(jobNotes.id))
    .all();
  const application = handle.db
    .select()
    .from(applications)
    .where(eq(applications.jobId, jobId))
    .get();
  const events = handle.db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.jobId, jobId))
    // rowVersion is the per-job event sequence: every accepted transition
    // bumps it exactly once, so this is the true chain order even when two
    // events share a millisecond timestamp.
    .orderBy(asc(workflowEvents.rowVersion), asc(workflowEvents.id))
    .all();
  const latestAttempt = attempts.length === 0 ? null : attempts[attempts.length - 1];
  const intakeItem =
    latestAttempt?.intakeItemId === null ||
    latestAttempt?.intakeItemId === undefined
      ? undefined
      : handle.db
        .select()
        .from(intakeItems)
        .where(eq(intakeItems.id, latestAttempt.intakeItemId))
        .get();

  const extracted =
    extraction === undefined ? null : parseJsonObject(extraction.extractedJson);

  return {
    job: {
      id: job.id,
      status: job.status as BoardStatus,
      rank: job.rank,
      rowVersion: job.rowVersion,
      title: job.title,
      company: job.company,
      location: job.location,
      arrangement: job.arrangement,
      salaryText: job.salaryText,
      salaryCurrency: job.salaryCurrency,
      salaryMinMinor: job.salaryMinMinor,
      salaryMaxMinor: job.salaryMaxMinor,
      descriptionText: job.descriptionText,
      postedAt: job.postedAt,
      scrapeState: job.scrapeState,
      scrapeReasonCode: job.scrapeReasonCode,
      tailoringState: job.tailoringState,
      tailoringReasonCode: job.tailoringReasonCode,
      activeExtractionId: job.activeExtractionId,
      activeResumeVersionId: job.activeResumeVersionId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    source:
      source === undefined
        ? null
        : {
          submittedUrl: safeHttpUrl(source.submittedUrl),
          canonicalUrl: safeHttpUrl(source.canonicalUrl),
          finalUrl: safeHttpUrl(source.finalUrl),
          applyUrl: safeHttpUrl(source.applyUrl),
          sourceIdentity: source.sourceIdentity,
        },
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      outcome: attempt.outcome,
      reasonCode: attempt.reasonCode,
      errorDetail: attempt.errorDetail,
      workerId: attempt.workerId,
      adapter: attempt.adapter,
      createdAt: attempt.createdAt,
    })),
    artifacts,
    extraction:
      extraction === undefined
        ? null
        : {
          id: extraction.id,
          adapter: extraction.adapter,
          adapterVersion: extraction.adapterVersion,
          confidence: extraction.confidence,
          missingFields: parseStringArray(extraction.missingFieldsJson),
          contentHash:
            typeof extracted?.contentHash === "string" ? extracted.contentHash : null,
          fields:
            extracted !== null &&
            typeof extracted.fields === "object" &&
            extracted.fields !== null &&
            !Array.isArray(extracted.fields)
              ? (extracted.fields as Record<string, unknown>)
              : null,
          provenance:
            extracted !== null &&
            typeof extracted.provenance === "object" &&
            extracted.provenance !== null &&
            !Array.isArray(extracted.provenance)
              ? (extracted.provenance as Record<string, unknown>)
              : null,
        },
    resumes: versions.map((version) => {
      const versionArtifacts = handle.db
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
      return {
        id: version.id,
        version: version.version,
        parentVersionId: version.parentVersionId,
        reviewState: version.reviewState,
        contentHash: version.contentHash,
        createdAt: version.createdAt,
        artifacts: versionArtifacts,
        reviews,
      };
    }),
    notes: notes.map((note) => ({
      id: note.id,
      body: note.body,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })),
    application:
      application === undefined
        ? null
        : {
          appliedAt: application.appliedAt,
          confirmationNumber: application.confirmationNumber,
          recordedBy: application.recordedBy,
          createdAt: application.createdAt,
        },
    history: events.map((event) => {
      let metadata: WorkflowEventMetadataV1 | null = null;
      try {
        metadata = parseWorkflowEventMetadata(event.metadataJson);
      } catch {
        metadata = null;
      }
      return {
        id: event.id,
        actor: event.actor,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        rank: event.rank,
        rowVersion: event.rowVersion,
        reason: event.reason,
        metadata,
        createdAt: event.createdAt,
      };
    }),
    intake:
      intakeItem === undefined
        ? null
        : {
          batchId: intakeItem.batchId,
          lineNumber: intakeItem.lineNumber,
          rawInput: intakeItem.rawInput,
        },
  };
}
