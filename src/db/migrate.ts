import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SqliteConnection } from "./client";

export interface MigrationFile {
  /** Filename without the `.sql` suffix, e.g. `0000_freezing_wild_pack`. */
  version: string;
  filename: string;
  sql: string;
  sha256: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Live TAILOR work that blocks the 0008 upgrade until drained.
 * Counts only; the preflight never mutates or deletes rows.
 */
export interface LiveTailorWork {
  queued: number;
  running: number;
}

const TAILORING_WORKSPACES_VERSION = "0008_tailoring_workspaces";
const STEP2_PREPARATION_VERSION = "0009_step2_preparation";
const STEP2_CORRECTION_VERSION = "0011_step2_correction_versions";

function hasTable(sqlite: SqliteConnection, name: string): boolean {
  const row = sqlite
    .prepare("SELECT name AS name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * 0008 upgrade preflight (WO-1.3-B, contracts §8): when the
 * tailoring-workspaces migration is still pending, refuse to
 * migrate while TAILOR work is live (QUEUED/RUNNING). Returns the
 * live counts when the upgrade may proceed (always zero while
 * pending; unchecked once 0008 is applied). Throws an actionable
 * error without changing or deleting anything otherwise.
 */
export function preflightTailoringUpgrade(
  sqlite: SqliteConnection,
  migrationsDir: string,
): LiveTailorWork {
  const none = { queued: 0, running: 0 };
  const shipped = discoverMigrationFiles(migrationsDir).some(
    (file) => file.version === TAILORING_WORKSPACES_VERSION,
  );
  if (!shipped || !hasTable(sqlite, "_schema_migrations") || !hasTable(sqlite, "work_items")) {
    return none;
  }
  const applied = sqlite
    .prepare("SELECT version AS version FROM _schema_migrations WHERE version = ?")
    .get(TAILORING_WORKSPACES_VERSION) as { version: string } | undefined;
  if (applied !== undefined) {
    return none;
  }
  const rows = sqlite
    .prepare(
      "SELECT state AS state, COUNT(*) AS count FROM work_items WHERE kind = 'TAILOR' AND state IN ('QUEUED','RUNNING') GROUP BY state",
    )
    .all() as Array<{ state: string; count: number }>;
  const live: LiveTailorWork = { queued: 0, running: 0 };
  for (const row of rows) {
    if (row.state === "QUEUED") {
      live.queued = row.count;
    } else if (row.state === "RUNNING") {
      live.running = row.count;
    }
  }
  if (live.queued > 0 || live.running > 0) {
    throw new Error(
      `upgrade to ${TAILORING_WORKSPACES_VERSION} refused: ${live.queued + live.running} live TAILOR work item(s) (${live.queued} queued, ${live.running} running). ` +
        "Stop the web app and worker, drain or recover the queue explicitly (requeue or cancel through the queue APIs), then restart the upgrade. Nothing was changed or deleted.",
    );
  }
  return live;
}

/**
 * 0009 upgrade preflight (WO-1.3-S2-B, S2-A contracts §3.7): when the
 * step2-preparation migration is still pending, refuse to migrate
 * while ANY work item is RUNNING — a live lease cannot survive the
 * work_items rebuild window honestly. Counts only; throws an
 * actionable error without changing or deleting anything otherwise.
 */
export function preflightStep2Upgrade(sqlite: SqliteConnection, migrationsDir: string): {
  running: number;
} {
  const none = { running: 0 };
  if (!hasTable(sqlite, "_schema_migrations") || !hasTable(sqlite, "work_items")) {
    return none;
  }
  const shipped = new Set(discoverMigrationFiles(migrationsDir).map((file) => file.version));
  // Every pending Step 2 rebuild refuses while any RUNNING work row
  // of any kind exists (0009 introduced the rule; 0011 extends it).
  // Checked oldest-first so the error names the blocking version.
  const pending: string[] = [];
  for (const version of [STEP2_PREPARATION_VERSION, STEP2_CORRECTION_VERSION]) {
    if (!shipped.has(version)) {
      continue;
    }
    const applied = sqlite
      .prepare("SELECT version AS version FROM _schema_migrations WHERE version = ?")
      .get(version) as { version: string } | undefined;
    if (applied === undefined) {
      pending.push(version);
    }
  }
  if (pending.length === 0) {
    return none;
  }
  const row = sqlite
    .prepare("SELECT COUNT(*) AS count FROM work_items WHERE state = 'RUNNING'")
    .get() as { count: number };
  if (row.count > 0) {
    throw new Error(
      `upgrade to ${pending[0]} refused: ${row.count} RUNNING work item(s). ` +
        "Stop the web app and worker, let running work finish or recover its lease explicitly, then restart the upgrade. Nothing was changed or deleted.",
    );
  }
  return none;
}

/**
 * Discover checked-in migrations in lexical filename order, which is defined
 * as apply order (see drizzle/README.md).
 */
export function discoverMigrationFiles(migrationsDir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch (error) {
    throw new Error(
      `SQLite migrations directory is not readable: ${migrationsDir}`,
      { cause: error },
    );
  }
  return entries
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(migrationsDir, filename), "utf8");
      if (sql.trim().length === 0) {
        throw new Error(`SQLite migration is empty: ${filename}`);
      }
      return {
        version: basename(filename, ".sql"),
        filename,
        sql,
        sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
      };
    });
}

/**
 * Apply pending migrations, one synchronous transaction per file. Re-running is
 * a no-op when every file matches its recorded hash; a changed applied file is
 * drift and aborts instead of silently diverging databases.
 *
 * Each file runs with FK enforcement off (SQLite's documented
 * schema-change procedure: table rebuilds drop referenced parents
 * mid-file, which enforcement forbids even when deferred) and a
 * `foreign_key_check` inside the transaction before commit, so a file
 * that genuinely breaks references still fails and rolls back.
 */
export function migrate(
  sqlite: SqliteConnection,
  options: { migrationsDir: string },
): MigrateResult {
  const files = discoverMigrationFiles(options.migrationsDir);
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _schema_migrations (
      version TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  const recorded = sqlite
    .prepare("SELECT version, sha256 FROM _schema_migrations")
    .all() as Array<{ version: string; sha256: string }>;
  const known = new Map(recorded.map((row) => [row.version, row.sha256]));
  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  const insert = sqlite.prepare(
    "INSERT INTO _schema_migrations (version, sha256) VALUES (?, ?)",
  );
  for (const file of files) {
    const expected = known.get(file.version);
    if (expected === undefined) {
      // PRAGMA foreign_keys only toggles outside a transaction.
      sqlite.exec("PRAGMA foreign_keys=OFF");
      try {
        const apply = sqlite.transaction(() => {
          sqlite.exec(file.sql);
          const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
          if (violations.length > 0) {
            throw new Error(
              `SQLite migration ${file.version} breaks ${violations.length} foreign key(s)`,
            );
          }
          insert.run(file.version, file.sha256);
        });
        try {
          apply();
        } catch (error) {
          throw new Error(`SQLite migration ${file.version} failed`, {
            cause: error,
          });
        }
      } finally {
        sqlite.exec("PRAGMA foreign_keys=ON");
      }
      result.applied.push(file.version);
    } else if (expected !== file.sha256) {
      throw new Error(
        `SQLite migration drift detected: ${file.filename} changed after being applied`,
      );
    } else {
      result.alreadyApplied.push(file.version);
    }
  }
  return result;
}
