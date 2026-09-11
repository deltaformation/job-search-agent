/**
 * Per-origin fetch politeness. The worker fetches sequentially, but the
 * same origin can still appear back-to-back across queue items; the
 * throttle inserts a minimum gap between fetches to one origin. State is
 * worker-local memory (no database writes on the fetch path); a restart
 * simply forgets past fetch times, which fails open safely.
 */

export const ORIGIN_MIN_INTERVAL_MS = 2000;

export interface OriginThrottleOptions {
  minIntervalMs?: number;
  /** Millisecond clock; injectable for deterministic tests. */
  now?: () => number;
  /** Sleeper; injectable so tests never wait real time. */
  sleep?: (ms: number) => Promise<void>;
}

export class OriginThrottle {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastFetchAt = new Map<string, number>();

  constructor(options: OriginThrottleOptions = {}) {
    const minIntervalMs = options.minIntervalMs ?? ORIGIN_MIN_INTERVAL_MS;
    if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError(
        `minIntervalMs must be an integer >= 0, got ${String(minIntervalMs)}`,
      );
    }
    this.minIntervalMs = minIntervalMs;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Wait until `origin` may be fetched again, then record this fetch.
   * Origins are exact `scheme://host[:port]` strings from the URL.
   */
  async gate(origin: string): Promise<void> {
    const last = this.lastFetchAt.get(origin);
    if (last !== undefined) {
      const waitMs = last + this.minIntervalMs - this.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
    }
    this.lastFetchAt.set(origin, this.now());
  }
}
