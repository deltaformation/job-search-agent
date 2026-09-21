// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { workAttempts, workItems } from "../../../src/db";
import { ProgressReply } from "../../../src/domain/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import { readGenerationProgress } from "../../../src/server/progress";
import {
  FAILURE_ACTIONS,
  buildFailure,
  encodeFailureDetail,
  isRetryableFailureCode,
  type FailureCode,
} from "../../../src/tailoring/failures";
import { ProviderError } from "../../../src/tailoring/contract";
import { TestProvider } from "../../../src/tailoring/testProvider";
import {
  claimFRun,
  factTextsForVersion,
  fHandler,
  F_T0,
  makeArtifactsDir,
  proposalForRun,
  seedFRun,
  throwingProvider,
  withFDatabase,
} from "./f-world";
import { newId } from "../../../src/db";

/**
 * WO-1.3-F progress-read leg (F1, F5, F7-GET): the request progress
 * API reports actual queue/attempt state — stable attempt timing,
 * lease liveness, fenced events, and typed safe failures — and every
 * reply validates as ProgressReply.
 */

const T0_PLUS_17 = "2026-09-16T12:00:17.000Z";

describe("F1: progress timing identity", () => {
  it("reports QUEUED with no attempt before the first claim", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(ProgressReply.safeParse(result.reply).success).toBe(true);
      expect(result.reply).toMatchObject({
        requestId: run.requestId,
        state: "QUEUED",
        serverNow: T0_PLUS_17,
        attemptId: null,
        startedAt: null,
        finishedAt: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        events: [],
        failure: null,
        resumeVersionId: null,
        retryAllowed: false,
      });
    });
  });

  it("binds startedAt to the claim and echoes server time", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.reply).toMatchObject({
        state: "RUNNING",
        serverNow: T0_PLUS_17,
        attemptId: claimed.currentAttemptId,
        startedAt: F_T0,
        finishedAt: null,
        leaseExpiresAt: "2026-09-16T12:05:00.000Z",
        lastHeartbeatAt: F_T0,
        failure: null,
        retryAllowed: false,
      });
    });
  });

  it("404s unknown and foreign requests", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      expect(
        readGenerationProgress(t.handle, { jobId: run.basics.jobId, requestId: newId() }),
      ).toMatchObject({ ok: false, failure: { error: "unknown-request" } });
      expect(
        readGenerationProgress(t.handle, { jobId: newId(), requestId: run.requestId }),
      ).toMatchObject({ ok: false, failure: { error: "unknown-request" } });
    });
  });
});

describe("F5/F7: progress states and typed failures", () => {
  it("a transient failure followed by requeue reports QUEUED with retained evidence", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const failed = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => F_T0,
      })(first.context);
      const finishedAt = "2026-09-16T12:00:05.000Z";
      const completed = completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: failed.errorCode ?? null,
          errorDetail: failed.errorDetail ?? null,
        },
        { now: finishedAt },
      );
      expect(completed).toMatchObject({ ok: true, state: "QUEUED" });

      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.reply).toMatchObject({
        state: "QUEUED",
        attemptId: first.claimed.currentAttemptId,
        startedAt: F_T0,
        finishedAt,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        retryAllowed: false,
      });
      expect(result.reply.failure).toMatchObject({ code: "NETWORK", action: "retry" });
    });
  });

  it("an exhausted failure reports FAILED with retry advice per code", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const failed = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => F_T0,
      })(first.context);
      completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: failed.errorCode ?? null,
          errorDetail: failed.errorDetail ?? null,
        },
        { now: T0_PLUS_17 },
      );
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.reply).toMatchObject({ state: "FAILED", retryAllowed: true });
      expect(result.reply.failure).toMatchObject({ code: "NETWORK", action: "retry" });
    });
  });

  it("a committed version wins over stale RUNNING bookkeeping", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } }),
        clock: () => F_T0,
      })(first.context);
      expect(outcome.result).toBe("SUCCEEDED");
      // Crash before completion leaves the item RUNNING with an
      // expired lease; the committed version still wins the read.
      t.handle.db
        .update(workItems)
        .set({ leaseExpiresAt: "2026-09-16T11:00:00.000Z" })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.reply.state).toBe("SUCCEEDED");
      expect(result.reply.resumeVersionId).toEqual(expect.any(String));
      expect(result.reply.failure).toBeNull();
      expect(result.reply.retryAllowed).toBe(false);
    });
  });

  it("legacy error text degrades to INTERNAL with the persisted timestamp", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const finishedAt = "2026-09-16T12:00:09.000Z";
      completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: "HANDLER_ERROR",
          errorDetail: "legacy prose with secret-token-xyz",
        },
        { now: finishedAt },
      );
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.reply).toMatchObject({ state: "FAILED", retryAllowed: true });
      expect(result.reply.failure).toMatchObject({
        code: "INTERNAL",
        stage: null,
        occurredAt: finishedAt,
      });
      expect(JSON.stringify(result.reply)).not.toContain("secret-token-xyz");
      expect(JSON.stringify(result.reply)).not.toContain("legacy prose");
    });
  });

  it.each([
    "INPUT_STALE",
    "PROFILE_UNAVAILABLE",
    "CONFIGURATION",
    "AUTHENTICATION",
    "RATE_LIMIT",
    "NETWORK",
    "PROVIDER_TIMEOUT",
    "LOCAL_LAUNCH",
    "INVALID_RESPONSE",
    "CLAIM_VALIDATION",
    "RENDER_FAILED",
    "PUBLISH_FAILED",
    "LEASE_LOST",
    "INTERNAL",
  ] as const)("serves a typed safe failure for %s", async (code: FailureCode) => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const finishedAt = "2026-09-16T12:00:09.000Z";
      completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: code,
          errorDetail: encodeFailureDetail(
            buildFailure(code, {
              stage: "WAITING_FOR_PROVIDER",
              occurredAt: finishedAt,
              ...(code === "LOCAL_LAUNCH" ? { launchSubcode: "ENOENT" as const } : {}),
            }),
          ),
        },
        { now: finishedAt },
      );
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(ProgressReply.safeParse(result.reply).success).toBe(true);
      expect(result.reply).toMatchObject({
        state: "FAILED",
        retryAllowed: isRetryableFailureCode(code),
      });
      expect(result.reply.failure).toMatchObject({
        code,
        action: FAILURE_ACTIONS[code],
        stage: "WAITING_FOR_PROVIDER",
      });
      if (code === "LOCAL_LAUNCH") {
        expect(result.reply.failure).toMatchObject({ launchSubcode: "ENOENT" });
      }
      // Live credentials never ride the reply.
      expect(JSON.stringify(result.reply)).not.toContain(first.claimed.leaseToken);
      expect("leaseToken" in (result.reply as Record<string, unknown>)).toBe(false);
    });
  });

  it("attempt rows keep lease tokens server-side only", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const stored = t.handle.db
        .select()
        .from(workAttempts)
        .where(eq(workAttempts.id, claimed.currentAttemptId))
        .get();
      expect(stored).toBeDefined();
      const result = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        now: T0_PLUS_17,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const serialized = JSON.stringify(result.reply);
      expect(serialized).not.toContain(claimed.leaseToken);
      for (const event of result.reply.events) {
        expect("leaseToken" in (event as Record<string, unknown>)).toBe(false);
      }
    });
  });
});
