import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
// File imports (not directory barrels): the worker runs under the
// extensionless-file TS loader, which cannot resolve directory imports.
import type { DatabaseHandle } from "../db/client";
import { workAttempts, workItems, type WorkItem } from "../db/schema/queue";
import { withTransaction } from "../db/transactions";
import { newId, utcNow } from "../db/utils";
import {
  AttemptResult,
  WorkKind,
  type WorkKind as WorkKindValue,
  type WorkState as WorkStateValue,
} from "../domain/enums";
import { computeBackoffMs, type BackoffOptions } from "./backoff";

/**
 * Durable-queue lease primitives over `work_items` / `work_attempts`.
 *
 * Every function below runs its writes in one short synchronous transaction
 * and never awaits inside it; handlers and all other async work happen
 * outside, in the dispatcher. All state changes are conditional updates
 * (state + lease token in the WHERE clause), so a lost race returns a
 * typed `lease-lost` result instead of corrupting another worker's lease.
 *
 * History is append-only: each attempt gets exactly one `work_attempts`
 * row, written in the same transaction as its completion, so a crash or
 * duplicate completion can neither erase nor duplicate attempt history.
 */

export const DEFAULT_LEASE_DURATION_MS = 300_000;
export const DEFAULT_STALE_RECOVERY_LIMIT = 100;
export const MAX_STALE_RECOVERY_LIMIT = 1000;
/**
 * Attempts granted by one human requeue, on top of the attempts already
 * recorded. Matches the default enqueue budget.
 */
export const DEFAULT_REQUEUE_ATTEMPTS = 3;

/** `work_attempts.error_code` for leases reclaimed after expiry. */
export const LEASE_EXPIRED = "LEASE_EXPIRED";

const IsoDateTime = z.string().datetime({ offset: true });

const WorkerId = z.string().trim().min(1).max(128);

const PositiveInt = z.number().int().positive();

/** A claimed row always carries a live lease; built from known values. */
export interface ClaimedWorkItem extends WorkItem {
  leaseToken: string;
  leasedAt: string;
  leaseExpiresAt: string;
  workerId: string;
}

export const ClaimWorkItemInput = z.object({
  workerId: WorkerId,
  /** Kinds eligible for claim; omitted means every kind. Empty claims none. */
  kinds: z.array(WorkKind).optional(),
  leaseDurationMs: PositiveInt.max(3_600_000),
  now: IsoDateTime.optional(),
});
export type ClaimWorkItemInput = z.infer<typeof ClaimWorkItemInput>;

export const RenewLeaseInput = z.object({
  workItemId: z.string().min(1),
  leaseToken: z.string().min(1),
  leaseDurationMs: PositiveInt.max(3_600_000),
  now: IsoDateTime.optional(),
});
export type RenewLeaseInput = z.infer<typeof RenewLeaseInput>;

export const CompleteWorkItemInput = z.object({
  workItemId: z.string().min(1),
  leaseToken: z.string().min(1),
  result: AttemptResult,
  errorCode: z.string().trim().min(1).max(64).nullish(),
  errorDetail: z.string().max(4000).nullish(),
  inputHash: z.string().max(128).nullish(),
  outputHash: z.string().max(128).nullish(),
});
export type CompleteWorkItemInput = z.infer<typeof CompleteWorkItemInput>;

export interface CompleteWorkItemOptions {
  now?: string;
  backoff?: BackoffOptions;
}

export type CompleteWorkItemResult =
  | {
      ok: true;
      state: WorkStateValue;
      attemptNumber: number;
      nextRunAt: string | null;
    }
  | { ok: false; error: "unknown-item" | "lease-lost" };

export const RecoverStaleLeasesInput = z.object({
  now: IsoDateTime.optional(),
  limit: z.number().int().min(1).max(MAX_STALE_RECOVERY_LIMIT).optional(),
});
export type RecoverStaleLeasesInput = z.infer<typeof RecoverStaleLeasesInput>;

export interface RecoverStaleLeasesResult {
  recovered: number;
  requeued: number;
  failed: number;
}

