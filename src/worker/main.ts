/**
 * Worker entrypoint. Opens the supervised database, verifies migrations
 * ran, runs the dispatch loop, then drains it cleanly when SIGINT/SIGTERM
 * arrives. Lifecycle and signal behavior stay here; the handler registry
 * holds SCRAPE (R2-C) and TAILOR (R4-E).
 *
 * Run from the repository root with the TS resolve hook, e.g.:
 * `node --import ./scripts/ts-register.mjs ./src/worker/main.ts`
 */
import { openDatabase, type DatabaseHandle, type SqliteConnection } from "../db/client";
import { runDispatcher } from "../queue/dispatch";
import { closeSharedBrowser, getSharedBrowser } from "../scraping/browser";
import { createScrapeHandler } from "../scraping/handler";
import { OriginThrottle } from "../scraping/throttle";
import { readGeneration } from "../server/backup";
import { createLogger, flushStdio } from "../security/logger";
import { CommandProvider } from "../tailoring/commandAdapter";
import { createTailorHandler } from "../tailoring/handler";
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
 * this referenced interval keeps the event loop (and therefore the
 * process) running alongside the dispatch loop until a shutdown signal
 * arrives.
 */
const HEARTBEAT_MS = 30_000;

export async function main(): Promise<void> {
  const config = resolveWorkerConfig(process.env);
  log.info("starting", {
    workerId: config.workerId,
    databasePath: config.databasePath,
  });
  // Current database handle, swapped in place when a restore/reset
  // bumps the generation marker. better-sqlite3 holds an open file
  // descriptor, so the pre-swap handle keeps reading the OLD inode after
  // the atomic swap; reopening picks up the new database file without a
  // process restart. The in-memory origin throttle is deliberately NOT
  // reset: its only effect is to delay fetches, which stays safe.
  let current: DatabaseHandle = openDatabase({ path: config.databasePath });
  let lastGeneration: string | null = readGeneration(config.root);
  const refreshHandle = (handle: DatabaseHandle): DatabaseHandle => {
    const generation = readGeneration(config.root);
    if (generation === lastGeneration) {
      return handle;
    }
    log.info("database generation changed, reopening handle", {
      workerId: config.workerId,
      previous: lastGeneration,
      current: generation,
    });
    const reopened = openDatabase({ path: config.databasePath });
    try {
      assertMigrated(reopened.sqlite);
    } catch (error: unknown) {
      // The swap is atomic and the staged database was verified before
      // it, so an unmigrated file here means operator interference; keep
      // the old handle (old inode) rather than wedging the dispatcher,
      // and retry on the next tick.
      log.error("reopened database is unmigrated, keeping previous handle", {
        workerId: config.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
      reopened.close();
      return handle;
    }
    handle.close();
    current = reopened;
    lastGeneration = generation;
    return reopened;
  };
  const heartbeat = setInterval(() => {
    log.debug("heartbeat", { workerId: config.workerId });
  }, HEARTBEAT_MS);
  let stopRequested = false;
  try {
    assertMigrated(current.sqlite);
    log.info("dispatch loop running", {
      workerId: config.workerId,
      leaseDurationMs: config.leaseDurationMs,
      pollIntervalMs: config.pollIntervalMs,
    });
    // Playwright resolves its browser registry lazily at launch, so a
    // default exported here still wins over nothing and loses to an
    // explicit environment value.
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= config.playwrightBrowsersPath;
    const throttle = new OriginThrottle();
    const tailorProvider =
      config.tailorProvider === null
        ? null
        : new CommandProvider({
            argv: config.tailorProvider.argv,
            timeoutMs: config.tailorProvider.timeoutMs,
            maxOutputBytes: config.tailorProvider.maxOutputBytes,
            model: config.tailorProvider.model,
          });
    if (tailorProvider === null) {
      log.info("no tailoring provider configured; TAILOR runs will report BLOCKED", {
        workerId: config.workerId,
      });
    }
    const dispatching = runDispatcher({
      handle: current,
      refreshHandle,
      workerId: config.workerId,
      handlers: {
        SCRAPE: createScrapeHandler({
          evidenceDir: config.evidenceDir,
          throttle,
        }),
        TAILOR: createTailorHandler({
          artifactsDir: config.artifactsDir,
          provider: tailorProvider,
          browser: getSharedBrowser,
          ...(config.salaryFallback === null ? {} : { salaryFallback: config.salaryFallback }),
        }),
      },
      leaseDurationMs: config.leaseDurationMs,
      pollIntervalMs: config.pollIntervalMs,
      shouldStop: () => stopRequested,
    });
    let rejectOnDispatchFailure: (error: unknown) => void = () => {};
    const dispatchFailed = new Promise<never>((_resolve, reject) => {
      rejectOnDispatchFailure = reject;
    });
    dispatching.then(
      () => undefined,
      (error: unknown) => rejectOnDispatchFailure(error),
    );
    let signal: NodeJS.Signals;
    try {
      signal = await Promise.race([waitForShutdownSignal(), dispatchFailed]);
    } catch (error: unknown) {
      log.error("dispatcher failed, exiting for supervisor restart", {
        workerId: config.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    log.info("shutting down, draining dispatch loop", {
      workerId: config.workerId,
      signal,
    });
    stopRequested = true;
    const summary = await dispatching;
    log.info("dispatcher drained", {
      workerId: config.workerId,
      signal,
      processed: summary.processed,
      staleRecovered: summary.staleRecovered,
    });
  } finally {
    clearInterval(heartbeat);
    try {
      await closeSharedBrowser();
    } catch (error: unknown) {
      log.error("browser shutdown failed", {
        workerId: config.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    current.close();
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
    log.error("worker exiting with failure", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(() => flushStdio());
