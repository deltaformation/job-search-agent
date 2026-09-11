// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  workAttempts,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import {
  HANDLER_ERROR,
  LEASE_EXPIRED,
  recoverStaleLeases,
  runDispatcher,
  type HandlerOutcome,
  type WorkHandler,
} from "../../../src/queue";

const T0 = "2026-09-11T12:00:00.000Z";

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function seedItem(
  handle: DatabaseHandle,
  overrides: Partial<typeof workItems.$inferInsert> = {},
): string {
  const id = newId();
  handle.db
    .insert(workItems)
    .values({
      id,
      kind: "SCRAPE",
      idempotencyKey: `key-${id}`,
      ...overrides,
    })
    .run();
  return id;
}

function getItem(handle: DatabaseHandle, id: string) {
  return handle.db
    .select()
    .from(workItems)
    .where(eq(workItems.id, id))
    .get();
}

function attemptsFor(handle: DatabaseHandle, workItemId: string) {
  return handle.db
    .select()
    .from(workAttempts)
    .where(eq(workAttempts.workItemId, workItemId))
    .all();
}

async function withAsyncDatabase(
  fn: (t: TestDatabase) => Promise<void>,
): Promise<void> {
  const t = createTestDatabase("job-tracker-dispatch-test-");
  try {
    await fn(t);
  } finally {
    t.cleanup();
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for dispatcher state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("dispatcher", () => {
  it("runs a registered handler and completes the attempt", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle);
      let stop = false;
      let seenWorker = "";
      const handler: WorkHandler = async (context) => {
        expect(context.item.id).toBe(id);
        expect(context.item.leaseToken).toBeTruthy();
        seenWorker = context.workerId;
        stop = true;
        return { result: "SUCCEEDED", outputHash: "out-1" };
      };
      const summary = await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: { SCRAPE: handler },
        pollIntervalMs: 1,
        shouldStop: () => stop,
      });
      expect(summary.processed).toBe(1);
      expect(seenWorker).toBe("worker-a");
      expect(getItem(t.handle, id)?.state).toBe("SUCCEEDED");
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        result: "SUCCEEDED",
        outputHash: "out-1",
      });
    });
  });

  it("claims nothing while the registry is empty", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle);
      let stop = false;
      setTimeout(() => {
        stop = true;
      }, 25);
      const summary = await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: {},
        pollIntervalMs: 1,
        shouldStop: () => stop,
      });
      expect(summary).toEqual({ processed: 0, staleRecovered: 0 });
      expect(getItem(t.handle, id)?.state).toBe("QUEUED");
    });
  });

  it("converts handler throws into failed attempts with backoff", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle, { maxAttempts: 2 });
      let stop = false;
      const handler: WorkHandler = async () => {
        stop = true;
        throw new Error("boom");
      };
      const summary = await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: { SCRAPE: handler },
        pollIntervalMs: 1,
        shouldStop: () => stop,
      });
      expect(summary.processed).toBe(1);
      expect(getItem(t.handle, id)?.state).toBe("QUEUED");
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        result: "FAILED",
        errorCode: HANDLER_ERROR,
      });
      expect(attempts[0]?.errorDetail).toContain("boom");
    });
  });

  it("converts invalid handler outcomes into handler errors", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle, { maxAttempts: 1 });
      let stop = false;
      const handler: WorkHandler = async () => {
        stop = true;
        return { result: "BOGUS" } as unknown as HandlerOutcome;
      };
      await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: { SCRAPE: handler },
        pollIntervalMs: 1,
        shouldStop: () => stop,
      });
      // maxAttempts 1: the invalid outcome fails the item terminally.
      expect(getItem(t.handle, id)?.state).toBe("FAILED");
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        result: "FAILED",
        errorCode: HANDLER_ERROR,
      });
    });
  });

  it("reclaims stale leases on every tick", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle, {
        state: "RUNNING",
        leaseToken: newId(),
        leasedAt: T0,
        leaseExpiresAt: plus(T0, 60_000),
        workerId: "worker-gone",
        attemptCount: 1,
        maxAttempts: 3,
      });
      let stop = false;
      setTimeout(() => {
        stop = true;
      }, 25);
      const summary = await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: {},
        pollIntervalMs: 1,
        clock: () => plus(T0, 61_000),
        shouldStop: () => stop,
      });
      expect(summary.staleRecovered).toBe(1);
      expect(getItem(t.handle, id)?.state).toBe("QUEUED");
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.errorCode).toBe(LEASE_EXPIRED);
    });
  });

  it("drains the in-flight handler before stopping", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle);
      let stop = false;
      let releaseHandler: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const handler: WorkHandler = async () => {
        await gate;
        return { result: "SUCCEEDED" };
      };
      const running = runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: { SCRAPE: handler },
        pollIntervalMs: 1,
        shouldStop: () => stop,
      });
      await waitFor(() => getItem(t.handle, id)?.state === "RUNNING");
      stop = true;
      releaseHandler();
      const summary = await running;
      expect(summary.processed).toBe(1);
      expect(getItem(t.handle, id)?.state).toBe("SUCCEEDED");
      expect(attemptsFor(t.handle, id)).toHaveLength(1);
    });
  });

  it("drops completions whose lease died mid-handler", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle, { maxAttempts: 3 });
      let now = T0;
      let stop = false;
      const handler: WorkHandler = async (context) => {
        // Simulate another worker's reaper firing while we work: the
        // lease expires, recovery records the attempt and requeues.
        now = plus(T0, 61_000);
        recoverStaleLeases(context.handle, { now });
        stop = true;
        return { result: "SUCCEEDED" };
      };
      const summary = await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: { SCRAPE: handler },
        leaseDurationMs: 60_000,
        pollIntervalMs: 1,
        clock: () => now,
        shouldStop: () => stop,
      });
      expect(summary.processed).toBe(1);
      // Recovery owns the item now; our orphaned SUCCEEDED wrote nothing.
      expect(getItem(t.handle, id)?.state).toBe("QUEUED");
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.errorCode).toBe(LEASE_EXPIRED);
    });
  });

  it("lets long handlers extend the lease with a heartbeat", async () => {
    await withAsyncDatabase(async (t) => {
      const id = seedItem(t.handle);
      let now = T0;
      let stop = false;
      let heartbeatResult = false;
      const handler: WorkHandler = async (context) => {
        now = plus(T0, 10_000);
        heartbeatResult = context.heartbeat();
        stop = true;
        return { result: "SUCCEEDED" };
      };
      await runDispatcher({
        handle: t.handle,
        workerId: "worker-a",
        handlers: { SCRAPE: handler },
        leaseDurationMs: 60_000,
        pollIntervalMs: 1,
        clock: () => now,
        shouldStop: () => stop,
      });
      expect(heartbeatResult).toBe(true);
      // Expiry moved from T0+60s to (T0+10s)+60s; the last-lease record
      // survives completion for forensics.
      expect(getItem(t.handle, id)).toMatchObject({
        state: "SUCCEEDED",
        leaseExpiresAt: plus(T0, 70_000),
      });
      expect(attemptsFor(t.handle, id)).toHaveLength(1);
    });
  });
});
