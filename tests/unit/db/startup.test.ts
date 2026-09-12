// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureDatabase,
  jobs,
  newId,
  resolveMigrationsDir,
} from "../../../src/db";

describe("database startup", () => {
  it("creates a fresh database, migrates once, and survives restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-startup-"));
    try {
      const dbPath = join(dir, "data", "job-tracker.sqlite");
      const first = ensureDatabase({
        path: dbPath,
        migrationsDir: resolveMigrationsDir(),
      });
      const jobId = newId();
      first.db.insert(jobs).values({ id: jobId, title: "Engineer" }).run();
      first.close();

      // A second startup must not duplicate migrations or lose data.
      const second = ensureDatabase({
        path: dbPath,
        migrationsDir: resolveMigrationsDir(),
      });
      try {
        const recorded = second.sqlite
          .prepare("SELECT version FROM _schema_migrations")
          .all() as Array<{ version: string }>;
        expect(recorded).toHaveLength(4);
        const rows = second.sqlite
          .prepare("SELECT id, title FROM jobs WHERE id = ?")
          .all(jobId) as Array<{ id: string; title: string }>;
        expect(rows).toEqual([{ id: jobId, title: "Engineer" }]);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes the handle when migrations fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-startup-"));
    try {
      expect(() =>
        ensureDatabase({
          path: join(dir, "broken.sqlite"),
          migrationsDir: join(dir, "absent"),
        }),
      ).toThrow(/not readable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
