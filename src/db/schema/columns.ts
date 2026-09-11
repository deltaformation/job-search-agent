import { sql } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";

/**
 * Shared column builders for the R1-B SQLite baseline.
 *
 * Timestamps are UTC ISO-8601 text (`YYYY-MM-DDTHH:MM:SS.SSSZ`). The database
 * default keeps raw SQL inserts honest; application code should still pass
 * explicit values from `utcNow()` so reads never depend on clock/DLL drift.
 */
export const utcNowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function createdAt() {
  return text("created_at").notNull().default(utcNowSql);
}

export function updatedAt() {
  return text("updated_at").notNull().default(utcNowSql);
}
