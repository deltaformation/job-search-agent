import {
  index,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { candidateSnapshots } from "./candidates";
import { createdAt } from "./columns";
import { jobExtractions, jobs } from "./jobs";
import { workAttempts } from "./queue";

/**
 * Immutable job-description snapshots and structured requirement analyses.
 *
 * An analysis binds one JD snapshot to one candidate snapshot plus the tailor
 * execution that produced it. Resume versions point at the analysis, which is
 * how claim citations resolve to the exact bound snapshot. The same-job rule
 * (analysis, JD snapshot, and job agree) is enforced by a trigger because
 * SQLite CHECK constraints cannot contain subqueries.
 */
export const jdSnapshots = sqliteTable(
  "jd_snapshots",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    extractionId: text("extraction_id")
      .notNull()
      .references(() => jobExtractions.id),
    jdText: text("jd_text").notNull(),
    canonicalSha256: text("canonical_sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("jd_snapshots_job_hash").on(t.jobId, t.canonicalSha256),
    index("jd_snapshots_job_id").on(t.jobId),
  ],
);

export const jobAnalyses = sqliteTable(
  "job_analyses",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    jdSnapshotId: text("jd_snapshot_id")
      .notNull()
      .references(() => jdSnapshots.id),
    candidateSnapshotId: text("candidate_snapshot_id")
      .notNull()
      .references(() => candidateSnapshots.id),
    workAttemptId: text("work_attempt_id").references(() => workAttempts.id),
    requirementsJson: text("requirements_json").notNull(),
    gapsJson: text("gaps_json").notNull(),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    proposalSchemaVersion: text("proposal_schema_version").notNull(),
    inputHash: text("input_hash"),
    proposalHash: text("proposal_hash"),
    rationale: text("rationale"),
    createdAt: createdAt(),
  },
  (t) => [index("job_analyses_job_id").on(t.jobId)],
);

export type JdSnapshot = typeof jdSnapshots.$inferSelect;
export type JobAnalysis = typeof jobAnalyses.$inferSelect;
