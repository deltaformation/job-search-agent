import { z } from "zod";
// File imports (not directory barrels): the worker runs under the
// extensionless-file TS loader, which cannot resolve directory imports.
import type { DatabaseHandle } from "../db/client";
import type { WorkItem } from "../db/schema/queue";
import { utcNow } from "../db/utils";
import {
  AttemptResult,
  type AttemptResult as AttemptResultValue,
  type WorkKind as WorkKindValue,
} from "../domain/enums";
import { createLogger } from "../security/logger";
import { terminalizeExhaustedRun } from "../tailoring/persist";
import { terminalizeExhaustedPreparation } from "../tailoring/prepareHandler";
import {
  claimNextWorkItem,
  completeWorkItem,
  recoverStaleLeases,
  renewLease,
  DEFAULT_LEASE_DURATION_MS,
} from "./leases";

const log = createLogger("queue");

/**
 * Worker dispatch loop. Each tick reclaims expired leases, claims one
 * runnable item for a registered handler kind, runs the handler OUTSIDE
 * any SQLite transaction, then completes the attempt. Kinds without a
 * registered handler are never claimed, so an empty registry (the R2-B
 * worker wiring) safely idles until R2-C registers SCRAPE and R4
 * registers TAILOR.
 *
 * Shutdown is graceful: once `shouldStop()` returns true the loop claims
 * nothing new, finishes the in-flight handler, completes its attempt, and
 * returns. Worst-case stop latency is one poll interval plus the running
 * handler, which owns its own timeouts.
 */

export const DEFAULT_POLL_INTERVAL_MS = 1000;

/** `work_attempts.error_code` when a handler throws or misbehaves. */
export const HANDLER_ERROR = "HANDLER_ERROR";

const MAX_ERROR_DETAIL_CHARS = 4000;

export interface WorkHandlerContext {
  handle: DatabaseHandle;
  /** The claimed item; `leaseToken` is always set on this view. */
  item: WorkItem & { leaseToken: string };
  workerId: string;
  /**
   * Extend the current lease. Long handlers should call this
   * periodically; a false return means the lease was lost and the
   * handler must stop work because its completion will be dropped.
   */
  heartbeat: () => boolean;
  /**
   * Lease length this claim was granted (WO-1.3-F §6). Handlers renew
   * on their own timer during long awaits; absent in synthetic test
   * contexts, where handlers fall back to DEFAULT_LEASE_DURATION_MS.
   */
  leaseDurationMs?: number;
}

export interface HandlerOutcome {
  result: AttemptResultValue;
  errorCode?: string;
  errorDetail?: string;
  inputHash?: string;
  outputHash?: string;
  /**
   * Force terminal failure for FAILED/ERROR even with budget left.
   * Explicit-only failures set this; transients leave it unset so the
   * dispatcher auto-retries per the exhaustion rule.
   */
  terminal?: boolean;
}

export type WorkHandler = (
  context: WorkHandlerContext,
) => Promise<HandlerOutcome>;

export type WorkHandlerRegistry = Partial<
  Record<WorkKindValue, WorkHandler>
>;

export interface DispatcherOptions {
  handle: DatabaseHandle;
  workerId: string;
  handlers: WorkHandlerRegistry;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  /** Clock supplier for timestamps; defaults to real UTC time. */
  clock?: () => string;
  /** Polled before every claim and sleep; true stops after drain. */
  shouldStop?: () => boolean;
  /**
   * Optional per-tick handle refresh (R5-A). Called at the top of every
   * loop iteration with the current handle; return a different handle to
   * swap it (e.g. reopen after a restore/reset swapped the database
   * file). The callback owns closing the replaced handle; the dispatcher
   * never closes handles. Absent means the initial handle is used.
   */
  refreshHandle?: (current: DatabaseHandle) => DatabaseHandle;
}

export interface DispatcherSummary {
  /** Attempts completed by this run (including handler crashes). */
  processed: number;
  /** Stale leases reclaimed across all ticks of this run. */
  staleRecovered: number;
}

