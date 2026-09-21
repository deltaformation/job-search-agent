import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import {
  candidateProfiles,
  candidateProfileVersions,
  candidateSnapshots,
} from "./candidates";
import { generationRequests } from "./generation";
import { jobExtractions, jobs } from "./jobs";
import { workAttempts, workItems } from "./queue";
import { resumeVersions } from "./resumes";

/**
 * Exact Drizzle mirror for migration 0008
 * (`drizzle/0008_tailoring_workspaces.sql`), verbatim from
 * `docs/contracts/v1.3-drizzle.md` (WO-1.3-A specification, verified
 * by WO-1.3-B §5). Triggers remain in SQL. Static `sql.raw`
 * predicates below contain only fixed schema identifiers, never
 * external input. Foreign keys use NO ACTION, matching the DDL. No
 * defaults: services supply timestamps/revisions explicitly.
 *
 * Services parse text JSON through the strict schemas in
 * `src/domain/tailoringWorkspace.ts`; never use Drizzle JSON mode
 * to imply unvalidated database contents are typed.
 */

const c = (name: string, predicate: string) => check(name, sql.raw(predicate));

export const tailoringWorkspaces = sqliteTable(
  "tailoring_workspaces",
  {
    jobId: text("job_id").primaryKey().notNull().references(() => jobs.id),
    revision: integer("revision").notNull(),
    extractionId: text("extraction_id"),
    profileId: text("profile_id").references(() => candidateProfiles.id),
    profileVersionId: text("profile_version_id"),
    requestKind: text("request_kind").notNull(),
    parentVersionId: text("parent_version_id"),
    revisionNote: text("revision_note"),
    focusJson: text("focus_json").notNull(),
    recommendationsJson: text("recommendations_json"),
    recommendationHash: text("recommendation_hash"),
    lastRequestId: text("last_request_id"),
    lastSubmittedRevision: integer("last_submitted_revision"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.extractionId, t.jobId],
      foreignColumns: [jobExtractions.id, jobExtractions.jobId],
    }),
    foreignKey({
      columns: [t.profileVersionId, t.profileId],
      foreignColumns: [candidateProfileVersions.id, candidateProfileVersions.profileId],
    }),
    foreignKey({
      columns: [t.parentVersionId, t.jobId],
      foreignColumns: [resumeVersions.id, resumeVersions.jobId],
    }),
    foreignKey({
      columns: [t.lastRequestId, t.jobId],
      foreignColumns: [generationRequests.id, generationRequests.jobId],
    }),
    c("v13_ws_revision", "revision>=1"),
    c("v13_ws_kind", "request_kind IN ('INITIAL','NEW_VERSION','REVISION')"),
    c(
      "v13_ws_focus",
      "json_valid(focus_json) AND length(CAST(focus_json AS BLOB))<=65536",
    ),
    c(
      "v13_ws_recs",
      "recommendations_json IS NULL OR (json_valid(recommendations_json) AND length(CAST(recommendations_json AS BLOB))<=262144)",
    ),
    c(
      "v13_ws_hash",
      "recommendation_hash IS NULL OR (length(recommendation_hash)=64 AND recommendation_hash NOT GLOB '*[^0-9a-f]*')",
    ),
    c(
      "v13_ws_submitted",
      "last_submitted_revision>=1 AND last_submitted_revision<=revision",
    ),
    c("v13_ws_profile", "(profile_id IS NULL)=(profile_version_id IS NULL)"),
    c("v13_ws_rec_pair", "(recommendations_json IS NULL)=(recommendation_hash IS NULL)"),
    c(
      "v13_ws_rec_bound",
      "recommendations_json IS NULL OR (extraction_id IS NOT NULL AND profile_version_id IS NOT NULL)",
    ),
    c("v13_ws_last", "(last_request_id IS NULL)=(last_submitted_revision IS NULL)"),
    c(
      "v13_ws_parent",
      "(request_kind='INITIAL' AND parent_version_id IS NULL AND revision_note IS NULL) OR (request_kind='NEW_VERSION' AND parent_version_id IS NOT NULL AND revision_note IS NULL) OR (request_kind='REVISION' AND parent_version_id IS NOT NULL AND revision_note IS NOT NULL AND length(trim(revision_note)) BETWEEN 1 AND 4000)",
    ),
  ],
);