export type RequeueWorkItemResult =
  | { ok: true; state: "QUEUED" }
  | { ok: false; error: "unknown-item" | "not-failed" };

function resolveNow(now: string | undefined): string {
  return IsoDateTime.parse(now ?? utcNow());
}

function addMilliseconds(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * Atomically claim the oldest runnable QUEUED item. Runnability means
 * `next_run_at` is null or due; FIFO order is by creation rowid. The claim
 * is one UPDATE statement, so two racing workers serialize inside SQLite
 * and can never hold the same item. Returns null when nothing is runnable.
 */
export function claimNextWorkItem(
  handle: DatabaseHandle,
  rawInput: ClaimWorkItemInput,
): ClaimedWorkItem | null {
  const input = ClaimWorkItemInput.parse(rawInput);
  if (input.kinds !== undefined && input.kinds.length === 0) {
    return null;
  }
  const nowIso = resolveNow(input.now);
  const leaseToken = newId();
  const leaseExpiresAt = addMilliseconds(nowIso, input.leaseDurationMs);
  const candidate = handle.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.state, "QUEUED"),
        or(isNull(workItems.nextRunAt), lte(workItems.nextRunAt, nowIso)),
        input.kinds === undefined
          ? undefined
          : inArray(workItems.kind, input.kinds),
      ),
    )
    .orderBy(workItems.createdAt, workItems.id)
    .limit(1);
  const toRunning = {
    state: "RUNNING" as const,
    leaseToken,
    leasedAt: nowIso,
    leaseExpiresAt,
    workerId: input.workerId,
    updatedAt: nowIso,
  };
  const claimed = withTransaction(
    handle.sqlite,
    () =>
      handle.db
        .update(workItems)
        .set({
          ...toRunning,
          // Incremented inside the UPDATE statement so concurrent claims
          // serialize in SQLite and never share an attempt number.
          attemptCount: sql`${workItems.attemptCount} + 1`,
        })
        .where(eq(workItems.id, candidate))
        .returning()
        .get() ?? null,
  );
  if (claimed === null) {
    return null;
  }
  // Rebuild the claimed view from the values this statement assigned so
  // the non-null lease fields need no type assertion.
  return {
    ...claimed,
    ...toRunning,
    attemptCount: claimed.attemptCount,
  };
}

/**
 * Extend a live lease. Succeeds only when the item is still RUNNING under
 * the caller's token; anything else is a benign `lease-lost` the caller
 * must treat as "stop working, someone else owns this item now".
 */
export function renewLease(
  handle: DatabaseHandle,
  rawInput: RenewLeaseInput,
): { ok: true; leaseExpiresAt: string } | { ok: false; error: "lease-lost" } {
  const input = RenewLeaseInput.parse(rawInput);
  const nowIso = resolveNow(input.now);
  const leaseExpiresAt = addMilliseconds(nowIso, input.leaseDurationMs);
  const changed = withTransaction(
    handle.sqlite,
    () =>
      handle.db
        .update(workItems)
        .set({ leaseExpiresAt, updatedAt: nowIso })
        .where(
          and(
            eq(workItems.id, input.workItemId),
            eq(workItems.state, "RUNNING"),
            eq(workItems.leaseToken, input.leaseToken),
          ),
        )
        .run().changes,
  );
  if (changed !== 1) {
    return { ok: false, error: "lease-lost" };
  }
  return { ok: true, leaseExpiresAt };
}

/**
 * Complete one attempt. The state change and its `work_attempts` row are
 * written in a single transaction guarded by the lease token, which makes
 * duplicate completion safe: the second call finds no live lease and
 * returns `lease-lost` without writing anything.
 *
 * Result mapping: SUCCEEDED finishes the item; FAILED requeues with
 * backoff while attempts remain and finishes it once exhausted; BLOCKED
 * (login/CAPTCHA/access) finishes the item as FAILED because queue rows
 * have no BLOCKED state — the attempt row keeps the BLOCKED result and
 * reason so the block stays explicit until a human requeues.
 */
