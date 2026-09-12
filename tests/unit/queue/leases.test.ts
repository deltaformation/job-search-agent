// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  openDatabase,
  workAttempts,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import {
  claimNextWorkItem,
  completeWorkItem,
  LEASE_EXPIRED,
  recoverStaleLeases,
  renewLease,
  requeueWorkItem,
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

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-queue-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

describe("queue claim", () => {
  it("returns null when nothing is queued", () => {
    withDatabase((t) => {
      expect(
        claimNextWorkItem(t.handle, {
          workerId: "worker-a",
          leaseDurationMs: 60_000,
          now: T0,
        }),
      ).toBeNull();
    });
  });

  it("claims the oldest runnable item and stamps the lease", () => {
    withDatabase((t) => {
      const first = seedItem(t.handle, { createdAt: T0 });
      seedItem(t.handle, { createdAt: plus(T0, 1000) });
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: plus(T0, 2000),
      });
      expect(claimed?.id).toBe(first);
      expect(claimed).toMatchObject({
        state: "RUNNING",
        workerId: "worker-a",
        leasedAt: plus(T0, 2000),
        leaseExpiresAt: plus(T0, 62_000),
        attemptCount: 1,
      });
      expect(claimed?.leaseToken).toBeTruthy();
      // A second claim takes the other item, never the leased one.
      const second = claimNextWorkItem(t.handle, {
        workerId: "worker-b",
        leaseDurationMs: 60_000,
        now: plus(T0, 2000),
      });
      expect(second?.id).not.toBe(first);
      expect(
        claimNextWorkItem(t.handle, {
          workerId: "worker-c",
          leaseDurationMs: 60_000,
          now: plus(T0, 2000),
        }),
      ).toBeNull();
    });
  });

  it("serializes claims across two connections on one file", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle);
      const second = openDatabase({ path: t.dbPath });
      try {
        const fromFirst = claimNextWorkItem(t.handle, {
          workerId: "worker-a",
          leaseDurationMs: 60_000,
          now: T0,
        });
        const fromSecond = claimNextWorkItem(second, {
          workerId: "worker-b",
          leaseDurationMs: 60_000,
          now: T0,
        });
        expect(fromFirst?.id).toBe(id);
        expect(fromSecond).toBeNull();
        expect(getItem(t.handle, id)?.attemptCount).toBe(1);
      } finally {
        second.close();
      }
    });
  });

  it("filters by kind and honors next_run_at", () => {
    withDatabase((t) => {
      seedItem(t.handle, { kind: "SCRAPE", createdAt: T0 });
      const tailor = seedItem(t.handle, {
        kind: "TAILOR",
        createdAt: plus(T0, 1000),
      });
      seedItem(t.handle, {
        kind: "TAILOR",
        createdAt: plus(T0, 2000),
        nextRunAt: plus(T0, 600_000),
      });
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        kinds: ["TAILOR"],
        leaseDurationMs: 60_000,
        now: plus(T0, 3000),
      });
      expect(claimed?.id).toBe(tailor);
      // Nothing else runnable for TAILOR: the future item waits.
      expect(
        claimNextWorkItem(t.handle, {
          workerId: "worker-a",
          kinds: ["TAILOR"],
          leaseDurationMs: 60_000,
          now: plus(T0, 3000),
        }),
      ).toBeNull();
      // An empty kind list claims nothing even with work waiting.
      expect(
        claimNextWorkItem(t.handle, {
          workerId: "worker-a",
          kinds: [],
          leaseDurationMs: 60_000,
          now: plus(T0, 3000),
        }),
      ).toBeNull();
    });
  });

  it("rejects invalid claim input", () => {
    withDatabase((t) => {
      seedItem(t.handle);
      expect(() =>
        claimNextWorkItem(t.handle, {
          workerId: "  ",
          leaseDurationMs: 60_000,
        }),
      ).toThrow();
      expect(() =>
        claimNextWorkItem(t.handle, {
          workerId: "worker-a",
          leaseDurationMs: 0,
        }),
      ).toThrow();
      expect(() =>
        claimNextWorkItem(t.handle, {
          workerId: "worker-a",
          leaseDurationMs: 60_000,
          now: "not-a-timestamp",
        }),
      ).toThrow();
    });
  });
});

