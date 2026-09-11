import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";
import { jobs } from "./jobs";

/**
 * Intake tables. Every pasted line is preserved with its batch, position, raw
 * text, and classification outcome. Rows are never deleted; merges keep every
 * intake item.
 */
export const intakeBatches = sqliteTable(
  "intake_batches",
  {
    id: text("id").primaryKey(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rawLineCount: integer("raw_line_count").notNull().default(0),
    enqueuedCount: integer("enqueued_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    invalidCount: integer("invalid_count").notNull().default(0),
    blockedCount: integer("blocked_count").notNull().default(0),
  },
  (t) => [
    check(
      "intake_batches_counts_nonnegative",
      sql`${t.rawLineCount} >= 0 AND ${t.enqueuedCount} >= 0 AND ${t.duplicateCount} >= 0 AND ${t.invalidCount} >= 0 AND ${t.blockedCount} >= 0`,
    ),
  ],
);

export const intakeItems = sqliteTable(
  "intake_items",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => intakeBatches.id),
    lineNumber: integer("line_number").notNull(),
    rawInput: text("raw_input").notNull(),
    outcome: text("outcome").notNull().default("PENDING"),
    reasonCode: text("reason_code"),
    canonicalUrl: text("canonical_url"),
    jobId: text("job_id").references(() => jobs.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("intake_items_batch_line").on(t.batchId, t.lineNumber),
    index("intake_items_batch_id").on(t.batchId),
    index("intake_items_job_id").on(t.jobId),
    check(
      "intake_items_outcome",
      sql`${t.outcome} IN ('PENDING','ENQUEUED','INVALID','DUPLICATE','BLOCKED')`,
    ),
    check("intake_items_line_number", sql`${t.lineNumber} >= 1`),
  ],
);

export type IntakeBatch = typeof intakeBatches.$inferSelect;
export type IntakeItem = typeof intakeItems.$inferSelect;
