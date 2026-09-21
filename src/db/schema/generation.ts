import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createdAt, updatedAt } from "./columns";
import { jobExtractions, jobs } from "./jobs";
import { workItems } from "./queue";

/**
 * Explicit generation requests (WO-1.2-D, migration 0007). One
 * immutable row per human generation command carrying the pinned
 * profile version, JD snapshot, frozen steering, canonical keywords,
 * directives, revision note, parent version, unique request identity,
 * and payload hash. Only execution bookkeeping (status, work_item_id,
 * started/finished/error, updated_at) changes after insert — enforced
 * by `trg_generation_requests_frozen_update`.
 *
 * Profile/version/snapshot bindings intentionally have no Drizzle
 * foreign key: the worker must handle a binding that no longer
 * resolves (D8) as a fenced failure, not a database error.
 */
export const generationRequests = sqliteTable(
  "generation_requests",
  {
    id: text("id").primaryKey(),
    requestIdentity: text("request_identity").notNull().unique(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    extractionId: text("extraction_id")
      .notNull()
      .references(() => jobExtractions.id),
    profileId: text("profile_id").notNull(),
    profileVersionId: text("profile_version_id").notNull(),
    jdSnapshotId: text("jd_snapshot_id").notNull(),
    parentVersionId: text("parent_version_id"),
    requestKind: text("request_kind").notNull(),
    steeringSnapshotJson: text("steering_snapshot_json").notNull(),
    selectedKeywordsJson: text("selected_keywords_json").notNull(),
    directivesText: text("directives_text"),
    revisionNote: text("revision_note"),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("QUEUED"),
    workItemId: text("work_item_id").references(() => workItems.id),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("generation_requests_job_id").on(t.jobId),
    uniqueIndex("v13_request_owner").on(t.id, t.jobId),
    check(
      "generation_requests_kind",
      sql`${t.requestKind} IN ('INITIAL','NEW_VERSION','REVISION')`,
    ),
    check(
      "generation_requests_kind_parent",
      sql`(${t.requestKind} = 'INITIAL' AND ${t.parentVersionId} IS NULL) OR (${t.requestKind} IN ('NEW_VERSION','REVISION') AND ${t.parentVersionId} IS NOT NULL)`,
    ),
    check(
      "generation_requests_status",
      sql`${t.status} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')`,
    ),
  ],
);

export type GenerationRequest = typeof generationRequests.$inferSelect;