export function completeWorkItem(
  handle: DatabaseHandle,
  rawInput: CompleteWorkItemInput,
  rawOptions: CompleteWorkItemOptions = {},
): CompleteWorkItemResult {
  const input = CompleteWorkItemInput.parse(rawInput);
  const nowIso = resolveNow(rawOptions.now);
  return withTransaction(handle.sqlite, () => {
    const current = handle.db
      .select({
        state: workItems.state,
        leaseToken: workItems.leaseToken,
      })
      .from(workItems)
      .where(eq(workItems.id, input.workItemId))
      .get();
    if (current === undefined) {
      return { ok: false, error: "unknown-item" } as const;
    }
    if (current.state !== "RUNNING" || current.leaseToken !== input.leaseToken) {
      return { ok: false, error: "lease-lost" } as const;
    }
    const live = handle.db
      .select({
        attemptCount: workItems.attemptCount,
        maxAttempts: workItems.maxAttempts,
        leasedAt: workItems.leasedAt,
        workerId: workItems.workerId,
      })
      .from(workItems)
      .where(eq(workItems.id, input.workItemId))
      .get();
    if (live === undefined || live.leasedAt === null) {
      // Unreachable: the row was RUNNING with our token a statement ago
      // in the same transaction, and RUNNING implies leased_at is set.
      // Fail loudly rather than writing a corrupt attempt row.
      throw new Error(
        `work item ${input.workItemId} lost its lease record mid-completion`,
      );
    }
    const attemptsExhausted = live.attemptCount >= live.maxAttempts;
    let state: WorkStateValue;
    let nextRunAt: string | null;
    if (input.result === "SUCCEEDED") {
      state = "SUCCEEDED";
      nextRunAt = null;
    } else if (input.result === "BLOCKED" || attemptsExhausted) {
      state = "FAILED";
      nextRunAt = null;
    } else {
      state = "QUEUED";
      nextRunAt = addMilliseconds(
        nowIso,
        computeBackoffMs(live.attemptCount, rawOptions.backoff),
      );
    }
    const changed = handle.db
      .update(workItems)
      .set({
        state,
        leaseToken: null,
        workerId: null,
        nextRunAt,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(workItems.id, input.workItemId),
          eq(workItems.state, "RUNNING"),
          eq(workItems.leaseToken, input.leaseToken),
        ),
      )
      .run().changes;
    if (changed !== 1) {
      return { ok: false, error: "lease-lost" } as const;
    }
    handle.db
      .insert(workAttempts)
      .values({
        id: newId(),
        workItemId: input.workItemId,
        attemptNumber: live.attemptCount,
        workerId: live.workerId,
        startedAt: live.leasedAt,
        finishedAt: nowIso,
        inputHash: input.inputHash ?? null,
        outputHash: input.outputHash ?? null,
        result: input.result,
        errorCode: input.errorCode ?? null,
        errorDetail: input.errorDetail ?? null,
      })
      .run();
    return { ok: true, state, attemptNumber: live.attemptCount, nextRunAt };
  });
}

/**
 * Reclaim leases whose expiry has passed. Each reclaimed lease gets the
 * FAILED attempt row its dead worker never wrote (error `LEASE_EXPIRED`),
 * then requeues immediately when attempts remain or finishes FAILED when
 * exhausted. Bounded by `limit` so one call stays a short transaction;
 * the dispatcher calls this on every tick plus once at startup.
 */
