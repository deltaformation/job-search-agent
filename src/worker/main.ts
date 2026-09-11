/**
 * Worker entrypoint. Opens the supervised database, verifies migrations
 * ran, runs the R2-B dispatch loop, then drains it cleanly when
 * SIGINT/SIGTERM arrives. Lifecycle and signal behavior stay here; the
 * handler registry is filled in by later milestones (R2-C: SCRAPE,
 * R4: TAILOR) and stays empty until then.
 *
 * Run from the repository root with the TS resolve hook, e.g.:
 * `node --import ./scripts/ts-register.mjs ./src/worker/main.ts`
 */
import { openDatabase, type SqliteConnection } from "../db/client";
import { runDispatcher } from "../queue/dispatch";
import { closeSharedBrowser } from "../scraping/browser";
import { createScrapeHandler } from "../scraping/handler";
import { OriginThrottle } from "../scraping/throttle";
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
  const handle = openDatabase({ path: config.databasePath });
  const heartbeat = setInterval(() => {
    log.debug("heartbeat", { workerId: config.workerId });
  }, HEARTBEAT_MS);
  let stopRequested = false;
  try {
    assertMigrated(handle.sqlite);
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
    const dispatching = runDispatcher({
      handle,
      workerId: config.workerId,
      // R2-C registers SCRAPE; R4 registers TAILOR.
      handlers: {
        SCRAPE: createScrapeHandler({
          evidenceDir: config.evidenceDir,
          throttle,
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
    log.error("worker exiting with failure", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(() => flushStdio());
