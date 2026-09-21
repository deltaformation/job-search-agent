// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  migrate,
  newId,
  openDatabase,
  preflightStep2Upgrade,
  resolveMigrationsDir,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { readPreparationByJob } from "../../../src/db/step2";
import { claimNextWorkItem, completeWorkItem } from "../../../src/queue/leases";
import { submitIntakeBatch, IntakeError } from "../../../src/server/intake";
import {
  readPlanForJob,
  readPreparationStatus,
  schedulePreparation,
} from "../../../src/server/preparation";
import {
  DATABASE_MEMBER,
  createBackupArchive,
  parseAndVerifyArchive,
  resetBoardData,
  verifyStagedDatabase,
} from "../../../src/server/backup";
import {
  ensureDataRoot,
  resolveDataRoot,
} from "../../../src/security/data-root";
import type { DnsResolver } from "../../../src/scraping/ssrf";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  claimS2b,
  finishS2bAttempt,
  runS2bAttempt,
  s2bProposalKit,
  S2B_KEYED_ENV,
  S2B_T0,
  scheduleS2b,
  seedS2bJob,
  withS2bDatabase,
} from "./s2b-world";

/**
 * WO-1.3-S2-B / S2B6: fresh migration, 0008→0010 upgrade, backup/
 * restore/reset retention, legacy freeze, and batch/concurrency
 * caps. Migration is SQL-only (zero AI calls, zero queue
 * inserts); jobs accepted before 0009 stay ABSENT until the
 * explicit command binds a profile immutably.
 */

const REAL_MIGRATIONS = join(process.cwd(), "drizzle");
const KEYED = S2B_KEYED_ENV as unknown as NodeJS.ProcessEnv;

function publicResolver(): DnsResolver {
  return async () => ["93.184.216.34"];
}

function filteredMigrationsDir(before: string): string {
  const dir = mkdtempSync(join(osTmpdir(), "job-tracker-s2b-mig-"));
  for (const entry of readdirSync(REAL_MIGRATIONS)) {
    if (entry.endsWith(".sql") && entry < before) {
      copyFileSync(join(REAL_MIGRATIONS, entry), join(dir, entry));
    }
  }
  return dir;
}