describe("queue lease renewal", () => {
  it("extends a live lease and refuses foreign or dead ones", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle);
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      expect(claimed?.id).toBe(id);
      const renewed = renewLease(t.handle, {
        workItemId: id,
        leaseToken: claimed?.leaseToken ?? "",
        leaseDurationMs: 120_000,
        now: plus(T0, 10_000),
      });
      expect(renewed).toEqual({
        ok: true,
        leaseExpiresAt: plus(T0, 130_000),
      });
      expect(
        renewLease(t.handle, {
          workItemId: id,
          leaseToken: "someone-elses-token",
          leaseDurationMs: 60_000,
          now: plus(T0, 10_000),
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
      const completed = completeWorkItem(
        t.handle,
        {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          result: "SUCCEEDED",
        },
        { now: plus(T0, 20_000) },
      );
      expect(completed.ok).toBe(true);
      expect(
        renewLease(t.handle, {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          leaseDurationMs: 60_000,
          now: plus(T0, 30_000),
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
    });
  });
});

describe("queue completion", () => {
  it("records success with hashes and clears the lease", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle);
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      const finishedAt = plus(T0, 5000);
      const result = completeWorkItem(
        t.handle,
        {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          result: "SUCCEEDED",
          inputHash: "in",
          outputHash: "out",
        },
        { now: finishedAt },
      );
      expect(result).toEqual({
        ok: true,
        state: "SUCCEEDED",
        attemptNumber: 1,
        nextRunAt: null,
      });
      expect(getItem(t.handle, id)).toMatchObject({
        state: "SUCCEEDED",
        leaseToken: null,
        workerId: null,
        nextRunAt: null,
      });
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptNumber: 1,
        workerId: "worker-a",
        startedAt: T0,
        finishedAt,
        result: "SUCCEEDED",
        inputHash: "in",
        outputHash: "out",
      });
    });
  });

  it("makes duplicate completion a safe no-op", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle);
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      const token = claimed?.leaseToken ?? "";
      expect(
        completeWorkItem(
          t.handle,
          { workItemId: id, leaseToken: token, result: "SUCCEEDED" },
          { now: plus(T0, 1000) },
        ).ok,
      ).toBe(true);
      expect(
        completeWorkItem(
          t.handle,
          { workItemId: id, leaseToken: token, result: "SUCCEEDED" },
          { now: plus(T0, 2000) },
        ),
      ).toEqual({ ok: false, error: "lease-lost" });
      expect(attemptsFor(t.handle, id)).toHaveLength(1);
    });
  });

  it("requeues failures with backoff while attempts remain", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle, { maxAttempts: 3 });
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      const failedAt = plus(T0, 5000);
      const result = completeWorkItem(
        t.handle,
        {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          result: "FAILED",
          errorCode: "TIMEOUT",
          errorDetail: "fetch timed out",
        },
        { now: failedAt },
      );
      expect(result).toEqual({
        ok: true,
        state: "QUEUED",
        attemptNumber: 1,
        nextRunAt: plus(failedAt, 30_000),
      });
      expect(getItem(t.handle, id)).toMatchObject({
        state: "QUEUED",
        leaseToken: null,
        attemptCount: 1,
      });
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        result: "FAILED",
        errorCode: "TIMEOUT",
        errorDetail: "fetch timed out",
      });
      // The requeued item is claimable again once its backoff elapses.
      expect(
        claimNextWorkItem(t.handle, {
          workerId: "worker-b",
          leaseDurationMs: 60_000,
          now: plus(failedAt, 30_000),
        })?.id,
      ).toBe(id);
    });
  });

  it("fails terminally once attempts are exhausted", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle, { maxAttempts: 1 });
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      const result = completeWorkItem(
        t.handle,
        {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          result: "FAILED",
          errorCode: "TIMEOUT",
        },
        { now: plus(T0, 1000) },
      );
      expect(result).toEqual({
        ok: true,
        state: "FAILED",
        attemptNumber: 1,
        nextRunAt: null,
      });
    });
  });

  it("maps blocked attempts to a failed item without losing the block", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle, { maxAttempts: 3 });
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      const result = completeWorkItem(
        t.handle,
        {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          result: "BLOCKED",
          errorCode: "LOGIN_REQUIRED",
        },
        { now: plus(T0, 1000) },
      );
      expect(result).toMatchObject({ ok: true, state: "FAILED" });
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        result: "BLOCKED",
        errorCode: "LOGIN_REQUIRED",
      });
    });
  });

  it("rejects foreign tokens and unknown items without writing", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle);
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-a",
        leaseDurationMs: 60_000,
        now: T0,
      });
      expect(claimed?.id).toBe(id);
      expect(
        completeWorkItem(
          t.handle,
          { workItemId: id, leaseToken: "wrong", result: "SUCCEEDED" },
          { now: plus(T0, 1000) },
        ),
      ).toEqual({ ok: false, error: "lease-lost" });
      expect(
        completeWorkItem(
          t.handle,
          { workItemId: newId(), leaseToken: "wrong", result: "SUCCEEDED" },
          { now: plus(T0, 1000) },
        ),
      ).toEqual({ ok: false, error: "unknown-item" });
      expect(getItem(t.handle, id)?.state).toBe("RUNNING");
      expect(attemptsFor(t.handle, id)).toHaveLength(0);
    });
  });
});

