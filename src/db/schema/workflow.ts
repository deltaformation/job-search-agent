import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";
import { jobs } from "./jobs";

const BOARD_STATUSES = "'NEW','TAILORED','APPLIED','INTERVIEWED','REJECTED'";

/**
 * Board history, user notes, and human-recorded applications.
 *
 * `workflow_events` is append-only (insertion order is the SQLite rowid).
 * `applications.recorded_by` is constrained to `human` at the database level:
 * no automated path may ever record an application.
 */
export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    actor: text("actor").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    rank: real("rank"),
    rowVersion: integer("row_version").notNull(),
    reason: text("reason"),
    metadataJson: text("metadata_json"),
    createdAt: createdAt(),
  },
  (t) => [
    index("workflow_events_job_id").on(t.jobId),
    check(
      "workflow_events_from_status",
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} IN (${sql.raw(BOARD_STATUSES)})`,
    ),
    check(
      "workflow_events_to_status",
      sql`${t.toStatus} IN (${sql.raw(BOARD_STATUSES)})`,
    ),
    check("workflow_events_row_version", sql`${t.rowVersion} >= 1`),
  ],
);

export const jobNotes = sqliteTable(
  "job_notes",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("job_notes_job_id").on(t.jobId)],
);

export const applications = sqliteTable(
  "applications",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id)
      .unique(),
    recordedBy: text("recorded_by").notNull().default("human"),
    appliedAt: text("applied_at").notNull(),
    confirmationNumber: text("confirmation_number"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("applications_recorded_by", sql`${t.recordedBy} IN ('human')`),
  ],
);

export type WorkflowEvent = typeof workflowEvents.$inferSelect;
export type JobNote = typeof jobNotes.$inferSelect;
export type Application = typeof applications.$inferSelect;