const DispatcherInput = z.object({
  workerId: z.string().trim().min(1).max(128),
  leaseDurationMs: z.number().int().positive().max(3_600_000).optional(),
  pollIntervalMs: z.number().int().min(0).max(300_000).optional(),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function truncateDetail(detail: string): string {
  return detail.length > MAX_ERROR_DETAIL_CHARS
    ? detail.slice(0, MAX_ERROR_DETAIL_CHARS)
    : detail;
}

function handlerThrew(error: unknown): HandlerOutcome {
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
  return {
    result: "FAILED",
    errorCode: HANDLER_ERROR,
    errorDetail: truncateDetail(detail),
  };
}

function coerceOutcome(value: unknown): HandlerOutcome {
  const parsed = z
    .object({
      result: AttemptResult,
      errorCode: z.string().max(64).optional(),
      errorDetail: z.string().max(MAX_ERROR_DETAIL_CHARS + 1).optional(),
      inputHash: z.string().max(128).optional(),
      outputHash: z.string().max(128).optional(),
      terminal: z.boolean().optional(),
    })
    .safeParse(value);
  if (!parsed.success) {
    return {
      result: "FAILED",
      errorCode: HANDLER_ERROR,
      errorDetail: `handler returned an invalid outcome: ${parsed.error.message}`,
    };
  }
  const outcome = parsed.data;
  return {
    result: outcome.result,
    errorCode: outcome.errorCode,
    errorDetail:
      outcome.errorDetail === undefined
        ? undefined
        : truncateDetail(outcome.errorDetail),
    inputHash: outcome.inputHash,
    outputHash: outcome.outputHash,
    terminal: outcome.terminal,
  };
}

export async function runDispatcher(
  options: DispatcherOptions,
): Promise<DispatcherSummary> {
  const input = DispatcherInput.parse({
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
    pollIntervalMs: options.pollIntervalMs,
  });
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const clock = options.clock ?? utcNow;
  const shouldStop = options.shouldStop ?? (() => false);
  const kinds = Object.keys(options.handlers) as WorkKindValue[];
  const summary: DispatcherSummary = { processed: 0, staleRecovered: 0 };
  let handle = options.handle;

  while (!shouldStop()) {
    if (options.refreshHandle !== undefined) {
      handle = options.refreshHandle(handle);
    }
    const tickNow = clock();
    const recovered = recoverStaleLeases(handle, { now: tickNow });
    summary.staleRecovered += recovered.recovered;
    if (recovered.recovered > 0) {
      log.info("recovered stale leases", {
        workerId: input.workerId,
        recovered: recovered.recovered,
        requeued: recovered.requeued,
        failed: recovered.failed,
      });
    }
    // §9: TAILOR items recovery finished FAILED leave their job stuck
    // RUNNING (every handler-side terminal path moves it, but the dead
    // worker never ran one). Terminalize each outside the recovery
    // transaction; a moved job is a no-op, never an error.
    for (const item of recovered.exhausted) {
      if (item.kind === "PREPARE" && item.jobId !== null) {
        // Step 2 (S2-A §6.3): the dead worker never ran a terminal
        // move, so record the preparation FAILED here. Writes the
        // preparation row only — never the job row or board status.
        try {
          const terminalized = terminalizeExhaustedPreparation(handle, {
            jobId: item.jobId,
            workItemId: item.workItemId,
            attempts: item.attempts,
            now: clock(),
          });
          if (terminalized.ok && terminalized.terminalized) {
            log.info("terminalized exhausted preparation", {
              workerId: input.workerId,
              workItemId: item.workItemId,
              jobId: item.jobId,
            });
          }
        } catch (error: unknown) {
          log.error("failed to terminalize exhausted preparation", {
            workerId: input.workerId,
            workItemId: item.workItemId,
            jobId: item.jobId,
            detail: (error as Error).message,
          });
        }
        continue;
      }
      if (item.kind !== "TAILOR" || item.jobId === null) {
        continue;
      }
      try {
        const terminalized = terminalizeExhaustedRun(handle, {
          jobId: item.jobId,
          workItemId: item.workItemId,
          attempts: item.attempts,
          now: clock(),
        });
        if (terminalized.ok && terminalized.terminalized) {
          log.info("terminalized exhausted tailor run", {
            workerId: input.workerId,
            workItemId: item.workItemId,
            jobId: item.jobId,
          });
        }
      } catch (error: unknown) {
        log.error("failed to terminalize exhausted tailor run", {
          workerId: input.workerId,
          workItemId: item.workItemId,
          jobId: item.jobId,
          detail: (error as Error).message,
        });
      }
    }
    const item = kinds.length === 0
      ? null
      : claimNextWorkItem(handle, {
        workerId: input.workerId,
        kinds,
        leaseDurationMs,
        now: tickNow,
      });
    if (item === null) {
      await sleep(pollIntervalMs);
      continue;
    }
    const handler = options.handlers[item.kind as WorkKindValue];
    if (handler === undefined) {
      // Unreachable: claim was filtered to registered kinds. Guard
      // anyway so a registry mutation mid-flight cannot wedge the item.
      log.error("claimed item for unregistered kind", {
        workerId: input.workerId,
        workItemId: item.id,
        kind: item.kind,
      });
      completeWorkItem(handle, {
        workItemId: item.id,
        leaseToken: item.leaseToken,
        result: "FAILED",
        errorCode: HANDLER_ERROR,
        errorDetail: `no handler registered for kind ${item.kind}`,
      }, { now: clock() });
      summary.processed += 1;
      continue;
    }
    const heartbeat = (): boolean =>
      renewLease(handle, {
        workItemId: item.id,
        leaseToken: item.leaseToken,
        attemptId: item.currentAttemptId,
        leaseDurationMs,
        now: clock(),
      }).ok;
    let outcome: HandlerOutcome;
    try {
      // Handler work (network, browser, agents) runs here, outside any
      // SQLite transaction, per the R2-B work-order constraint.
      outcome = coerceOutcome(
        await handler({
          handle: handle,
          item: { ...item, leaseToken: item.leaseToken },
          workerId: input.workerId,
          heartbeat,
          leaseDurationMs,
        }),
      );
    } catch (error: unknown) {
      log.error("work handler threw", {
        workerId: input.workerId,
        workItemId: item.id,
        kind: item.kind,
      });
      outcome = handlerThrew(error);
    }
    const completed = completeWorkItem(
      handle,
      {
        workItemId: item.id,
        leaseToken: item.leaseToken,
        attemptId: item.currentAttemptId,
        result: outcome.result,
        errorCode: outcome.errorCode ?? null,
        errorDetail: outcome.errorDetail ?? null,
        inputHash: outcome.inputHash ?? null,
        outputHash: outcome.outputHash ?? null,
      },
      { now: clock(), terminal: outcome.terminal },
    );
    if (!completed.ok) {
      // Benign: the lease expired mid-handler and stale recovery already
      // recorded the attempt and requeued or failed the item.
      log.warn("completion dropped, lease lost mid-handler", {
        workerId: input.workerId,
        workItemId: item.id,
        error: completed.error,
      });
    }
    summary.processed += 1;
  }
  return summary;
}