describe("stale lease recovery", () => {
  function seedRunning(
    handle: DatabaseHandle,
    overrides: Partial<typeof workItems.$inferInsert> = {},
  ): string {
    return seedItem(handle, {
      state: "RUNNING",
      leaseToken: newId(),
      leasedAt: T0,
      leaseExpiresAt: plus(T0, 60_000),
      workerId: "worker-gone",
      attemptCount: 1,
      maxAttempts: 3,
      ...overrides,
    });
  }

  it("requeues expired leases with a lease-expired attempt", () => {
    withDatabase((t) => {
      const id = seedRunning(t.handle);
      const live = seedRunning(t.handle, {
        workerId: "worker-alive",
        leaseExpiresAt: plus(T0, 600_000),
      });
      const result = recoverStaleLeases(t.handle, { now: plus(T0, 61_000) });
      expect(result).toEqual({ recovered: 1, requeued: 1, failed: 0 });
      expect(getItem(t.handle, id)).toMatchObject({
        state: "QUEUED",
        leaseToken: null,
        workerId: null,
        nextRunAt: plus(T0, 61_000),
        attemptCount: 1,
      });
      const attempts = attemptsFor(t.handle, id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptNumber: 1,
        workerId: "worker-gone",
        startedAt: T0,
        finishedAt: plus(T0, 61_000),
        result: "FAILED",
        errorCode: LEASE_EXPIRED,
      });
      expect(attempts[0]?.errorDetail).toContain("worker-gone");
      // The live lease is untouched.
      expect(getItem(t.handle, live)?.state).toBe("RUNNING");
      expect(attemptsFor(t.handle, live)).toHaveLength(0);
    });
  });

  it("fails expired leases whose attempts are exhausted", () => {
    withDatabase((t) => {
      const id = seedRunning(t.handle, { attemptCount: 3, maxAttempts: 3 });
      const result = recoverStaleLeases(t.handle, { now: plus(T0, 61_000) });
      expect(result).toEqual({ recovered: 1, requeued: 0, failed: 1 });
      expect(getItem(t.handle, id)).toMatchObject({
        state: "FAILED",
        nextRunAt: null,
      });
    });
  });

  it("bounds one recovery pass by the limit", () => {
    withDatabase((t) => {
      // Identical expiries fall back to id order, so assert counts rather
      // than which rows a bounded pass picks.
      const ids = [
        seedRunning(t.handle),
        seedRunning(t.handle),
        seedRunning(t.handle),
      ];
      const result = recoverStaleLeases(t.handle, {
        now: plus(T0, 61_000),
        limit: 2,
      });
      expect(result.recovered).toBe(2);
      const states = ids.map((id) => getItem(t.handle, id)?.state);
      expect(states.filter((state) => state === "QUEUED")).toHaveLength(2);
      expect(states.filter((state) => state === "RUNNING")).toHaveLength(1);
      // A second pass picks up the remainder.
      expect(
        recoverStaleLeases(t.handle, { now: plus(T0, 61_000) }).recovered,
      ).toBe(1);
    });
  });
});

