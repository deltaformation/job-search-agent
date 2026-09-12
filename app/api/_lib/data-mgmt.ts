import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../../../src/db/client";
import { migrate } from "../../../src/db/migrate";
import { resolveDataRoot } from "../../../src/security/data-root";
import { resolveCandidateDir } from "../../../src/server/settings";

/**
 * Data-management route plumbing (R5-A). Backup, restore, and reset
 * serialize on one in-process mutex: restore/reset atomically swap the
 * live database file, so a concurrent backup checkpoint or a second
 * swap would read or replace the wrong inode. Cross-process exclusion
 * is out of scope — the local app runs one server process.
 */

let tail: Promise<void> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function resolveMigrationsDir(): string {
  return join(process.cwd(), "drizzle");
}

export function resolveRoutePaths(env: Record<string, string | undefined> = process.env) {
  return {
    paths: resolveDataRoot(env),
    candidateDir: resolveCandidateDir(env),
    migrationsDir: resolveMigrationsDir(),
  };
}

export const openDatabaseAt = (dbPath: string) => openDatabase({ path: dbPath });

export function runMigrationsAt(migrationsDir: string) {
  return (handle: DatabaseHandle) => {
    migrate(handle.sqlite, { migrationsDir });
  };
}
