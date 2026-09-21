import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate, preflightStep2Upgrade, preflightTailoringUpgrade } from "./migrate";
import * as schema from "./schema";

export type SqliteConnection = InstanceType<typeof Database>;
export type ProductDatabase = BetterSQLite3Database<typeof schema>;

/** Bounded lock wait applied to every product connection. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  /** Filesystem path of the SQLite file, or `:memory:` for volatile use. */
  path: string;
  /** Lock wait in milliseconds; must be a bounded non-negative integer. */
  busyTimeoutMs?: number;
}

export interface DatabaseHandle {
  /** Raw synchronous connection for pragmas, migrations, and transactions. */
  sqlite: SqliteConnection;
  /** Typed Drizzle client sharing the same connection. */
  db: ProductDatabase;
  path: string;
  close(): void;
}

export interface ConnectionStatus {
  foreignKeys: boolean;
  journalMode: string;
  busyTimeoutMs: number;
}

/**
 * Open (creating parent directories) and harden one product connection:
 * foreign keys on, WAL journal, bounded busy timeout. Throws an actionable
 * error without leaking the file handle when a pragma cannot be applied.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60000
  ) {
    throw new RangeError(
      `busyTimeoutMs must be an integer between 0 and 60000, got ${String(options.busyTimeoutMs)}`,
    );
  }
  if (options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const sqlite = new Database(options.path);
  try {
    const journalRows = sqlite.pragma("journal_mode = WAL") as Array<{
      journal_mode: string;
    }>;
    sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    if (options.path !== ":memory:") {
      const journalMode = journalRows[0]?.journal_mode?.toLowerCase();
      if (journalMode !== "wal") {
        throw new Error(
          `SQLite journal mode is ${journalMode ?? "unknown"} instead of wal for ${options.path}`,
        );
      }
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    path: options.path,
    close: () => sqlite.close(),
  };
}

/** Read back the effective connection policy for health checks and tests. */
export function connectionStatus(sqlite: SqliteConnection): ConnectionStatus {
  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) as number;
  const journalRows = sqlite.pragma("journal_mode") as Array<{
    journal_mode: string;
  }>;
  const busyTimeoutMs = sqlite.pragma("busy_timeout", {
    simple: true,
  }) as number;
  return {
    foreignKeys: foreignKeys === 1,
    journalMode: String(journalRows[0]?.journal_mode ?? "").toLowerCase(),
    busyTimeoutMs,
  };
}

export interface EnsureDatabaseOptions extends OpenDatabaseOptions {
  migrationsDir: string;
}

/**
 * Open a database file and apply pending migrations. The second call against
 * the same file applies nothing and verifies applied files are unchanged.
 */
export function ensureDatabase(options: EnsureDatabaseOptions): DatabaseHandle {
  const handle = openDatabase(options);
  try {
    preflightTailoringUpgrade(handle.sqlite, options.migrationsDir);
    preflightStep2Upgrade(handle.sqlite, options.migrationsDir);
    migrate(handle.sqlite, { migrationsDir: options.migrationsDir });
  } catch (error) {
    handle.close();
    throw error;
  }
  return handle;
}