export function recoverStaleLeases(
  handle: DatabaseHandle,
  rawInput: RecoverStaleLeasesInput = {},
): RecoverStaleLeasesResult {
  const input = RecoverStaleLeasesInput.parse(rawInput);
  const nowIso = resolveNow(input.now);
  const limit = input.limit ?? DEFAULT_STALE_RECOVERY_LIMIT;
  return withTransaction(handle.sqlite, () => {
    const stale = handle.db
      .select({
        id: workItems.id,
        leaseToken: workItems.leaseToken,
        leasedAt: workItems.leasedAt,
        leaseExpiresAt: workItems.leaseExpiresAt,
        workerId: workItems.workerId,
        attemptCount: workItems.attemptCount,
        maxAttempts: workItems.maxAttempts,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.state, "RUNNING"),
          lte(workItems.leaseExpiresAt, nowIso),
        ),
      )
      .orderBy(workItems.leaseExpiresAt, workItems.id)
      .limit(limit)
      .all();
    const result: RecoverStaleLeasesResult = {
      recovered: 0,
      requeued: 0,
      failed: 0,
    };
    for (const row of stale) {
      if (row.leaseToken === null || row.leasedAt === null) {
        continue;
      }
      const exhausted = row.attemptCount >= row.maxAttempts;
      const state: WorkStateValue = exhausted ? "FAILED" : "QUEUED";
      const changed = handle.db
        .update(workItems)
        .set({
          state,
          leaseToken: null,
          workerId: null,
          nextRunAt: exhausted ? null : nowIso,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(workItems.id, row.id),
            eq(workItems.state, "RUNNING"),
            eq(workItems.leaseToken, row.leaseToken),
            lte(workItems.leaseExpiresAt, nowIso),
          ),
        )
        .run().changes;
      if (changed !== 1) {
        // Renewed concurrently after our SELECT; the live worker owns it.
        continue;
      }
      handle.db
        .insert(workAttempts)
        .values({
          id: newId(),
          workItemId: row.id,
          attemptNumber: row.attemptCount,
          workerId: row.workerId,
          startedAt: row.leasedAt,
          finishedAt: nowIso,
          result: "FAILED",
          errorCode: LEASE_EXPIRED,
          errorDetail: `lease held by ${row.workerId ?? "unknown worker"} expired at ${row.leaseExpiresAt ?? "unknown time"}`,
        })
        .run();
      result.recovered += 1;
      result.requeued += exhausted ? 0 : 1;
      result.failed += exhausted ? 1 : 0;
    }
    return result;
  });
}

/**
 * Human-initiated retry of a finished FAILED item. Only FAILED items are
 * eligible; SUCCEEDED/CANCELLED history is never rewritten and RUNNING
 * leases are never yanked. The attempt counter is never reset because
 * `work_attempts` rows are append-only under a unique
 * (work_item_id, attempt_number) key — restarting the counter would
 * collide with kept history on the next completion or stale-lease
 * recovery. Instead a human requeue grants a fresh bounded budget by
 * extending `max_attempts` past the attempts already recorded.
 */
export function requeueWorkItem(
  handle: DatabaseHandle,
  rawInput: { workItemId: string; now?: string },
): RequeueWorkItemResult {
  const input = z
    .object({ workItemId: z.string().min(1), now: IsoDateTime.optional() })
    .parse(rawInput);
  const nowIso = resolveNow(input.now);
  return withTransaction(handle.sqlite, () => {
    const current = handle.db
      .select({
        state: workItems.state,
        attemptCount: workItems.attemptCount,
        maxAttempts: workItems.maxAttempts,
      })
      .from(workItems)
      .where(eq(workItems.id, input.workItemId))
      .get();
    if (current === undefined) {
      return { ok: false, error: "unknown-item" } as const;
    }
    if (current.state !== "FAILED") {
      return { ok: false, error: "not-failed" } as const;
    }
    const maxAttempts = Math.max(
      current.maxAttempts,
      current.attemptCount + DEFAULT_REQUEUE_ATTEMPTS,
    );
    const changed = handle.db
      .update(workItems)
      .set({
        state: "QUEUED",
        maxAttempts,
        nextRunAt: nowIso,
        updatedAt: nowIso,
      })
      .where(
        and(eq(workItems.id, input.workItemId), eq(workItems.state, "FAILED")),
      )
      .run().changes;
    if (changed !== 1) {
      return { ok: false, error: "not-failed" } as const;
    }
    return { ok: true, state: "QUEUED" } as const;
  });
}

export type { WorkKindValue, WorkStateValue };
