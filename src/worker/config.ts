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
  /**
   * Tailoring provider command (R4-E). Null when unconfigured: TAILOR
   * runs report BLOCKED/PROVIDER_UNAVAILABLE until the operator sets
   * `TAILOR_PROVIDER_ARGV` and retries.
   */
  tailorProvider: {
    argv: string[];
    timeoutMs: number;
    maxOutputBytes: number;
    model: string | null;
  } | null;
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

function parseProviderArgv(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("TAILOR_PROVIDER_ARGV must be a JSON array of strings");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length === 0 ||
    decoded.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new Error("TAILOR_PROVIDER_ARGV must be a non-empty JSON array of non-empty strings");
  }
  return [...decoded];
}

function parseByteLimit(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer number of bytes, got ${JSON.stringify(value)}`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 16 * 1024 * 1024) {
    throw new Error(`${name} must be between 1024 and 16777216, got ${parsed}`);
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
  const providerArgv = parseProviderArgv(env.TAILOR_PROVIDER_ARGV);
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
    tailorProvider:
      providerArgv === null
        ? null
        : {
            argv: providerArgv,
            timeoutMs: parseDurationMs(
              "TAILOR_PROVIDER_TIMEOUT_MS",
              env.TAILOR_PROVIDER_TIMEOUT_MS,
              120_000,
              600_000,
            ),
            maxOutputBytes: parseByteLimit(
              "TAILOR_PROVIDER_MAX_OUTPUT_BYTES",
              env.TAILOR_PROVIDER_MAX_OUTPUT_BYTES,
              262_144,
            ),
            model: env.TAILOR_PROVIDER_MODEL?.trim() || null,
          },
  };
}
