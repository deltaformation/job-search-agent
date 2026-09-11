/**
 * Deterministic retry backoff for queued work. Pure and clock-free: callers
 * pass the failed attempt number and add the returned delay to their own
 * timestamp. Exponential growth is capped so a poison pill waits minutes,
 * not hours, before its final bounded attempt.
 */

export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_MAX_MS = 300_000;

export interface BackoffOptions {
  /** Delay before the second attempt; doubled per attempt. Must be >= 0. */
  baseMs?: number;
  /** Hard ceiling for any computed delay. Must be >= 0. */
  maxMs?: number;
}

/**
 * Delay in milliseconds before re-running a failed attempt. Attempt numbers
 * start at 1; values below 1 throw because they indicate a caller bug.
 */
export function computeBackoffMs(
  failedAttemptNumber: number,
  options: BackoffOptions = {},
): number {
  if (!Number.isInteger(failedAttemptNumber) || failedAttemptNumber < 1) {
    throw new RangeError(
      `failedAttemptNumber must be an integer >= 1, got ${String(failedAttemptNumber)}`,
    );
  }
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  if (!Number.isInteger(baseMs) || baseMs < 0) {
    throw new RangeError(`baseMs must be an integer >= 0, got ${String(baseMs)}`);
  }
  if (!Number.isInteger(maxMs) || maxMs < 0) {
    throw new RangeError(`maxMs must be an integer >= 0, got ${String(maxMs)}`);
  }
  return Math.min(baseMs * 2 ** (failedAttemptNumber - 1), maxMs);
}
