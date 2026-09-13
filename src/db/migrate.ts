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
