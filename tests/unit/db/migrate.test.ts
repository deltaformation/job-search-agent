// @vitest-environment node
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverMigrationFiles,
  migrate,
  openDatabase,
  resolveMigrationsDir,
} from "../../../src/db";
import { runWithTestDb } from "./helpers";

describe("migration runner", () => {
  it("discovers the checked-in baseline in lexical order", () => {
    const files = discoverMigrationFiles(resolveMigrationsDir());
    expect(files.map((f) => f.filename)).toEqual([
      "0000_freezing_wild_pack.sql",
      "0001_trigger_guards.sql",
      "0002_candidate_snapshot_dedupe.sql",
    ]);
    for (const file of files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("applies the baseline once and reports a no-op rerun", () => {
    runWithTestDb((t) => {
      // createTestDatabase already migrated; a second run must change nothing.
      const rerun = migrate(t.handle.sqlite, {
        migrationsDir: resolveMigrationsDir(),
      });
      expect(rerun.applied).toEqual([]);
      expect(rerun.alreadyApplied).toHaveLength(3);

      const recorded = t.handle.sqlite
        .prepare("SELECT version, sha256 FROM _schema_migrations ORDER BY version")
        .all() as Array<{ version: string; sha256: string }>;
      expect(recorded).toHaveLength(3);

      const tables = t.handle.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toContain("jobs");
      expect(tables.map((row) => row.name)).toContain("resume_claim_facts");

      const triggers = t.handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all() as Array<{ name: string }>;
      expect(triggers.map((row) => row.name)).toContain(
        "trg_workflow_events_no_update",
      );

      const indexes = t.handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toContain("candidate_snapshots_version_hash");
    });
  });

  it("refuses to run when an applied file changed on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-migrate-"));
    try {
      const source = resolveMigrationsDir();
      for (const file of discoverMigrationFiles(source)) {
        copyFileSync(join(source, file.filename), join(dir, file.filename));
      }
      const handle = openDatabase({ path: join(dir, "scratch.sqlite") });
      try {
        expect(migrate(handle.sqlite, { migrationsDir: dir }).applied).toHaveLength(3);
        writeFileSync(join(dir, "0001_trigger_guards.sql"), "-- tampered\n");
        expect(() => migrate(handle.sqlite, { migrationsDir: dir })).toThrow(
          /drift detected/,
        );
      } finally {
        handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failing file without recording it", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-migrate-"));
    try {
      writeFileSync(join(dir, "0000_good.sql"), "CREATE TABLE t (id TEXT);");
      writeFileSync(
        join(dir, "0001_bad.sql"),
        "CREATE TABLE u (id TEXT);\nTHIS IS NOT SQL;",
      );
      const handle = openDatabase({ path: join(dir, "scratch.sqlite") });
      try {
        expect(() => migrate(handle.sqlite, { migrationsDir: dir })).toThrow(
          /0001_bad/,
        );
        const tables = handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>;
        // The good file committed; the bad file left neither table nor row.
        expect(tables.map((row) => row.name)).toContain("t");
        expect(tables.map((row) => row.name)).not.toContain("u");
        const recorded = handle.sqlite
          .prepare("SELECT version FROM _schema_migrations ORDER BY version")
          .all() as Array<{ version: string }>;
        expect(recorded.map((row) => row.version)).toEqual(["0000_good"]);
      } finally {
        handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly for a missing migrations directory", () => {
    runWithTestDb((t) => {
      expect(() =>
        migrate(t.handle.sqlite, { migrationsDir: join(t.dir, "absent") }),
      ).toThrow(/not readable/);
    });
  });
});
