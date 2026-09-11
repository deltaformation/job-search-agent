import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";
import { intakeItems } from "./intake";

/**
 * Normalized job records plus the raw-evidence layer (attempts, artifacts,
 * immutable extractions).
 *
 * `jobs.activeExtractionId` / `jobs.activeResumeVersionId` intentionally have
 * no Drizzle foreign key: the pair is circular, so existence plus same-job
 * ownership is enforced by triggers in the hand-reviewed constraints migration.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("NEW"),
    rank: real("rank").notNull().default(0),
    rowVersion: integer("row_version").notNull().default(1),
    title: text("title"),
    company: text("company"),
    location: text("location"),
    arrangement: text("arrangement"),
    salaryText: text("salary_text"),
    salaryCurrency: text("salary_currency"),
    salaryMinMinor: integer("salary_min_minor"),
    salaryMaxMinor: integer("salary_max_minor"),
    descriptionText: text("description_text"),
    postedAt: text("posted_at"),
    scrapeState: text("scrape_state").notNull().default("QUEUED"),
    scrapeReasonCode: text("scrape_reason_code"),
    tailoringState: text("tailoring_state").notNull().default("PENDING"),
    tailoringReasonCode: text("tailoring_reason_code"),
    activeExtractionId: text("active_extraction_id"),
    activeResumeVersionId: text("active_resume_version_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_status_rank").on(t.status, t.rank),
    check(
      "jobs_status",
      sql`${t.status} IN ('NEW','TAILORED','APPLIED','INTERVIEWED','REJECTED')`,
    ),
    check("jobs_row_version", sql`${t.rowVersion} >= 1`),
    check(
      "jobs_arrangement",
      sql`${t.arrangement} IS NULL OR ${t.arrangement} IN ('REMOTE','HYBRID','ONSITE','UNKNOWN')`,
    ),
    check(
      "jobs_salary_nonnegative",
      sql`(${t.salaryMinMinor} IS NULL OR ${t.salaryMinMinor} >= 0) AND (${t.salaryMaxMinor} IS NULL OR ${t.salaryMaxMinor} >= 0)`,
    ),
    check(
      "jobs_salary_ordered",
      sql`${t.salaryMinMinor} IS NULL OR ${t.salaryMaxMinor} IS NULL OR ${t.salaryMinMinor} <= ${t.salaryMaxMinor}`,
    ),
    check(
      "jobs_scrape_state",
      sql`${t.scrapeState} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED')`,
    ),
    check(
      "jobs_tailoring_state",
      sql`${t.tailoringState} IN ('PENDING','BLOCKED','RUNNING','AWAITING_REVIEW','APPROVED','REVISION_REQUESTED','FAILED')`,
    ),
  ],
);

export const jobSources = sqliteTable(
  "job_sources",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    submittedUrl: text("submitted_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    canonicalKey: text("canonical_key").notNull().unique(),
    finalUrl: text("final_url"),
    applyUrl: text("apply_url"),
    sourceIdentity: text("source_identity"),
    createdAt: createdAt(),
  },
  (t) => [index("job_sources_job_id").on(t.jobId)],
);

/**
 * Scrape attempts are written once, at completion. In-flight work is tracked
 * by `work_items`; this table plus its trigger set is append-only.
 */
export const scrapeAttempts = sqliteTable(
  "scrape_attempts",
  {
    id: text("id").primaryKey(),
    intakeItemId: text("intake_item_id").references(() => intakeItems.id),
    jobId: text("job_id").references(() => jobs.id),
    canonicalUrl: text("canonical_url").notNull(),
    adapter: text("adapter"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    errorDetail: text("error_detail"),
    workerId: text("worker_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("scrape_attempts_intake_item_id").on(t.intakeItemId),
    index("scrape_attempts_job_id").on(t.jobId),
    check(
      "scrape_attempts_outcome",
      sql`${t.outcome} IN ('SUCCEEDED','FAILED','BLOCKED')`,
    ),
  ],
);

export const sourceArtifacts = sqliteTable(
  "source_artifacts",
  {
    id: text("id").primaryKey(),
    scrapeAttemptId: text("scrape_attempt_id")
      .notNull()
      .references(() => scrapeAttempts.id),
    kind: text("kind").notNull(),
    relativePath: text("relative_path").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("source_artifacts_attempt_kind").on(t.scrapeAttemptId, t.kind),
    index("source_artifacts_attempt_id").on(t.scrapeAttemptId),
    index("source_artifacts_sha256").on(t.sha256),
    check("source_artifacts_kind", sql`${t.kind} IN ('HTML','TEXT','JSONLD')`),
    check("source_artifacts_byte_size", sql`${t.byteSize} >= 0`),
  ],
);

export const jobExtractions = sqliteTable(
  "job_extractions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    scrapeAttemptId: text("scrape_attempt_id")
      .notNull()
      .references(() => scrapeAttempts.id)
      .unique(),
    version: integer("version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    adapter: text("adapter").notNull(),
    adapterVersion: text("adapter_version"),
    extractedJson: text("extracted_json").notNull(),
    confidence: real("confidence"),
    missingFieldsJson: text("missing_fields_json"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("job_extractions_job_version").on(t.jobId, t.version),
    index("job_extractions_job_id").on(t.jobId),
    check("job_extractions_version", sql`${t.version} >= 1`),
    check(
      "job_extractions_confidence",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type JobSource = typeof jobSources.$inferSelect;
export type ScrapeAttempt = typeof scrapeAttempts.$inferSelect;
export type SourceArtifact = typeof sourceArtifacts.$inferSelect;
export type JobExtraction = typeof jobExtractions.$inferSelect;
