import { join } from "node:path";
import { DEFAULT_POLL_INTERVAL_MS } from "../queue/dispatch";
import { DEFAULT_LEASE_DURATION_MS } from "../queue/leases";
import {
  resolveRuntimeConfig,
  type RuntimeConfig,
} from "../security/runtime";

/**
 * Worker process configuration. The worker never migrates or creates
 * storage: the supervisor prepares the data root first, and the worker
 * refuses to start against an unmigrated database with an actionable
 * error. Dispatch timing knobs stay here; the handler registry lives at
 * the dispatcher call site in `main.ts` (R2-C/R4 fill it in).
 */

export interface WorkerConfig extends RuntimeConfig {
  workerId: string;
  /** How long one claimed item stays leased before stale recovery. */
  leaseDurationMs: number;
  /** Idle delay between dispatch polls. */
  pollIntervalMs: number;
  /** Playwright browser registry; exported for lazy launch resolution. */
  playwrightBrowsersPath: string;
}

/**
 * Parse a millisecond duration env var in the `parsePort` style: blank
 * means the default, anything else must be a bounded integer.
 */
export function parseDurationMs(
  name: string,
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(
      `${name} must be an integer number of milliseconds, got ${JSON.stringify(value)}`,
    );
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}, got ${parsed}`);
  }
  return parsed;
}

export function resolveWorkerConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
  fallbackPid: number = process.pid,
): WorkerConfig {
  const runtime = resolveRuntimeConfig(env, cwd);
  const workerId = env.WORKER_ID?.trim() || `worker-${fallbackPid}`;
  return {
    ...runtime,
    workerId,
    leaseDurationMs: parseDurationMs(
      "WORKER_LEASE_MS",
      env.WORKER_LEASE_MS,
      DEFAULT_LEASE_DURATION_MS,
      3_600_000,
    ),
    pollIntervalMs: parseDurationMs(
      "WORKER_POLL_MS",
      env.WORKER_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      300_000,
    ),
    playwrightBrowsersPath:
      env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
      join(cwd, ".playwright-browsers"),
  };
}
