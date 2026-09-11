import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDatabase, type DatabaseHandle } from "./client";

export interface TestDatabase {
  handle: DatabaseHandle;
  /** Isolated temporary directory holding this database file. */
  dir: string;
  dbPath: string;
  cleanup(): void;
}

/**
 * Locate the checked-in migrations. Prefers the caller's working directory
 * (the repository root under tests and scripts) and falls back to the path
 * relative to this module.
 */
export function resolveMigrationsDir(): string {
  const candidates = [
    join(process.cwd(), "drizzle"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `SQLite migrations directory not found (tried ${candidates.join(", ")})`,
  );
}

/**
 * Create an isolated migrated database under a fresh temporary directory.
 * Tests must call `cleanup()` (which closes before deleting) so no file
 * handle or temp directory leaks between tests.
 */
export function createTestDatabase(
  prefix = "job-tracker-test-",
): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, "test.sqlite");
  const handle = ensureDatabase({
    path: dbPath,
    migrationsDir: resolveMigrationsDir(),
  });
  return {
    handle,
    dir,
    dbPath,
    cleanup: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
