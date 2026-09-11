import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDatabase, type DatabaseHandle } from "./client";

export interface TestDatabase {
  handle: DatabaseHandle;
  /** Isolated temporary directory holding this database file. */
  dir: string;
  dbPath: string;
  cleanup(): void;
}

/**
 * Locate the checked-in migrations. Looks in process.cwd()/drizzle and
 * walks upward if run from a subfolder.
 */
export function resolveMigrationsDir(): string {
  let current = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = join(current, "drizzle");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `SQLite migrations directory not found beneath ${process.cwd()}`,
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
