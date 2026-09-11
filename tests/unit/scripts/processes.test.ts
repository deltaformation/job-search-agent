// @vitest-environment node
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDatabase, openDatabase } from "../../../src/db";

const NODE = process.execPath;
const ROOT = process.cwd();
const LONG_TIMEOUT = 30000;

interface Spawned {
  proc: ChildProcess;
  output: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnCapture(
  argv: string[],
  env: Record<string, string> = {},
  timeoutMs = 15000,
): Spawned {
  const chunks: string[] = [];
  const proc = spawn(argv[0], argv.slice(1), {
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  proc.stdout?.on("data", (data) => chunks.push(String(data)));
  proc.stderr?.on("data", (data) => chunks.push(String(data)));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        rejectExit(new Error(`timed out waiting for exit: ${argv.join(" ")}`));
      }, timeoutMs);
      // 'close' (not 'exit') guarantees stdio is flushed before resolving.
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
      proc.on("error", (error) => {
        clearTimeout(timer);
        rejectExit(error);
      });
    },
  );
  return { proc, output: () => chunks.join(""), exit };
}

async function waitFor(
  spawned: Spawned,
  pattern: RegExp,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(spawned.output())) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${pattern} in:\n${spawned.output()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("migrate CLI", () => {
  it("prepares a fresh data root idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-migrate-cli-"));
    try {
      const root = join(dir, "root");
      for (const run of [1, 2]) {
        const result = spawnSync(
          NODE,
          [join(ROOT, "scripts", "migrate.mjs")],
          {
            cwd: ROOT,
            env: { ...process.env, APP_DATA_ROOT: root },
            encoding: "utf8",
            timeout: 20000,
          },
        );
        expect(result.status, `run ${run}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("database ready");
      }
      expect(existsSync(join(root, "evidence"))).toBe(true);
      expect(existsSync(join(root, "artifacts"))).toBe(true);
      const handle = openDatabase({ path: join(root, "job-tracker.sqlite") });
      try {
        const tables = handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toContain("jobs");
      } finally {
        handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly on invalid runtime config", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-tracker-migrate-cli-"));
    try {
      const result = spawnSync(NODE, [join(ROOT, "scripts", "migrate.mjs")], {
        cwd: ROOT,
        env: { ...process.env, APP_DATA_ROOT: dir, PORT: "bogus" },
        encoding: "utf8",
        timeout: 20000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/PORT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker lifecycle", () => {
  it(
    "starts against a migrated database and shuts down cleanly on SIGTERM",
    async () => {
      const t = createTestDatabase();
      const spawned = spawnCapture(
        [
          NODE,
          "--import",
          "./scripts/ts-register.mjs",
          "./src/worker/main.ts",
        ],
        {
          APP_DATA_ROOT: t.dir,
          DATABASE_PATH: t.dbPath,
          WORKER_ID: "worker-test",
        },
      );
      try {
        // R2-B replaced the idle wait with the dispatch loop; readiness is
        // the loop running, and shutdown must drain it before exiting.
        await waitFor(spawned, /dispatch loop running/);
        spawned.proc.kill("SIGTERM");
        const { code, signal } = await spawned.exit;
        expect(code === 0 || signal === "SIGTERM").toBe(true);
        if (code === 0) {
          expect(spawned.output()).toContain("shutting down");
          expect(spawned.output()).toContain("dispatcher drained");
        }
      } finally {
        try {
          spawned.proc.kill("SIGKILL");
        } catch {
          // Exited already.
        }
        t.cleanup();
      }
    },
    LONG_TIMEOUT,
  );

  it(
    "refuses an unmigrated database with an actionable error",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "job-tracker-worker-"));
      try {
        const spawned = spawnCapture(
          [
            NODE,
            "--import",
            "./scripts/ts-register.mjs",
            "./src/worker/main.ts",
          ],
          {
            APP_DATA_ROOT: dir,
            DATABASE_PATH: join(dir, "fresh.sqlite"),
            WORKER_ID: "worker-test",
          },
        );
        const { code } = await spawned.exit;
        expect(code).toBe(1);
        expect(spawned.output()).toMatch(/migrations/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    LONG_TIMEOUT,
  );
});

describe("supervisor policy", () => {
  it(
    "stops every child and exits 1 when one crashes",
    async () => {
      const spawned = spawnCapture(
        [
          NODE,
          join(ROOT, "scripts", "supervise.mjs"),
          "--name",
          "fail",
          NODE,
          "-e",
          "process.exit(3)",
          "--name",
          "sleeper",
          NODE,
          "-e",
          "setInterval(() => {}, 1000)",
        ],
        { SUPERVISOR_GRACE_MS: "1000" },
      );
      const { code } = await spawned.exit;
      expect(code).toBe(1);
      expect(spawned.output()).toContain("fail exited with code 3");
    },
    LONG_TIMEOUT,
  );

  it(
    "forwards SIGTERM and exits 0 when children stop cleanly",
    async () => {
      const spawned = spawnCapture(
        [
          NODE,
          join(ROOT, "scripts", "supervise.mjs"),
          "--name",
          "one",
          NODE,
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
          "--name",
          "two",
          NODE,
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
        ],
        { SUPERVISOR_GRACE_MS: "2000" },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        spawned.proc.kill("SIGTERM");
        const { code } = await spawned.exit;
        expect(code).toBe(0);
        expect(spawned.output()).toContain("received SIGTERM");
        expect(spawned.output()).toContain("stopped cleanly");
      } finally {
        try {
          spawned.proc.kill("SIGKILL");
        } catch {
          // Exited already.
        }
      }
    },
    LONG_TIMEOUT,
  );

  it("exits 2 on usage errors", () => {
    const result = spawnSync(NODE, [join(ROOT, "scripts", "supervise.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage/);
  });
});
