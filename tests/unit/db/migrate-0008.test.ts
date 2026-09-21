// @vitest-environment node
import { appendFileSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  ensureDatabase,
  generationRequests,
  jobs,
  migrate,
  newId,
  openDatabase,
  preflightTailoringUpgrade,
  resumeVersions,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";

/**
 * B1/B7: the checked 0008 migration applies exactly, upgrades a
 * seeded 0007 database without touching history, reruns as a
 * no-op, aborts on drift, enforces the v2+v3 queue guard and the
 * one-live-TAILOR index, and refuses the upgrade while TAILOR work
 * is live (preflight deletes nothing).
 */

const REAL_MIGRATIONS = join(process.cwd(), "drizzle");

function filteredMigrationsDir(before: string): string {
  const dir = join(tmpdir(), `job-tracker-v13-mig-${newId()}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(REAL_MIGRATIONS)) {
    if (entry.endsWith(".sql") && entry < before) {
      copyFileSync(join(REAL_MIGRATIONS, entry), join(dir, entry));
    }
  }
  return dir;
}

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-v13-m08-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

describe("B1/B7 fresh 0000→0008 migration", () => {
  it("applies all nine migrations with the four new tables, indexes, and triggers", () => {
    withDatabase((t) => {
      const names = handleTableNames(t.handle);
      for (const table of [
        "tailoring_workspaces",
        "tailoring_request_inputs",
        "generation_progress_events",
        "resume_assessments",
      ]) {
        expect(names).toContain(table);
      }
      const indexes = t.handle.sqlite
        .prepare("SELECT name AS name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>;
      const indexNames = new Set(indexes.map((row) => row.name));
      for (const name of [
        "v13_extraction_owner",
        "v13_profile_version_owner",
        "v13_resume_owner",
        "v13_one_version_per_request",
        "v13_request_owner",
        "v13_attempt_owner",
        "v13_one_live_tailor",
        "v13_inputs_snapshot",
        "v13_progress_request",
        "v13_assessment_request",
      ]) {
        expect(indexNames.has(name), name).toBe(true);
      }
      const triggers = t.handle.sqlite
        .prepare("SELECT name AS name FROM sqlite_master WHERE type = 'trigger'")
        .all() as Array<{ name: string }>;
      const triggerNames = new Set(triggers.map((row) => row.name));
      for (const name of [
        "v13_workspace_cas",
        "v13_inputs_owner",
        "v13_inputs_no_update",
        "v13_inputs_no_delete",
        "v13_progress_fence",
        "v13_progress_no_update",
        "v13_progress_no_delete",
        "v13_assessment_binding",
        "v13_assessment_no_update",
        "v13_assessment_no_delete",
        "trg_work_items_no_legacy_tailor",
      ]) {
        expect(triggerNames.has(name), name).toBe(true);
      }
      const guard = t.handle.sqlite
        .prepare("SELECT sql AS sql FROM sqlite_master WHERE name = 'trg_work_items_no_legacy_tailor'")
        .get() as { sql: string };
      expect(guard.sql).toContain("tailor-queue/v2");
      expect(guard.sql).toContain("tailor-queue/v3");
    });
  });

  function handleTableNames(handle: DatabaseHandle): string[] {
    return (
      handle.sqlite.prepare("SELECT name AS name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  }

  it("reruns as a no-op and aborts when an applied file changed", () => {
    withDatabase((t) => {
      const rerun = migrate(t.handle.sqlite, { migrationsDir: REAL_MIGRATIONS });
      expect(rerun.applied).toEqual([]);
      expect(rerun.alreadyApplied).toHaveLength(12);
    });
    const dir = filteredMigrationsDir("~");
    const path = join(tmpdir(), `job-tracker-v13-drift-${newId()}.db`);
    const raw = openDatabase({ path });
    try {
      const first = migrate(raw.sqlite, { migrationsDir: dir });
      expect(first.applied.at(-1)).toBe("0011_step2_correction_versions");
      appendFileSync(join(dir, "0008_tailoring_workspaces.sql"), "\n-- drift\n");
      expect(() => migrate(raw.sqlite, { migrationsDir: dir })).toThrow(
        /SQLite migration drift detected: 0008_tailoring_workspaces/,
      );
    } finally {
      raw.close();
    }
  });
});

describe("B7 seeded 0007→0008 upgrade", () => {
  it("preserves hashes, reviews, and queue history while adding empty tables", () => {
    const dir = filteredMigrationsDir("0008_tailoring_workspaces.sql");
    const path = join(tmpdir(), `job-tracker-v13-up-${newId()}.db`);
    const seeded = openDatabase({ path });
    try {
      const first = migrate(seeded.sqlite, { migrationsDir: dir });
      expect(first.applied.at(-1)).toBe("0007_generation_requests");
      const world = seedCrossProfileWorld({ handle: seeded, dir: tmpdir(), dbPath: path, cleanup: () => {} });
      const before = {
        payloadHash: seeded.sqlite
          .prepare("SELECT payload_json AS payload FROM work_items WHERE id = ?")
          .get(world.v1WorkItemId) as { payload: string },
        request: seeded.db
          .select()
          .from(generationRequests)
          .where(eq(generationRequests.id, world.v1RequestId))
          .get(),
        review: seeded.db
          .select()
          .from(resumeVersions)
          .where(eq(resumeVersions.id, world.v1Id))
          .get(),
      };
      const upgrade = migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS });
      expect(upgrade.applied).toEqual([
        "0008_tailoring_workspaces",
        "0009_step2_preparation",
        "0010_step2_publish_fence",
        "0011_step2_correction_versions",
      ]);
      const after = {
        payloadHash: seeded.sqlite
          .prepare("SELECT payload_json AS payload FROM work_items WHERE id = ?")
          .get(world.v1WorkItemId) as { payload: string },
        request: seeded.db
          .select()
          .from(generationRequests)
          .where(eq(generationRequests.id, world.v1RequestId))
          .get(),
        review: seeded.db
          .select()
          .from(resumeVersions)
          .where(eq(resumeVersions.id, world.v1Id))
          .get(),
      };
      expect(after).toEqual(before);
      expect(after.review?.reviewState).toBe("AWAITING_REVIEW");
      for (const table of [
        "tailoring_workspaces",
        "tailoring_request_inputs",
        "generation_progress_events",
        "resume_assessments",
      ]) {
        const count = seeded.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        };
        expect(count.count, table).toBe(0);
      }
      const rerun = migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS });
      expect(rerun.applied).toEqual([]);
    } finally {
      seeded.close();
    }
  });

});

describe("B7 queue payload guard (v2+v3)", () => {
  function insertTailor(handle: DatabaseHandle, payload: string): void {
    const id = newId();
    handle.db
      .insert(workItems)
      .values({ id, kind: "TAILOR", idempotencyKey: `key-${id}`, payloadJson: payload })
      .run();
  }

  function payload(version: string): string {
    return JSON.stringify({
      schemaVersion: version,
      generationRequestId: newId(),
      jobId: newId(),
      extractionId: newId(),
      profileId: "local",
      profileVersionId: newId(),
      jdSnapshotId: newId(),
      payloadHash: "0".repeat(64),
    });
  }

  it("accepts v2 and v3 payloads", () => {
    withDatabase((t) => {
      expect(() => insertTailor(t.handle, payload("tailor-queue/v2"))).not.toThrow();
      expect(() =>
        insertTailor(
          t.handle,
          JSON.stringify({ ...JSON.parse(payload("tailor-queue/v3")), inputHash: "1".repeat(64) }),
        ),
      ).not.toThrow();
    });
  });

  it("rejects v1, null, malformed, and versionless payloads", () => {
    withDatabase((t) => {
      for (const bad of [
        payload("tailor-queue/v1"),
        "null",
        "{not json",
        JSON.stringify({ generationRequestId: newId() }),
      ]) {
        expect(() => insertTailor(t.handle, bad)).toThrow(/UNSUPPORTED_TAILOR_PAYLOAD/);
      }
    });
  });

  it("fails a second live TAILOR item for the same job, allows terminal and foreign rows", () => {
    withDatabase((t) => {
      const jobId = newId();
      t.handle.db
        .insert(jobs)
        .values({ id: jobId, status: "NEW", rowVersion: 1, tailoringState: "READY" })
        .run();
      const otherId = newId();
      t.handle.db
        .insert(jobs)
        .values({ id: otherId, status: "NEW", rowVersion: 1, tailoringState: "READY" })
        .run();
      const queued = newId();
      t.handle.db
        .insert(workItems)
        .values({ id: queued, kind: "TAILOR", jobId, idempotencyKey: `key-${queued}`, payloadJson: payload("tailor-queue/v3") })
        .run();
      const second = newId();
      expect(() =>
        t.handle.db
          .insert(workItems)
          .values({ id: second, kind: "TAILOR", jobId, idempotencyKey: `key-${second}`, payloadJson: payload("tailor-queue/v3") })
          .run(),
      ).toThrow(/UNIQUE constraint failed: work_items\.job_id/);
      const terminal = newId();
      expect(() =>
        t.handle.db
          .insert(workItems)
          .values({
            id: terminal,
            kind: "TAILOR",
            jobId,
            state: "SUCCEEDED",
            idempotencyKey: `key-${terminal}`,
            payloadJson: payload("tailor-queue/v2"),
          })
          .run(),
      ).not.toThrow();
      const foreign = newId();
      expect(() =>
        t.handle.db
          .insert(workItems)
          .values({ id: foreign, kind: "TAILOR", jobId: otherId, idempotencyKey: `key-${foreign}`, payloadJson: payload("tailor-queue/v3") })
          .run(),
      ).not.toThrow();
    });
  });
});

describe("B8 migration preflight refuses live work", () => {
  it("ensureDatabase throws on a live TAILOR item without changing or deleting it", () => {
    const dir = filteredMigrationsDir("0008_tailoring_workspaces.sql");
    const path = join(tmpdir(), `job-tracker-v13-pre-${newId()}.db`);
    const seeded = openDatabase({ path });
    try {
      migrate(seeded.sqlite, { migrationsDir: dir });
      const jobId = newId();
      seeded.db
        .insert(jobs)
        .values({ id: jobId, status: "NEW", rowVersion: 1, tailoringState: "READY" })
        .run();
      const itemId = newId();
      seeded.db
        .insert(workItems)
        .values({
          id: itemId,
          kind: "TAILOR",
          jobId,
          idempotencyKey: `key-${itemId}`,
          payloadJson: JSON.stringify({
            schemaVersion: "tailor-queue/v2",
            generationRequestId: newId(),
            jobId,
            extractionId: newId(),
            profileId: "local",
            profileVersionId: newId(),
            jdSnapshotId: newId(),
            payloadHash: "0".repeat(64),
          }),
        })
        .run();
      seeded.close();
      expect(() => ensureDatabase({ path, migrationsDir: REAL_MIGRATIONS })).toThrow(
        /upgrade to 0008_tailoring_workspaces refused: 1 live TAILOR work item\(s\) \(1 queued, 0 running\)/,
      );
      const reopened = openDatabase({ path });
      try {
        const item = reopened.db
          .select()
          .from(workItems)
          .where(eq(workItems.id, itemId))
          .get();
        expect(item?.state).toBe("QUEUED");
        const applied = reopened.sqlite
          .prepare("SELECT version AS version FROM _schema_migrations WHERE version = ?")
          .get("0008_tailoring_workspaces");
        expect(applied).toBeUndefined();
      } finally {
        reopened.close();
      }
    } catch (error) {
      try {
        seeded.close();
      } catch {
        /* already closed */
      }
      throw error;
    }
  });

  it("preflight passes on quiescent and migrated databases", () => {
    const dir = filteredMigrationsDir("0008_tailoring_workspaces.sql");
    const path = join(tmpdir(), `job-tracker-v13-pre-${newId()}.db`);
    const seeded = openDatabase({ path });
    try {
      migrate(seeded.sqlite, { migrationsDir: dir });
      expect(preflightTailoringUpgrade(seeded.sqlite, REAL_MIGRATIONS)).toEqual({
        queued: 0,
        running: 0,
      });
      migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS });
      expect(preflightTailoringUpgrade(seeded.sqlite, REAL_MIGRATIONS)).toEqual({
        queued: 0,
        running: 0,
      });
    } finally {
      seeded.close();
    }
  });

});
