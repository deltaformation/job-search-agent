// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Arrangement,
  AttemptResult,
  BoardStatus,
  IntakeOutcome,
  RecordedBy,
  ResumeArtifactKind,
  ReviewAction,
  ReviewState,
  ScrapeState,
  SourceArtifactKind,
  TailoringState,
  Verification,
  WorkKind,
  WorkState,
} from "../../../src/domain";
import type { SqliteConnection } from "../../../src/db";
import { runWithTestDb } from "./helpers";

/**
 * Contract mirror: every SQLite enum CHECK must list exactly the values of
 * its Zod counterpart. One side cannot drift without failing here.
 */
const MIRRORS: ReadonlyArray<{
  table: string;
  constraint: string;
  schema: z.ZodEnum<Record<string, string>>;
}> = [
  { table: "jobs", constraint: "jobs_status", schema: BoardStatus },
  { table: "jobs", constraint: "jobs_arrangement", schema: Arrangement },
  { table: "jobs", constraint: "jobs_scrape_state", schema: ScrapeState },
  { table: "jobs", constraint: "jobs_tailoring_state", schema: TailoringState },
  { table: "workflow_events", constraint: "workflow_events_from_status", schema: BoardStatus },
  { table: "workflow_events", constraint: "workflow_events_to_status", schema: BoardStatus },
  { table: "scrape_attempts", constraint: "scrape_attempts_outcome", schema: AttemptResult },
  { table: "work_attempts", constraint: "work_attempts_result", schema: AttemptResult },
  { table: "source_artifacts", constraint: "source_artifacts_kind", schema: SourceArtifactKind },
  { table: "work_items", constraint: "work_items_kind", schema: WorkKind },
  { table: "work_items", constraint: "work_items_state", schema: WorkState },
  { table: "intake_items", constraint: "intake_items_outcome", schema: IntakeOutcome },
  { table: "candidate_facts", constraint: "candidate_facts_verification", schema: Verification },
  { table: "resume_versions", constraint: "resume_versions_review_state", schema: ReviewState },
  { table: "resume_artifacts", constraint: "resume_artifacts_kind", schema: ResumeArtifactKind },
  { table: "resume_reviews", constraint: "resume_reviews_action", schema: ReviewAction },
];

function checkValues(sqlite: SqliteConnection, table: string, constraint: string): string[] {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string };
  const start = row.sql.indexOf(`CONSTRAINT "${constraint}"`);
  expect(start, `${table}.${constraint} exists`).toBeGreaterThanOrEqual(0);
  const match = /IN\s*\(([^)]*)\)/.exec(row.sql.slice(start));
  expect(match, `${table}.${constraint} has an IN list`).not.toBeNull();
  return [...match![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("domain/database enum mirror", () => {
  it("matches every CHECK list to its Zod enum", () => {
    runWithTestDb((t) => {
      for (const { table, constraint, schema } of MIRRORS) {
        expect(
          checkValues(t.handle.sqlite, table, constraint).sort(),
          `${table}.${constraint}`,
        ).toEqual([...schema.options].sort());
      }
    });
  });

  it("keeps applications human-only on both sides", () => {
    runWithTestDb((t) => {
      expect(
        checkValues(t.handle.sqlite, "applications", "applications_recorded_by"),
      ).toEqual(["human"]);
      expect(RecordedBy.safeParse("human").success).toBe(true);
    });
  });
});
