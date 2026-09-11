/**
 * Worker entrypoint (R1 lifecycle stub). Opens the supervised database,
 * verifies migrations ran, logs readiness, then idles until SIGINT/SIGTERM
 * triggers a clean close. R2-B adds queue dispatch inside the running
 * section; lifecycle and signal behavior stay here.
 *
 * Run from the repository root with the TS resolve hook, e.g.:
 * `node --import ./scripts/ts-register.mjs ./src/worker/main.ts`
 */
import { openDatabase, type SqliteConnection } from "../db/client";
import { createLogger, flushStdio } from "../security/logger";
import { resolveWorkerConfig } from "./config";

const log = createLogger("worker");

export function assertMigrated(sqlite: SqliteConnection): void {
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
    )
    .get() as { count: number };
  if (row.count !== 1) {
    throw new Error(
      "database is missing product tables; the supervisor must run migrations before starting the worker",
    );
  }
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolveSignal) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => resolveSignal(signal));
    }
  });
}

/**
 * Liveness timer. Besides proving the worker is alive in supervised logs,
 * this referenced interval is what keeps the event loop (and therefore the
 * process) running until a shutdown signal arrives — without it Node would
 * drain the loop and exit right after the ready line. R2-B replaces the
 * idle wait with the real dispatch loop.
 */
const HEARTBEAT_MS = 30_000;

export async function main(): Promise<void> {
  const config = resolveWorkerConfig(process.env);
  log.info("starting", {
    workerId: config.workerId,
    databasePath: config.databasePath,
  });
  const handle = openDatabase({ path: config.databasePath });
  const heartbeat = setInterval(() => {
    log.debug("heartbeat", { workerId: config.workerId });
  }, HEARTBEAT_MS);
  try {
    assertMigrated(handle.sqlite);
    log.info("ready, waiting for dispatch work (R2-B)", {
      workerId: config.workerId,
    });
    const signal = await waitForShutdownSignal();
    log.info("shutting down", { workerId: config.workerId, signal });
  } finally {
    clearInterval(heartbeat);
    handle.close();
  }
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection, exiting", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  process.exitCode = 1;
  void flushStdio();
});

main()
  .catch((error: unknown) => {
    log.error("worker failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(() => flushStdio());
