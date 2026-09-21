// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/db";

const NODE = process.execPath;
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "import-candidate.mjs");
const FIXTURE = join(ROOT, "tests", "fixtures", "candidate", "master-resume.v1.json");

function runCli(args: string[], dataRoot: string) {
  return spawnSync(NODE, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, APP_DATA_ROOT: dataRoot },
    encoding: "utf8",
    timeout: 30000,
  });
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "job-tracker-import-cli-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("import-candidate CLI", () => {
  it("imports the fixture and activates on request", () => {
    withTempDir((dir) => {
      const root = join(dir, "root");
      const result = runCli([FIXTURE, "--activate"], root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/imported profile version 1/);
      expect(result.stdout).toMatch(/6 inserted, 0 reused/);
      expect(result.stdout).toMatch(/activated version 1/);
      const handle = openDatabase({ path: join(root, "job-tracker.sqlite") });
      try {
        const versions = handle.sqlite
          .prepare("SELECT version, activated_at FROM candidate_profile_versions")
          .all() as Array<{ version: number; activated_at: string | null }>;
        expect(versions).toHaveLength(1);
        expect(versions[0].activated_at).not.toBeNull();
        const facts = handle.sqlite
          .prepare("SELECT COUNT(*) AS n FROM candidate_facts")
          .get() as { n: number };
        expect(facts.n).toBe(6);
      } finally {
        handle.close();
      }
    });
  });

  it("no-ops an identical second import without activating (R-ADR-012)", () => {
    withTempDir((dir) => {
      const root = join(dir, "root");
      expect(runCli([FIXTURE], root).status).toBe(0);
      const second = runCli([FIXTURE, "--json"], root);
      expect(second.status, second.stderr).toBe(0);
      const parsed = JSON.parse(second.stdout) as {
        ok: boolean;
        version: number;
        activated: boolean;
        alreadyCurrent: boolean;
        insertedFacts: unknown[];
        reusedFacts: unknown[];
      };
      // Unchanged re-imports stay a no-op per R-ADR-012 (the CLI used to
      // bypass resync and mint empty versions; WO-1.2-B routes it
      // through the shared orchestrator).
      expect(parsed.ok).toBe(true);
      expect(parsed.version).toBe(1);
      expect(parsed.alreadyCurrent).toBe(true);
      expect(parsed.activated).toBe(false);
      expect(parsed.insertedFacts).toEqual([]);
      expect(parsed.reusedFacts).toEqual([]);
    });
  });

  it("fails clearly on usage errors, unreadable files, and bad JSON", () => {
    withTempDir((dir) => {
      const root = join(dir, "root");
      const usage = runCli([], root);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain("usage:");
      const missing = runCli([join(dir, "nope.json")], root);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("cannot read import file");
      const badJson = join(dir, "bad.json");
      writeFileSync(badJson, "{oops");
      const invalid = runCli([badJson], root);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("not valid JSON");
    });
  });

  it("rejects schema violations without storing a version", () => {
    withTempDir((dir) => {
      const root = join(dir, "root");
      const badSchema = join(dir, "bad-schema.json");
      writeFileSync(badSchema, JSON.stringify({ schemaVersion: "candidate-import/v1" }));
      const result = runCli([badSchema], root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("failed schema validation");
      const handle = openDatabase({ path: join(root, "job-tracker.sqlite") });
      try {
        const versions = handle.sqlite
          .prepare("SELECT COUNT(*) AS n FROM candidate_profile_versions")
          .get() as { n: number };
        expect(versions.n).toBe(0);
      } finally {
        handle.close();
      }
    });
  });
});