function objectNames(handle: DatabaseHandle, type: string): Set<string> {
  const rows = handle.sqlite
    .prepare("SELECT name AS name FROM sqlite_master WHERE type = ?")
    .all(type) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function foreignKeyCheck(handle: DatabaseHandle): unknown[] {
  return handle.sqlite.prepare("PRAGMA foreign_key_check").all();
}

describe("S2B6 fresh migration", () => {
  it("applies 0000→0011 with the step2 tables, fences, and live guards", () => {
    const t = createTestDatabase("job-tracker-v13-s2b-compat-");
    try {
      const tables = objectNames(t.handle, "table");
      for (const table of [
        "step2_preparations",
        "step2_plans",
        "step2_preparation_events",
        "step2_draft_validations",
        "step2_generation_inputs",
      ]) {
        expect(tables.has(table), table).toBe(true);
      }
      const triggers = objectNames(t.handle, "trigger");
      for (const trigger of [
        "s2_prep_no_delete",
        "s2_prep_accepted_forward",
        "s2_prep_binding_locked",
        "s2_plan_owner",
        "s2_event_fence",
        "trg_work_items_no_legacy_prepare",
        "v13_progress_fence",
      ]) {
        expect(triggers.has(trigger), trigger).toBe(true);
      }
      const indexes = objectNames(t.handle, "index");
      expect(indexes.has("v13_one_live_prepare")).toBe(true);
      expect(indexes.has("v13_one_live_tailor")).toBe(true);
      expect(indexes.has("s2_plans_hash")).toBe(true);
      // 0010's fence lets the success path emit PUBLISHING (seq 5)
      // on a SUCCEEDED row; every other stage needs RUNNING.
      const fence = t.handle.sqlite
        .prepare("SELECT sql AS sql FROM sqlite_master WHERE name = 's2_event_fence'")
        .get() as { sql: string };
      expect(fence.sql).toContain("NEW.seq=5");
      expect(fence.sql).toContain("p.state='SUCCEEDED'");
      const kinds = t.handle.sqlite
        .prepare("SELECT sql AS sql FROM sqlite_master WHERE name = 'work_items'")
        .get() as { sql: string };
      expect(kinds.sql).toContain("PREPARE");
      const recorded = t.handle.sqlite
        .prepare("SELECT version AS version FROM _schema_migrations ORDER BY version")
        .all() as Array<{ version: string }>;
      expect(recorded.map((row) => row.version).slice(-3)).toEqual([
        "0009_step2_preparation",
        "0010_step2_publish_fence",
        "0011_step2_correction_versions",
      ]);
      expect(foreignKeyCheck(t.handle)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe("S2B6 seeded 0008→0010 upgrade", () => {
  it("preserves history, adds empty tables, and leaves legacy jobs ABSENT", () => {
    const dir = filteredMigrationsDir("0009_step2_preparation.sql");
    const path = join(osTmpdir(), `job-tracker-s2b-up-${newId()}.db`);
    const seeded = openDatabase({ path });
    try {
      const first = migrate(seeded.sqlite, { migrationsDir: dir });
      expect(first.applied.at(-1)).toBe("0008_tailoring_workspaces");
      const world = seedCrossProfileWorld({ handle: seeded, dir: osTmpdir(), dbPath: path, cleanup: () => {} });
      // The upgrade preflight refuses live work and changes nothing.
      const probeId = newId();
      seeded.db
        .insert(workItems)
        .values({
          id: probeId,
          kind: "SCRAPE",
          idempotencyKey: `scrape-probe:${probeId}`,
          payloadJson: JSON.stringify({ schemaVersion: "scrape-payload/v1" }),
        })
        .run();
      const live = claimNextWorkItem(seeded, {
        workerId: "s2b-upgrade-probe",
        kinds: ["SCRAPE"],
        leaseDurationMs: 300_000,
        now: S2B_T0,
      });
      expect(live?.id).toBe(probeId);
      expect(() => preflightStep2Upgrade(seeded.sqlite, REAL_MIGRATIONS)).toThrow(/RUNNING/);
      const finished = completeWorkItem(
        seeded,
        {
          workItemId: probeId,
          leaseToken: live?.leaseToken as string,
          attemptId: live?.currentAttemptId as string,
          result: "SUCCEEDED",
        },
        { now: S2B_T0 },
      );
      expect(finished.ok).toBe(true);
      expect(preflightStep2Upgrade(seeded.sqlite, REAL_MIGRATIONS)).toEqual({ running: 0 });
      const before = {
        payload: (
          seeded.sqlite
            .prepare("SELECT payload_json AS payload FROM work_items WHERE id = ?")
            .get(world.v1WorkItemId) as { payload: string }
        ).payload,
        workItems: (
          seeded.sqlite.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number }
        ).count,
        jobs: (
          seeded.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }
        ).count,
      };

      const upgrade = migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS });
      expect(upgrade.applied).toEqual([
        "0009_step2_preparation",
        "0010_step2_publish_fence",
        "0011_step2_correction_versions",
      ]);
      // History byte-identical; migration inserted zero queue rows.
      expect(
        (
          seeded.sqlite
            .prepare("SELECT payload_json AS payload FROM work_items WHERE id = ?")
            .get(world.v1WorkItemId) as { payload: string }
        ).payload,
      ).toBe(before.payload);
      expect(
        (seeded.sqlite.prepare("SELECT COUNT(*) AS count FROM work_items").get() as { count: number })
          .count,
      ).toBe(before.workItems);
      expect(
        (seeded.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count,
      ).toBe(before.jobs);
      for (const table of [
        "step2_preparations",
        "step2_plans",
        "step2_preparation_events",
        "step2_draft_validations",
        "step2_generation_inputs",
      ]) {
        const count = seeded.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        };
        expect(count.count, table).toBe(0);
      }
      // Legacy jobs report ABSENT until the explicit command.
      expect(readPreparationStatus(seeded, world.jobId, S2B_T0)?.state).toBe("ABSENT");
      expect(foreignKeyCheck(seeded)).toEqual([]);
      expect(migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);
    } finally {
      seeded.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("S2B6 backup, restore, and reset", () => {
  it("a backup archive retains the binding, plan, and event history", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const live = readPreparationByJob(t.handle, basics.jobId);
      expect(live?.state).toBe("SUCCEEDED");

      const root = mkdtempSync(join(osTmpdir(), "job-tracker-s2b-backup-"));
      try {
        const paths = resolveDataRoot({ APP_DATA_ROOT: root });
        ensureDataRoot(paths);
        const candidateDir = join(root, "candidate");
        mkdirSync(candidateDir, { recursive: true });
        writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
        writeFileSync(join(paths.evidenceDir, "s2b-page"), "<html>posting</html>");
        const archive = await createBackupArchive({
          handle: t.handle,
          paths,
          candidateDir,
          stagingDir: join(root, "staging"),
          kind: "manual",
          now: new Date("2026-09-17T12:00:00.000Z"),
        });
        const verified = parseAndVerifyArchive(archive.bytes);
        const stagedPath = join(root, "staged.sqlite");
        writeFileSync(stagedPath, verified.members.get(DATABASE_MEMBER) as Buffer);
        verifyStagedDatabase(() => openDatabase({ path: stagedPath }), resolveMigrationsDir());
        const staged = openDatabase({ path: stagedPath });
        try {
          const kept = readPreparationByJob(staged, basics.jobId);
          expect(kept?.bindingJson).toBe(live?.bindingJson);
          expect(kept?.acceptedPlanId).toBe(live?.acceptedPlanId);
          expect(kept?.profileVersionId).toBe(world.pmVersionId);
          const plans = staged.sqlite
            .prepare("SELECT COUNT(*) AS count FROM step2_plans WHERE preparation_id = ?")
            .get(live?.id) as { count: number };
          expect(plans.count).toBe(1);
          const events = staged.sqlite
            .prepare("SELECT COUNT(*) AS count FROM step2_preparation_events WHERE preparation_id = ?")
            .get(live?.id) as { count: number };
          expect(events.count).toBe(5);
          expect(foreignKeyCheck(staged)).toEqual([]);
        } finally {
          staged.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("staged verification refuses a partial 0009 upgrade", async () => {
    await withS2bDatabase(async () => {
      const root = mkdtempSync(join(osTmpdir(), "job-tracker-s2b-partial-"));
      try {
        const paths = resolveDataRoot({ APP_DATA_ROOT: root });
        ensureDataRoot(paths);
        const candidateDir = join(root, "candidate");
        mkdirSync(candidateDir, { recursive: true });
        writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
        const t = createTestDatabase("job-tracker-v13-s2b-partial-");
        try {
          const archive = await createBackupArchive({
            handle: t.handle,
            paths,
            candidateDir,
            stagingDir: join(root, "staging"),
            kind: "manual",
            now: new Date("2026-09-17T12:00:00.000Z"),
          });
          const verified = parseAndVerifyArchive(archive.bytes);
          const stagedPath = join(root, "staged.sqlite");
          writeFileSync(stagedPath, verified.members.get(DATABASE_MEMBER) as Buffer);
          const staged = openDatabase({ path: stagedPath });
          staged.sqlite.exec("DROP TABLE step2_plans");
          staged.close();
          expect(
            () => verifyStagedDatabase(() => openDatabase({ path: stagedPath }), resolveMigrationsDir()),
          ).toThrow(/partial upgrade/);
        } finally {
          t.cleanup();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("reset clears job-owned preparation while preserving profiles", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      expect(readPreparationByJob(t.handle, basics.jobId)).not.toBeNull();
      const root = mkdtempSync(join(osTmpdir(), "job-tracker-s2b-reset-"));
      try {
        const paths = resolveDataRoot({ APP_DATA_ROOT: root });
        ensureDataRoot(paths);
        // Reset swaps the database file: checkpoint the WAL out of
        // the live test database, then copy it under isolated paths.
        t.handle.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        copyFileSync(t.dbPath, paths.databasePath);
        const candidateDir = join(root, "candidate");
        mkdirSync(candidateDir, { recursive: true });
        const live = openDatabase({ path: paths.databasePath });
        try {
          const result = await resetBoardData({
            handle: live,
            paths,
            candidateDir,
            stagingRoot: join(root, "staging"),
            openDatabaseAt: (dbPath: string) => openDatabase({ path: dbPath }),
            runMigrations: (fresh: DatabaseHandle) =>
              migrate(fresh.sqlite, { migrationsDir: resolveMigrationsDir() }),
            now: new Date("2026-09-17T12:00:00.000Z"),
          });
          expect(result.preservedProfile).toBe(true);
          expect(result.deletedJobs).toBeGreaterThan(0);
        } finally {
          live.close();
        }
        const reopened = openDatabase({ path: paths.databasePath });
        try {
          for (const table of [
            "step2_preparations",
            "step2_plans",
            "step2_preparation_events",
            "step2_draft_validations",
            "step2_generation_inputs",
            "jobs",
            "work_items",
          ]) {
            const count = reopened.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              count: number;
            };
            expect(count.count, table).toBe(0);
          }
          for (const table of ["candidate_profiles", "candidate_profile_versions", "candidate_facts"]) {
            const count = reopened.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              count: number;
            };
            expect(count.count, table).toBeGreaterThan(0);
          }
          expect(foreignKeyCheck(reopened)).toEqual([]);
        } finally {
          reopened.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("S2B6 legacy freeze and intake caps", () => {
  it("explicit legacy preparation shows and freezes the chosen profile", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      expect(readPreparationStatus(t.handle, basics.jobId, S2B_T0)?.state).toBe("ABSENT");
      // The reply shows the resolved binding (SPM active version).
      const scheduled = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: world.spmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) {
        throw new Error("S2-B schedule failed");
      }
      expect(scheduled.value.profileId).toBe(world.spmProfileId);
      expect(scheduled.value.profileVersionId).toBe(world.spmVersionId);
      // Later edits — a newer SPM version plus a default switch —
      // never retarget the frozen binding.
      const { getProfileVersion, insertProfileVersion, activateProfileVersion, setDefaultProfile } =
        await import("../../../src/db/candidates");
      const current = getProfileVersion(t.handle, world.spmVersionId);
      if (current === null) {
        throw new Error("S2-B world lost the SPM version");
      }
      const newer = insertProfileVersion(t.handle, {
        version: current.version + 1,
        payloadJson: current.payloadJson,
        payloadHash: current.payloadHash,
        schemaVersion: current.schemaVersion,
        profileId: world.spmProfileId,
      });
      expect(activateProfileVersion(t.handle, newer.id, S2B_T0)).toBe(true);
      expect(setDefaultProfile(t.handle, world.pmProfileId)).toBe(true);
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.profileId).toBe(world.spmProfileId);
      expect(row?.profileVersionId).toBe(world.spmVersionId);
      const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(status?.binding?.profileVersionId).toBe(world.spmVersionId);
      expect(readPlanForJob(t.handle, basics.jobId, null)).toMatchObject({
        ok: false,
        error: "plan-not-found",
      });
    });
  });

  it("large batches respect the intake cap and claims stay single", async () => {
    await withS2bDatabase(async (t) => {
      const lines = Array.from({ length: 100 }, (_, index) => `https://example.com/jobs/s2b-cap-${index}`);
      const full = await submitIntakeBatch({ handle: t.handle, resolveHost: publicResolver(), lines });
      expect(full.results).toHaveLength(100);
      expect(full.results.every((line) => line.outcome === "ENQUEUED")).toBe(true);
      const over = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: publicResolver(),
        lines: [...lines, "https://example.com/jobs/s2b-cap-over"],
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(over).toBeInstanceOf(IntakeError);
    });
    await withS2bDatabase(async (t, world) => {
      // Provider concurrency is the single-claim loop: one claim
      // moves exactly one PREPARE item, never a batch.
      const first = seedS2bJob(t.handle, world);
      const second = seedS2bJob(t.handle, world);
      scheduleS2b(t.handle, first, { profileId: world.pmProfileId });
      scheduleS2b(t.handle, second, { profileId: world.pmProfileId });
      const one = claimS2b(t.handle);
      const states = t.handle.db
        .select({ id: workItems.id, state: workItems.state })
        .from(workItems)
        .where(eq(workItems.kind, "PREPARE"))
        .all();
      expect(states.filter((item) => item.state === "RUNNING")).toHaveLength(1);
      expect(states.filter((item) => item.state === "QUEUED")).toHaveLength(1);
      expect(states.find((item) => item.id === one.workItemId)?.state).toBe("RUNNING");
    });
  });
});
