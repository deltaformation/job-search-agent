// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrate,
  newId,
  openDatabase,
  resolveMigrationsDir,
  type DatabaseHandle,
} from "../../../src/db";
import { getTailoringJob } from "../../../src/db/tailoring";
import { validateDraft, validateDraftV2 } from "../../../src/server/preparation";
import { submitGeneration } from "../../../src/server/generations";
import {
  DATABASE_MEMBER,
  createBackupArchive,
  parseAndVerifyArchive,
  resetBoardData,
  verifyStagedDatabase,
} from "../../../src/server/backup";
import { ensureDataRoot, resolveDataRoot } from "../../../src/security/data-root";
import { Step2EditedInputsV2 } from "../../../src/domain/step2Correction";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  S2B_JD,
} from "./s2b-world";
import {
  s2dDraft,
  s2dDraftV2,
  s2dNow,
  s2dSaveDraft,
  s2dSaveDraftV2,
  seedS2dAccepted,
  seedS2dAcceptedV2,
  withS2dDatabase,
  S2D_KEYED_ENV,
} from "./s2d-world";

/**
 * WO-1.3-S2-CP-B / S2CPB1: the 0011 correction migration applies
 * fresh and as a seeded 0010→0011 upgrade with v1 rows
 * byte-identical; the widened CHECKs and lineage guard admit v2
 * rows beside v1; immutability triggers protect plans, verdicts,
 * and frozen manifests; backup/restore retain v2 rows; reset
 * clears job-owned v2 rows while preserving profiles.
 */

const REAL_MIGRATIONS = join(process.cwd(), "drizzle");

function filteredMigrationsDir(before: string): string {
  const dir = mkdtempSync(join(osTmpdir(), "job-tracker-s2cpb-mig-"));
  for (const entry of readdirSync(REAL_MIGRATIONS)) {
    if (entry.endsWith(".sql") && entry < before) {
      copyFileSync(join(REAL_MIGRATIONS, entry), join(dir, entry));
    }
  }
  return dir;
}

function foreignKeyCheck(handle: DatabaseHandle): unknown[] {
  return handle.sqlite.prepare("PRAGMA foreign_key_check").all();
}

function dumpStep2(handle: DatabaseHandle): Record<string, unknown[]> {
  const dump = (table: string, order: string): unknown[] =>
    handle.sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  return {
    preparations: dump("step2_preparations", "id"),
    plans: dump("step2_plans", "id"),
    events: dump("step2_preparation_events", "attempt_id, seq"),
    validations: dump("step2_draft_validations", "id"),
    generationInputs: dump("step2_generation_inputs", "request_id"),
  };
}