export const tailoringRequestInputs = sqliteTable(
  "tailoring_request_inputs",
  {
    requestId: text("request_id").primaryKey().notNull().references(() => generationRequests.id),
    workspaceRevision: integer("workspace_revision").notNull(),
    submitHash: text("submit_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    candidateSnapshotId: text("candidate_snapshot_id")
      .notNull()
      .references(() => candidateSnapshots.id),
    focusJson: text("focus_json").notNull(),
    recommendationsJson: text("recommendations_json").notNull(),
    masterText: text("master_text").notNull(),
    masterTextHash: text("master_text_hash").notNull(),
    projectionVersion: text("projection_version").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("v13_inputs_snapshot").on(t.candidateSnapshotId),
    c("v13_in_revision", "workspace_revision>=1"),
    c(
      "v13_in_submit_hash",
      "length(submit_hash)=64 AND submit_hash NOT GLOB '*[^0-9a-f]*'",
    ),
    c("v13_in_hash", "length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'"),
    c(
      "v13_in_master_hash",
      "length(master_text_hash)=64 AND master_text_hash NOT GLOB '*[^0-9a-f]*'",
    ),
    c(
      "v13_in_focus",
      "json_valid(focus_json) AND length(CAST(focus_json AS BLOB))<=65536",
    ),
    c(
      "v13_in_recs",
      "json_valid(recommendations_json) AND length(CAST(recommendations_json AS BLOB))<=262144",
    ),
    c("v13_in_master", "length(CAST(master_text AS BLOB)) BETWEEN 1 AND 262144"),
    c("v13_in_projection", "projection_version='master-text/1'"),
  ],
);

export const generationProgressEvents = sqliteTable(
  "generation_progress_events",
  {
    requestId: text("request_id").notNull().references(() => generationRequests.id),
    workItemId: text("work_item_id").notNull().references(() => workItems.id),
    attemptId: text("attempt_id").notNull(),
    seq: integer("seq").notNull(),
    stage: text("stage").notNull(),
    source: text("source").notNull(),
    leaseToken: text("lease_token").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.seq] }),
    unique("v13_progress_unique_stage").on(t.attemptId, t.stage),
    foreignKey({
      columns: [t.attemptId, t.workItemId],
      foreignColumns: [workAttempts.id, workAttempts.workItemId],
    }),
    index("v13_progress_request").on(t.requestId, t.attemptId, t.seq),
    c("v13_progress_seq", "seq BETWEEN 1 AND 5"),
    c(
      "v13_progress_stage",
      "stage IN ('PREPARING_INPUTS','WAITING_FOR_PROVIDER','VALIDATING_PROPOSAL','RENDERING_ARTIFACTS','PUBLISHING_RESULT')",
    ),
    c("v13_progress_source", "source IN ('provider','cached')"),
  ],
);

export const resumeAssessments = sqliteTable(
  "resume_assessments",
  {
    resumeVersionId: text("resume_version_id")
      .primaryKey()
      .notNull()
      .references(() => resumeVersions.id),
    requestId: text("request_id").notNull().references(() => tailoringRequestInputs.requestId),
    policyVersion: text("policy_version").notNull(),
    masterTextHash: text("master_text_hash").notNull(),
    tailoredContentHash: text("tailored_content_hash").notNull(),
    measuresJson: text("measures_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("v13_assessment_request").on(t.requestId),
    c("v13_as_policy", "policy_version='assessment/1'"),
    c(
      "v13_as_master",
      "length(master_text_hash)=64 AND master_text_hash NOT GLOB '*[^0-9a-f]*'",
    ),
    c(
      "v13_as_tailored",
      "length(tailored_content_hash)=64 AND tailored_content_hash NOT GLOB '*[^0-9a-f]*'",
    ),
    c(
      "v13_as_json",
      "json_valid(measures_json) AND length(CAST(measures_json AS BLOB))<=262144",
    ),
  ],
);

export type TailoringWorkspace = typeof tailoringWorkspaces.$inferSelect;
export type TailoringRequestInputs = typeof tailoringRequestInputs.$inferSelect;
export type GenerationProgressEvent = typeof generationProgressEvents.$inferSelect;
export type ResumeAssessment = typeof resumeAssessments.$inferSelect;
