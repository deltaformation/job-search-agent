import type { SqliteConnection } from "./client";

/**
 * Run `fn` inside a short synchronous transaction and return its result.
 *
 * Nest-safe: when already inside a transaction the callback runs directly so
 * helpers compose without savepoint bookkeeping. The callback must be
 * synchronous and short — never `await` network, browser, agent, rendering,
 * or filesystem work inside it. A throw rolls the transaction back.
 */
export function withTransaction<T>(
  sqlite: SqliteConnection,
  fn: () => T,
): T {
  if (sqlite.inTransaction) {
    return fn();
  }
  return sqlite.transaction(fn)();
}