describe("S2CPB1 fresh 0011", () => {
  it("applies 0011 with widened CHECKs, the lineage guard, and v1+v2 rows", async () => {
    await withS2dDatabase(async (t, world) => {
      const recorded = t.handle.sqlite
        .prepare("SELECT version AS version FROM _schema_migrations ORDER BY version")
        .all() as Array<{ version: string }>;
      expect(recorded.map((row) => row.version).slice(-2)).toEqual([
        "0010_step2_publish_fence",
        "0011_step2_correction_versions",
      ]);
      const plansSql = (
        t.handle.sqlite
          .prepare("SELECT sql AS sql FROM sqlite_master WHERE name = 'step2_plans'")
          .get() as { sql: string }
      ).sql;
      expect(plansSql).toContain("s2_plan_lineage");
      expect(plansSql).toContain("prepare-prompt/v2");
      expect(plansSql).toContain("step2-claims/2");
      const verdictsSql = (
        t.handle.sqlite
          .prepare("SELECT sql AS sql FROM sqlite_master WHERE name = 'step2_draft_validations'")
          .get() as { sql: string }
      ).sql;
      expect(verdictsSql).toContain("s2_verdict_policy");
      expect(verdictsSql).toContain("step2-claims/2");

      // v1 and v2 cycles coexist: both claims policies persist.
      const v1 = await seedS2dAccepted(t.handle, world);
      const v1draft = s2dDraft(v1, [], "Master summary placeholder.", "master");
      const v1saved = s2dSaveDraft(t.handle, v1, v1draft, 0);
      const v1validated = validateDraft(t.handle, {
        jobId: v1.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: v1saved.revision,
          summaryText: "Master summary placeholder.",
          operations: [],
        },
        now: v1.now,
      });
      expect(v1validated.ok).toBe(true);

      const v2 = await seedS2dAcceptedV2(t.handle, world);
      const v2draft = s2dDraftV2(v2, [], "Master summary placeholder.", "master");
      const v2saved = s2dSaveDraftV2(t.handle, v2, v2draft, 0);
      const v2validated = validateDraftV2(t.handle, {
        jobId: v2.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: v2saved.revision,
          summaryText: "Master summary placeholder.",
          summaryOrigin: "master",
          operations: [],
        },
        now: v2.now,
      });
      expect(v2validated.ok).toBe(true);

      const policies = t.handle.sqlite
        .prepare("SELECT DISTINCT policy_version AS policy FROM step2_draft_validations ORDER BY policy")
        .all() as Array<{ policy: string }>;
      expect(policies.map((row) => row.policy)).toEqual(["step2-claims/1", "step2-claims/2"]);
      expect(foreignKeyCheck(t.handle)).toEqual([]);
    });
  });

  it("the lineage guard rejects mixed v1/v2 plan lineage", async () => {
    await withS2dDatabase(async (t, world) => {
      const v1 = await seedS2dAccepted(t.handle, world);
      const stored = t.handle.sqlite
        .prepare("SELECT * FROM step2_plans WHERE id = ?")
        .get(v1.planRowId) as Record<string, unknown>;
      expect(() =>
        t.handle.sqlite
          .prepare(
            `INSERT INTO step2_plans (id, preparation_id, plan_seq, plan_json, plan_hash, provider_id,
              model, prompt_version, proposal_schema_version, claims_policy_version,
              input_hash, proposal_hash, attempt_id, validation_json, supersedes_plan_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId(),
            stored["preparation_id"],
            999,
            stored["plan_json"],
            "e".repeat(64),
            stored["provider_id"],
            null,
            "prepare-prompt/v1",
            "preparation-proposal/v1",
            "step2-claims/2",
            stored["input_hash"],
            stored["proposal_hash"],
            stored["attempt_id"],
            stored["validation_json"],
            null,
            v1.now,
          ),
      ).toThrow(/s2_plan_lineage|CHECK/);
    });
  });
});

describe("S2CPB1 seeded 0010→0011 upgrade", () => {
  it("preserves v1 preparation rows byte-identically, then serves v2", async () => {
    const dir = filteredMigrationsDir("0011_step2_correction_versions.sql");
    const path = join(osTmpdir(), `job-tracker-s2cpb-up-${newId()}.sqlite`);
    const seeded = openDatabase({ path });
    try {
      const first = migrate(seeded.sqlite, { migrationsDir: dir });
      expect(first.applied.at(-1)).toBe("0010_step2_publish_fence");
      const world = seedCrossProfileWorld({ handle: seeded, dir: osTmpdir(), dbPath: path, cleanup: () => {} });

      // A complete v1 cycle under 0010: accepted plan, saved
      // draft, persisted verdict, frozen generation inputs.
      const v1 = await seedS2dAccepted(seeded, world, S2B_JD, s2dNow());
      const summary = v1.plan.positioning.keepMasterSummary;
      const draft = s2dDraft(
        v1,
        [
          {
            op: "add",
            operationId: newId(),
            suggestionId: v1.usableSuggestion.suggestionId,
            roleId: v1.usableSuggestion.roleId,
            editedText: null,
          },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-discovery" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-cadence" },
        ],
        summary,
        "master",
      );
      const { revision } = s2dSaveDraft(seeded, v1, draft, 0);
      const validated = validateDraft(seeded, {
        jobId: v1.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: revision,
          summaryText: summary,
          operations: draft.operations,
        },
        now: v1.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-B upgrade setup validation failed: ${validated.error}`);
      }
      const live = getTailoringJob(seeded, v1.basics.jobId);
      if (live === null) {
        throw new Error("S2-CP-B upgrade setup lost the job");
      }
      const submitted = submitGeneration(
        seeded,
        {
          jobId: v1.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: v1.now,
        },
        { env: S2D_KEYED_ENV },
      );
      if (!submitted.ok) {
        throw new Error(`S2-CP-B upgrade setup submit failed: ${submitted.failure.error}`);
      }
      const before = dumpStep2(seeded);
      expect(before.plans.length).toBe(1);
      expect(before.validations.length).toBeGreaterThan(0);
      expect(before.generationInputs.length).toBe(1);

      const upgrade = migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS });
      expect(upgrade.applied).toEqual(["0011_step2_correction_versions"]);
      expect(dumpStep2(seeded)).toEqual(before);
      expect(foreignKeyCheck(seeded)).toEqual([]);
      expect(migrate(seeded.sqlite, { migrationsDir: REAL_MIGRATIONS }).applied).toEqual([]);

      // The upgraded database serves v2 beside the preserved v1 rows.
      const v2 = await seedS2dAcceptedV2(seeded, world, S2B_JD, s2dNow());
      const v2draft = s2dDraftV2(v2, [], "Master summary placeholder.", "master");
      const v2saved = s2dSaveDraftV2(seeded, v2, v2draft, 0);
      const v2validated = validateDraftV2(seeded, {
        jobId: v2.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: v2saved.revision,
          summaryText: "Master summary placeholder.",
          summaryOrigin: "master",
          operations: [],
        },
        now: v2.now,
      });
      expect(v2validated.ok).toBe(true);
      expect(foreignKeyCheck(seeded)).toEqual([]);
    } finally {
      seeded.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("S2CPB1 immutability triggers", () => {
  it("refuses UPDATE and DELETE on plans, verdicts, and frozen manifests", async () => {
    await withS2dDatabase(async (t, world) => {
      const v2 = await seedS2dAcceptedV2(t.handle, world);
      const summary = v2.plan.positioning.keepMasterSummary;
      const draft = s2dDraftV2(
        v2,
        [
          {
            op: "add",
            operationId: newId(),
            suggestionId: v2.usableSuggestion.suggestionId,
            roleId: v2.usableSuggestion.roleId,
            editedText: null,
          },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-discovery" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-cadence" },
        ],
        summary,
        "master",
      );
      const { revision } = s2dSaveDraftV2(t.handle, v2, draft, 0);
      const validated = validateDraftV2(t.handle, {
        jobId: v2.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: summary,
          summaryOrigin: "master",
          operations: draft.operations,
        },
        now: v2.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-B trigger setup validation failed: ${validated.error}`);
      }
      const live = getTailoringJob(t.handle, v2.basics.jobId);
      if (live === null) {
        throw new Error("S2-CP-B trigger setup lost the job");
      }
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: v2.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: v2.now,
        },
        { env: S2D_KEYED_ENV },
      );
      if (!submitted.ok) {
        throw new Error(`S2-CP-B trigger setup submit failed: ${submitted.failure.error}`);
      }
      expect(() =>
        t.handle.sqlite.prepare("UPDATE step2_plans SET plan_json = plan_json WHERE id = ?").run(v2.planRowId),
      ).toThrow(/PLAN_IMMUTABLE/);
      expect(() =>
        t.handle.sqlite.prepare("DELETE FROM step2_plans WHERE id = ?").run(v2.planRowId),
      ).toThrow(/PLAN_IMMUTABLE/);
      expect(() =>
        t.handle.sqlite
          .prepare("UPDATE step2_draft_validations SET verdict_json = verdict_json WHERE id = ?")
          .run(validated.value.validationId),
      ).toThrow(/VERDICT_IMMUTABLE/);
      expect(() =>
        t.handle.sqlite
          .prepare("DELETE FROM step2_draft_validations WHERE id = ?")
          .run(validated.value.validationId),
      ).toThrow(/VERDICT_IMMUTABLE/);
      const inputs = t.handle.sqlite
        .prepare("SELECT request_id AS requestId FROM step2_generation_inputs")
        .get() as { requestId: string };
      expect(() =>
        t.handle.sqlite
          .prepare("UPDATE step2_generation_inputs SET edited_inputs_json = edited_inputs_json WHERE request_id = ?")
          .run(inputs.requestId),
      ).toThrow(/S2_INPUT_IMMUTABLE/);
      expect(() =>
        t.handle.sqlite
          .prepare("DELETE FROM step2_generation_inputs WHERE request_id = ?")
          .run(inputs.requestId),
      ).toThrow(/S2_INPUT_IMMUTABLE/);
    });
  });
});

describe("S2CPB1 backup, restore, and reset", () => {
  it("a backup archive retains v2 plans, claims/2 verdicts, and v2 frozen inputs", async () => {
    await withS2dDatabase(async (t, world) => {
      const v2 = await seedS2dAcceptedV2(t.handle, world);
      const summary = v2.plan.positioning.keepMasterSummary;
      const draft = s2dDraftV2(
        v2,
        [
          {
            op: "add",
            operationId: newId(),
            suggestionId: v2.usableSuggestion.suggestionId,
            roleId: v2.usableSuggestion.roleId,
            editedText: null,
          },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-discovery" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-cadence" },
        ],
        summary,
        "master",
      );
      const { revision } = s2dSaveDraftV2(t.handle, v2, draft, 0);
      const validated = validateDraftV2(t.handle, {
        jobId: v2.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: summary,
          summaryOrigin: "master",
          operations: draft.operations,
        },
        now: v2.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-B backup setup validation failed: ${validated.error}`);
      }
      const live = getTailoringJob(t.handle, v2.basics.jobId);
      if (live === null) {
        throw new Error("S2-CP-B backup setup lost the job");
      }
      const requestId = newId();
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: v2.basics.jobId,
          requestId,
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: v2.now,
        },
        { env: S2D_KEYED_ENV },
      );
      if (!submitted.ok) {
        throw new Error(`S2-CP-B backup setup submit failed: ${submitted.failure.error}`);
      }
      const livePlan = t.handle.sqlite
        .prepare("SELECT plan_json AS planJson FROM step2_plans WHERE id = ?")
        .get(v2.planRowId) as { planJson: string };
      const liveVerdict = t.handle.sqlite
        .prepare("SELECT verdict_json AS verdictJson FROM step2_draft_validations WHERE id = ?")
        .get(validated.value.validationId) as { verdictJson: string };
      const liveInputs = t.handle.sqlite
        .prepare("SELECT edited_inputs_json AS editedInputsJson FROM step2_generation_inputs WHERE request_id = ?")
        .get(requestId) as { editedInputsJson: string };

      const root = mkdtempSync(join(osTmpdir(), "job-tracker-s2cpb-backup-"));
      try {
        const paths = resolveDataRoot({ APP_DATA_ROOT: root });
        ensureDataRoot(paths);
        const candidateDir = join(root, "candidate");
        mkdirSync(candidateDir, { recursive: true });
        writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
        writeFileSync(join(paths.evidenceDir, "s2cpb-page"), "<html>posting</html>");
        const archive = await createBackupArchive({
          handle: t.handle,
          paths,
          candidateDir,
          stagingDir: join(root, "staging"),
          kind: "manual",
          now: new Date("2026-09-18T12:00:00.000Z"),
        });
        const verified = parseAndVerifyArchive(archive.bytes);
        const stagedPath = join(root, "staged.sqlite");
        writeFileSync(stagedPath, verified.members.get(DATABASE_MEMBER) as Buffer);
        verifyStagedDatabase(() => openDatabase({ path: stagedPath }), resolveMigrationsDir());
        const staged = openDatabase({ path: stagedPath });
        try {
          const keptPlan = staged.sqlite
            .prepare("SELECT plan_json AS planJson FROM step2_plans WHERE id = ?")
            .get(v2.planRowId) as { planJson: string };
          expect(keptPlan.planJson).toBe(livePlan.planJson);
          const keptVerdict = staged.sqlite
            .prepare(
              "SELECT verdict_json AS verdictJson, policy_version AS policyVersion FROM step2_draft_validations WHERE id = ?",
            )
            .get(validated.value.validationId) as { verdictJson: string; policyVersion: string };
          expect(keptVerdict.policyVersion).toBe("step2-claims/2");
          expect(keptVerdict.verdictJson).toBe(liveVerdict.verdictJson);
          const keptInputs = staged.sqlite
            .prepare("SELECT edited_inputs_json AS editedInputsJson FROM step2_generation_inputs WHERE request_id = ?")
            .get(requestId) as { editedInputsJson: string };
          expect(keptInputs.editedInputsJson).toBe(liveInputs.editedInputsJson);
          expect(() =>
            Step2EditedInputsV2.parse(JSON.parse(keptInputs.editedInputsJson) as unknown),
          ).not.toThrow();
          expect(foreignKeyCheck(staged)).toEqual([]);
        } finally {
          staged.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("reset clears job-owned v2 rows while preserving profiles", async () => {
    await withS2dDatabase(async (t, world) => {
      const v2 = await seedS2dAcceptedV2(t.handle, world);
      const { revision } = s2dSaveDraftV2(
        t.handle,
        v2,
        s2dDraftV2(v2, [], "Master summary placeholder.", "master"),
        0,
      );
      const validated = validateDraftV2(t.handle, {
        jobId: v2.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: "Master summary placeholder.",
          summaryOrigin: "master",
          operations: [],
        },
        now: v2.now,
      });
      expect(validated.ok).toBe(true);
      const root = mkdtempSync(join(osTmpdir(), "job-tracker-s2cpb-reset-"));
      try {
        const paths = resolveDataRoot({ APP_DATA_ROOT: root });
        ensureDataRoot(paths);
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
            now: new Date("2026-09-18T12:00:00.000Z"),
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