describe("queue requeue", () => {
  it("retries failed items with a fresh attempt budget", () => {
    withDatabase((t) => {
      const id = seedItem(t.handle, {
        state: "FAILED",
        attemptCount: 3,
        maxAttempts: 3,
      });
      const result = requeueWorkItem(t.handle, {
        workItemId: id,
        now: plus(T0, 1000),
      });
      expect(result).toEqual({ ok: true, state: "QUEUED" });
      expect(getItem(t.handle, id)).toMatchObject({
        state: "QUEUED",
        // The counter is append-only history: it keeps climbing so the
        // next completion cannot collide with kept attempt rows. The
        // fresh budget lands on maxAttempts instead.
        attemptCount: 3,
        maxAttempts: 6,
        nextRunAt: plus(T0, 1000),
      });
    });
  });

  it("requeue then claim then complete appends without colliding with history", () => {
    withDatabase((t) => {
      // Reproduces the `npm run dev` crash: an exhausted item keeps
      // three attempt rows, a human retries it, and the next attempt
      // must record as number 4 — never re-insert number 1.
      const id = seedItem(t.handle, {
        state: "FAILED",
        attemptCount: 3,
        maxAttempts: 3,
      });
      for (const attemptNumber of [1, 2, 3]) {
        t.handle.db
          .insert(workAttempts)
          .values({
            id: newId(),
            workItemId: id,
            attemptNumber,
            workerId: "worker-a",
            startedAt: T0,
            finishedAt: plus(T0, attemptNumber * 1000),
            result: "FAILED",
            errorCode: "PROVIDER_UNAVAILABLE",
          })
          .run();
      }
      expect(
        requeueWorkItem(t.handle, { workItemId: id, now: plus(T0, 9000) }).ok,
      ).toBe(true);
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "worker-b",
        kinds: ["SCRAPE"],
        leaseDurationMs: 60_000,
        now: plus(T0, 10_000),
      });
      expect(claimed?.attemptCount).toBe(4);
      const completed = completeWorkItem(
        t.handle,
        {
          workItemId: id,
          leaseToken: claimed?.leaseToken ?? "",
          result: "FAILED",
          errorCode: "PROVIDER_UNAVAILABLE",
        },
        { now: plus(T0, 11_000), backoff: { baseMs: 0 } },
      );
      expect(completed).toMatchObject({
        ok: true,
        state: "QUEUED",
        attemptNumber: 4,
      });
      expect(attemptsFor(t.handle, id)).toHaveLength(4);
      // Stale recovery on the re-driven lease also appends cleanly.
      const reclaimed = claimNextWorkItem(t.handle, {
        workerId: "worker-b",
        kinds: ["SCRAPE"],
        leaseDurationMs: 1000,
        now: plus(T0, 12_000),
      });
      expect(reclaimed?.attemptCount).toBe(5);
      const recovered = recoverStaleLeases(t.handle, {
        now: plus(T0, 20_000),
      });
      expect(recovered).toEqual({ recovered: 1, requeued: 1, failed: 0 });
      expect(attemptsFor(t.handle, id)).toHaveLength(5);
    });
  });

  it("never shrinks a larger surviving budget on requeue", () => {
    withDatabase((t) => {
      // A BLOCKED item finishes FAILED early with budget left; the
      // requeue extends from the recorded attempts without shrinking.
      const id = seedItem(t.handle, {
        state: "FAILED",
        attemptCount: 1,
        maxAttempts: 10,
      });
      expect(requeueWorkItem(t.handle, { workItemId: id }).ok).toBe(true);
      expect(getItem(t.handle, id)).toMatchObject({
        state: "QUEUED",
        attemptCount: 1,
        maxAttempts: 10,
      });
    });
  });

  it("refuses to rewrite terminal success or yank live leases", () => {
    withDatabase((t) => {
      const done = seedItem(t.handle, { state: "SUCCEEDED" });
      const running = seedItem(t.handle, {
        state: "RUNNING",
        leaseToken: newId(),
        leasedAt: T0,
        leaseExpiresAt: plus(T0, 60_000),
        workerId: "worker-a",
        attemptCount: 1,
      });
      expect(requeueWorkItem(t.handle, { workItemId: done })).toEqual({
        ok: false,
        error: "not-failed",
      });
      expect(requeueWorkItem(t.handle, { workItemId: running })).toEqual({
        ok: false,
        error: "not-failed",
      });
      expect(requeueWorkItem(t.handle, { workItemId: newId() })).toEqual({
        ok: false,
        error: "unknown-item",
      });
    });
  });
});
