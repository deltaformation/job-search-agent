import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";
import { intakeItems } from "./intake";
import { jobs } from "./jobs";

/**
 * Durable work queue. A lease is held if and only if the item is RUNNING; the
 * database CHECK makes a forgotten lease-clear a hard error instead of a stuck
 * queue. Executions are recorded in `work_attempts`, which is append-only.
 */
export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    jobId: text("job_id").references(() => jobs.id),
    intakeItemId: text("intake_item_id").references(() => intakeItems.id),
    payloadJson: text("payload_json"),
    state: text("state").notNull().default("QUEUED"),
    leaseToken: text("lease_token"),
    leasedAt: text("leased_at"),
    leaseExpiresAt: text("lease_expires_at"),
    workerId: text("worker_id"),
    currentAttemptId: text("current_attempt_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextRunAt: text("next_run_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_items_state_next_run").on(t.state, t.nextRunAt),
    uniqueIndex("v13_one_live_tailor")
      .on(t.jobId)
      .where(sql.raw("kind='TAILOR' AND state IN ('QUEUED','RUNNING')")),
    index("work_items_job_id").on(t.jobId),
    index("work_items_intake_item_id").on(t.intakeItemId),
    check("work_items_kind", sql`${t.kind} IN ('SCRAPE','TAILOR')`),
    check(
      "work_items_state",
      sql`${t.state} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')`,
    ),
    check(
      "work_items_lease_iff_running",
      sql`(${t.state} = 'RUNNING') = (${t.leaseToken} IS NOT NULL)`,
    ),
    check("work_items_attempt_count", sql`${t.attemptCount} >= 0`),
    check("work_items_max_attempts", sql`${t.maxAttempts} >= 1`),
  ],
);

export const workAttempts = sqliteTable(
  "work_attempts",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    result: text("result").notNull(),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("work_attempts_item_number").on(t.workItemId, t.attemptNumber),
    uniqueIndex("v13_attempt_owner").on(t.id, t.workItemId),
    index("work_attempts_work_item_id").on(t.workItemId),
    check("work_attempts_number", sql`${t.attemptNumber} >= 1`),
    check(
      "work_attempts_result",
      sql`${t.result} IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED')`,
    ),
  ],
);

export type WorkItem = typeof workItems.$inferSelect;
export type WorkAttempt = typeof workAttempts.$inferSelect;
