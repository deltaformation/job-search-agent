// @vitest-environment node
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  jobs,
  resumeVersions,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { appendProgressFenced } from "../../../src/db/tailoringWorkspace";
import {
  completeWorkItem,
  recoverStaleLeases,
  renewLease,
} from "../../../src/queue/leases";
import type { HandlerOutcome } from "../../../src/queue/dispatch";
import { CommandProvider } from "../../../src/tailoring/commandAdapter";
import { ProviderError } from "../../../src/tailoring/contract";
import {
  buildFailure,
  encodeFailureDetail,
  failureCodeForReason,
  launchSubcodeForSpawnCode,
  parseFailureDetail,
} from "../../../src/tailoring/failures";
import {
  attachResumeVersion,
  beginTailorRun,
  nextResumeVersion,
  recordAnalysis,
  reopenTailorRun,
} from "../../../src/tailoring/persist";
import { TestProvider } from "../../../src/tailoring/testProvider";
import {
  attemptsFor,
  claimFRun,
  factTextsForVersion,
  fHandler,
  F_T0,
  makeArtifactsDir,
  proposalForRun,
  q5,
  q6,
  seedFRun,
  throwingProvider,
  withFDatabase,
  workItemFor,
} from "./f-world";

/**
 * WO-1.3-F worker leg (F4, F6–F8): real v3 execution through W + G,
 * real lease claims, and the deterministic provider/renderer. Stages
 * come from actual boundaries, leases fence every write, failures
 * map from actual codes, and crash recovery never duplicates
 * analysis, versions, or provider calls.
 */

function finishAttempt(
  handle: DatabaseHandle,
  input: {
    workItemId: string;
    leaseToken: string;
    attemptId: string;
    outcome: HandlerOutcome;
    now?: string;
  },
) {
  return completeWorkItem(
    handle,
    {
      workItemId: input.workItemId,
      leaseToken: input.leaseToken,
      attemptId: input.attemptId,
      result: input.outcome.result,
      errorCode: input.outcome.errorCode ?? null,
      errorDetail: input.outcome.errorDetail ?? null,
      inputHash: input.outcome.inputHash ?? null,
      outputHash: input.outcome.outputHash ?? null,
    },
    { now: input.now ?? F_T0, terminal: input.outcome.terminal },
  );
}

function expireLease(handle: DatabaseHandle, workItemId: string): void {
  handle.db
    .update(workItems)
    .set({ leaseExpiresAt: "2026-09-16T11:00:00.000Z" })
    .where(eq(workItems.id, workItemId))
    .run();
}

describe("F4: real stage boundaries", () => {
  it("emits exactly seq 1..5 with provider source on a real run", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const provider = new TestProvider({
        proposals: {
          [run.jdSnapshotId]: proposalForRun({
            recommendations: run.recommendations,
            factTexts: facts,
            jdSnapshotId: run.jdSnapshotId,
            candidateSnapshotId: run.candidateSnapshotId,
          }),
        },
      });
      const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider,
        clock: () => F_T0,
      })(context);
      expect(outcome.result).toBe("SUCCEEDED");
      const completed = finishAttempt(t.handle, {
        workItemId: run.workItemId,
        leaseToken: claimed.leaseToken,
        attemptId: claimed.currentAttemptId,
        outcome,
      });
      expect(completed.ok).toBe(true);

      const events = q5(t.handle, run.requestId, claimed.currentAttemptId);
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(events.map((event) => event.stage)).toEqual([
        "PREPARING_INPUTS",
        "WAITING_FOR_PROVIDER",
        "VALIDATING_PROPOSAL",
        "RENDERING_ARTIFACTS",
        "PUBLISHING_RESULT",
      ]);
      expect(new Set(events.map((event) => event.source))).toEqual(new Set(["provider"]));
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 1 });
      expect(getGenerationRequest(t.handle, run.requestId)?.status).toBe("SUCCEEDED");
    });
  });

  it("renews the lease on one timer during the provider await", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const inner = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const provider = {
        providerId: inner.providerId,
        prepare: async (input: Parameters<TestProvider["prepare"]>[0]) => {
          entered = true;
          await gate;
          return inner.prepare(input);
        },
      };
      const ticks: Array<() => void> = [];
      let stopped = false;
      let intervalMs = -1;
      const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      // Heartbeats advance the test clock so renewal is observable.
      context.heartbeat = () =>
        renewLease(t.handle, {
          workItemId: claimed.id,
          leaseToken: claimed.leaseToken,
          attemptId: claimed.currentAttemptId,
          leaseDurationMs: 300_000,
          now: "2026-09-16T12:01:00.000Z",
        }).ok;
      const before = workItemFor(t.handle, run.workItemId).leaseExpiresAt;
      const pending = fHandler({
        artifactsDir: makeArtifactsDir(),
        provider,
        clock: () => "2026-09-16T12:01:00.000Z",
        createRenewalTimer: (ms, onTick) => {
          intervalMs = ms;
          ticks.push(onTick);
          return {
            stop: () => {
              stopped = true;
            },
          };
        },
      })(context);
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(ticks).toHaveLength(1);
      ticks[0]?.();
      expect(workItemFor(t.handle, run.workItemId).leaseExpiresAt).toBe(
        "2026-09-16T12:06:00.000Z",
      );
      expect(workItemFor(t.handle, run.workItemId).leaseExpiresAt).not.toBe(before);
      release();
      const outcome = await pending;
      expect(outcome.result).toBe("SUCCEEDED");
      expect(stopped).toBe(true);
      expect(ticks).toHaveLength(1);
      expect(intervalMs).toBe(30_000);
    });
  });

  it("cached recovery reuses the saved proposal without a provider call", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const artifactsDir = makeArtifactsDir();
      // Attempt 1 validates the proposal, persists the analysis, then
      // dies in rendering — the classic analysis-only crash.
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const provider1 = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      const failed = await fHandler({
        artifactsDir,
        provider: provider1,
        clock: () => F_T0,
        renderPdf: async () => {
          throw new Error("simulated renderer crash");
        },
      })(first.context);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "RENDER_FAILED" });
      expect(failed.terminal).toBeUndefined();
      const completed = finishAttempt(t.handle, {
        workItemId: run.workItemId,
        leaseToken: first.claimed.leaseToken,
        attemptId: first.claimed.currentAttemptId,
        outcome: failed,
      });
      expect(completed).toMatchObject({ ok: true, state: "QUEUED" });
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 0 });
      expect(q5(t.handle, run.requestId, first.claimed.currentAttemptId).map((e) => e.seq)).toEqual([
        1, 2, 3, 4,
      ]);

      // Attempt 2 resumes from the saved proposal: all five real
      // boundaries re-emit source-tagged cached, no provider call.
      const second = claimFRun(t.handle, run.workItemId, { now: "2026-09-16T12:05:00.000Z" });
      const provider2 = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      const outcome = await fHandler({
        artifactsDir,
        provider: provider2,
        clock: () => "2026-09-16T12:05:00.000Z",
      })(second.context);
      expect(outcome.result).toBe("SUCCEEDED");
      expect(provider2.receivedInputs).toHaveLength(0);
      const events = q5(t.handle, run.requestId, second.claimed.currentAttemptId);
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(events.map((event) => event.source))).toEqual(new Set(["cached"]));
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 1 });
      const analysis = t.handle.sqlite
        .prepare("SELECT work_attempt_id AS attemptId FROM job_analyses WHERE generation_request_id = ?")
        .get(run.requestId) as { attemptId: string };
      const version = t.handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.generationRequestId, run.requestId))
        .get();
      // Original analysis lineage preserved; the resume binds the
      // publishing attempt.
      expect(analysis.attemptId).toBe(first.claimed.currentAttemptId);
      expect(version?.workAttemptId).toBe(second.claimed.currentAttemptId);
    });
  });
});

describe("F6: leases, fencing, and crash recovery", () => {
  it("an expired lease cannot renew, complete, or emit before any reclaim", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const request = getGenerationRequest(t.handle, run.requestId);
      if (request === null) {
        throw new Error("request missing");
      }
      const begun = beginTailorRun(t.handle, { jobId: run.basics.jobId, request, now: F_T0 });
      expect(begun.ok).toBe(true);
      expireLease(t.handle, run.workItemId);

      expect(
        renewLease(t.handle, {
          workItemId: run.workItemId,
          leaseToken: claimed.leaseToken,
          attemptId: claimed.currentAttemptId,
          leaseDurationMs: 300_000,
          now: "2026-09-16T12:30:00.000Z",
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
      expect(
        completeWorkItem(
          t.handle,
          { workItemId: run.workItemId, leaseToken: claimed.leaseToken, result: "SUCCEEDED" },
          { now: "2026-09-16T12:30:00.000Z" },
        ),
      ).toEqual({ ok: false, error: "lease-lost" });
      expect(() =>
        appendProgressFenced(t.handle, {
          requestId: run.requestId,
          workItemId: run.workItemId,
          attemptId: claimed.currentAttemptId,
          seq: 1,
          stage: "PREPARING_INPUTS",
          source: "provider",
          leaseToken: claimed.leaseToken,
          recordedAt: "2026-09-16T12:30:00.000Z",
        }),
      ).toThrow(/LEASE_LOST/);
      expect(q5(t.handle, run.requestId, claimed.currentAttemptId)).toHaveLength(0);
    });
  });

  it("publication commits under a live lease and dies write-free under a dead one", async () => {
    // G: the atomic attach also persists assessment/1, so the fence
    // probe carries the rendered bytes + evidence a real
    // OrchestrationSuccess always provides.
    const minimalResult = {
      contentHash: "0".repeat(64),
      content: { schemaVersion: "resume-content/v1" },
      draft: { job_id: "job", target_role: null, target_company: null, claims: [] },
      markdown: Buffer.from("# Fence probe\n", "utf8"),
      renderEvidence: {
        pageCount: 1,
        pageBudget: 2,
        fragmentsChecked: 1,
        contentPresent: false,
        contactPresent: false,
        parityPassed: true,
      },
    };
    // Live lease: the fenced attach commits.
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const request = getGenerationRequest(t.handle, run.requestId);
      if (request === null) {
        throw new Error("request missing");
      }
      const begun = beginTailorRun(t.handle, { jobId: run.basics.jobId, request, now: F_T0 });
      if (!begun.ok) {
        throw new Error("begin failed");
      }
      const analysisId = recordAnalysis(t.handle, {
        jobId: run.basics.jobId,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
        proposal: {
          requirements: [],
          gaps: [],
          attempt: {},
          inputHash: "1".repeat(64),
          proposalHash: "2".repeat(64),
          rationale: "fence probe",
          model: null,
        } as never,
        providerId: "fence-probe",
        promptVersion: "tailor-prompt/v2",
        proposalSchemaVersion: "resume-proposal/v1",
        generationRequestId: run.requestId,
        workAttemptId: claimed.currentAttemptId,
      });
      const attached = attachResumeVersion(t.handle, {
        start: begun.start,
        extractionId: run.basics.extractionId,
        analysisId,
        result: minimalResult as never,
        artifacts: [],
        expectedVersion: nextResumeVersion(t.handle, run.basics.jobId),
        workAttemptId: claimed.currentAttemptId,
        now: F_T0,
        lease: {
          workItemId: run.workItemId,
          attemptId: claimed.currentAttemptId,
          leaseToken: claimed.leaseToken,
        },
        profileId: run.basics.profileId,
        profileVersionId: run.basics.profileVersionId,
      });
      expect(attached.ok).toBe(true);
      expect(q6(t.handle, run.requestId).versions).toBe(1);
    });
    // Dead lease, wrong token: zero versions, zero request moves.
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const request = getGenerationRequest(t.handle, run.requestId);
      if (request === null) {
        throw new Error("request missing");
      }
      const begun = beginTailorRun(t.handle, { jobId: run.basics.jobId, request, now: F_T0 });
      if (!begun.ok) {
        throw new Error("begin failed");
      }
      const analysisId = recordAnalysis(t.handle, {
        jobId: run.basics.jobId,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
        proposal: {
          requirements: [],
          gaps: [],
          attempt: {},
          inputHash: "1".repeat(64),
          proposalHash: "2".repeat(64),
          rationale: "fence probe",
          model: null,
        } as never,
        providerId: "fence-probe",
        promptVersion: "tailor-prompt/v2",
        proposalSchemaVersion: "resume-proposal/v1",
        generationRequestId: run.requestId,
        workAttemptId: claimed.currentAttemptId,
      });
      const base = {
        start: begun.start,
        extractionId: run.basics.extractionId,
        analysisId,
        result: minimalResult as never,
        artifacts: [],
        expectedVersion: nextResumeVersion(t.handle, run.basics.jobId),
        workAttemptId: claimed.currentAttemptId,
        now: F_T0,
      };
      const wrongToken = attachResumeVersion(t.handle, {
        ...base,
        lease: {
          workItemId: run.workItemId,
          attemptId: claimed.currentAttemptId,
          leaseToken: "stale-token",
        },
      });
      expect(wrongToken).toMatchObject({ ok: false, error: "lease-lost" });
      expireLease(t.handle, run.workItemId);
      const expired = attachResumeVersion(t.handle, {
        ...base,
        now: "2026-09-16T12:30:00.000Z",
        lease: {
          workItemId: run.workItemId,
          attemptId: claimed.currentAttemptId,
          leaseToken: claimed.leaseToken,
        },
      });
      expect(expired).toMatchObject({ ok: false, error: "lease-lost" });
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 0 });
      expect(getGenerationRequest(t.handle, run.requestId)?.status).toBe("RUNNING");
    });
  });

  it("recovery hands a new token to the next attempt; the old token writes nothing", async () => {
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
      expireLease(t.handle, run.workItemId);
      const recovered = recoverStaleLeases(t.handle, { now: "2026-09-16T12:01:00.000Z" });
      expect(recovered).toMatchObject({ recovered: 1, requeued: 1, failed: 0 });

      const second = claimFRun(t.handle, run.workItemId, { now: "2026-09-16T12:01:00.000Z" });
      expect(second.claimed.leaseToken).not.toBe(first.claimed.leaseToken);
      expect(second.claimed.currentAttemptId).not.toBe(first.claimed.currentAttemptId);

      // Old token: renew, complete, and emit all refuse.
      expect(
        renewLease(t.handle, {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          leaseDurationMs: 300_000,
          now: "2026-09-16T12:01:00.000Z",
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
      expect(
        finishAttempt(t.handle, {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          outcome: { result: "SUCCEEDED" },
          now: "2026-09-16T12:01:00.000Z",
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
      expect(() =>
        appendProgressFenced(t.handle, {
          requestId: run.requestId,
          workItemId: run.workItemId,
          attemptId: first.claimed.currentAttemptId,
          seq: 1,
          stage: "PREPARING_INPUTS",
          source: "provider",
          leaseToken: first.claimed.leaseToken,
          recordedAt: "2026-09-16T12:01:00.000Z",
        }),
      ).toThrow(/LEASE_LOST/);

      // New attempt runs the full pipeline to publication.
      const provider = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider,
        clock: () => "2026-09-16T12:01:00.000Z",
      })(second.context);
      expect(outcome.result).toBe("SUCCEEDED");
      const attempts = attemptsFor(t.handle, run.workItemId);
      expect(attempts.map((attempt) => attempt.result)).toEqual(["FAILED", "RUNNING"]);
      expect(attempts[0]).toMatchObject({ errorCode: "LEASE_EXPIRED" });
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 1 });
    });
  });

  it("a crash after publication converges with no provider rerun and no second version", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const artifactsDir = makeArtifactsDir();
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const provider1 = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      const published = await fHandler({
        artifactsDir,
        provider: provider1,
        clock: () => F_T0,
      })(first.context);
      expect(published.result).toBe("SUCCEEDED");
      // Crash between publication and completion: never completed.
      expireLease(t.handle, run.workItemId);
      const recovered = recoverStaleLeases(t.handle, { now: "2026-09-16T12:06:00.000Z" });
      expect(recovered).toMatchObject({ recovered: 1, requeued: 1 });

      const second = claimFRun(t.handle, run.workItemId, { now: "2026-09-16T12:06:00.000Z" });
      const provider2 = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      const outcome = await fHandler({
        artifactsDir,
        provider: provider2,
        clock: () => "2026-09-16T12:06:00.000Z",
      })(second.context);
      expect(outcome.result).toBe("SUCCEEDED");
      expect(provider2.receivedInputs).toHaveLength(0);
      expect(q5(t.handle, run.requestId, second.claimed.currentAttemptId)).toHaveLength(0);
      const completed = finishAttempt(t.handle, {
        workItemId: run.workItemId,
        leaseToken: second.claimed.leaseToken,
        attemptId: second.claimed.currentAttemptId,
        outcome,
        now: "2026-09-16T12:06:00.000Z",
      });
      expect(completed).toMatchObject({ ok: true, state: "SUCCEEDED" });
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 1 });
      // G: crash-after-publish converges with exactly one atomic
      // assessment (deduped rerun reuses the version, never a second).
      const assessments = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM resume_assessments")
        .get() as { n: number };
      expect(assessments.n).toBe(1);
    });
  });

  it("a stale mid-flight writer cannot fail the request its successor owns", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const good = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const bad = structuredClone(good);
      const requirements = bad["requirements"] as Array<Record<string, unknown>>;
      requirements[0] = { ...requirements[0], jd_quote: "Fabricated quote about nothing" };

      // Attempt A starts orchestration with a deferred bad proposal.
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const inner = new TestProvider({ proposals: { [run.jdSnapshotId]: bad } });
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const staleProvider = {
        providerId: inner.providerId,
        prepare: async (input: Parameters<TestProvider["prepare"]>[0]) => {
          entered = true;
          await gate;
          return inner.prepare(input);
        },
      };
      const pending = fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: staleProvider,
        clock: () => F_T0,
      })(first.context);
      await vi.waitFor(() => expect(entered).toBe(true));

      // The lease dies mid-flight; recovery requeues and attempt B
      // begins through the same reopen path a real handler uses.
      expireLease(t.handle, run.workItemId);
      recoverStaleLeases(t.handle, { now: "2026-09-16T12:01:00.000Z" });
      const second = claimFRun(t.handle, run.workItemId, { now: "2026-09-16T12:01:00.000Z" });
      reopenTailorRun(t.handle, { jobId: run.basics.jobId, now: "2026-09-16T12:01:00.000Z" });
      const request = getGenerationRequest(t.handle, run.requestId);
      if (request === null) {
        throw new Error("request missing");
      }
      const begun = beginTailorRun(t.handle, {
        jobId: run.basics.jobId,
        request,
        now: "2026-09-16T12:01:00.000Z",
      });
      if (!begun.ok) {
        throw new Error("successor begin failed");
      }

      // A's proposal resolves invalid — but A's persist path finds a
      // dead lease and aborts write-free instead of failing B's run.
      release();
      const outcome = await pending;
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LEASE_LOST" });
      expect(getGenerationRequest(t.handle, run.requestId)?.status).toBe("RUNNING");
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
      expect(job?.tailoringState).toBe("RUNNING");
      expect(job?.rowVersion).toBe(begun.start.fenceVersion);
      // A's completion is dropped; its emitted history stays.
      expect(
        finishAttempt(t.handle, {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          outcome,
          now: "2026-09-16T12:01:00.000Z",
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
      // A's seq 3 emission hit the dead lease first, so the stale
      // run stopped there — the two live-lease emissions persist.
      expect(
        q5(t.handle, run.requestId, first.claimed.currentAttemptId).map((event) => event.seq),
      ).toEqual([1, 2]);

      // B is unaffected and publishes.
      const providerB = new TestProvider({ proposals: { [run.jdSnapshotId]: good } });
      const published = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: providerB,
        clock: () => "2026-09-16T12:01:00.000Z",
      })(second.context);
      expect(published.result).toBe("SUCCEEDED");
    });
  });
});

describe("F7: typed failures from actual codes", () => {
  it("a missing provider blocks with CONFIGURATION and a settings action", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: null,
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "CONFIGURATION" });
      const failure = parseFailureDetail(outcome.errorDetail ?? null);
      expect(failure).toMatchObject({ code: "CONFIGURATION", action: "open_settings" });
      const completed = finishAttempt(t.handle, {
        workItemId: run.workItemId,
        leaseToken: claimed.leaseToken,
        attemptId: claimed.currentAttemptId,
        outcome,
      });
      expect(completed).toMatchObject({ ok: true, state: "FAILED" });
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
      expect(job).toMatchObject({ tailoringState: "BLOCKED", tailoringReasonCode: "CONFIGURATION" });
      expect(getGenerationRequest(t.handle, run.requestId)).toMatchObject({
        status: "FAILED",
        errorCode: "CONFIGURATION",
      });
    });
  });

  it("a transient NETWORK failure requeues and the next attempt recovers", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const artifactsDir = makeArtifactsDir();
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const failed = await fHandler({
        artifactsDir,
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => F_T0,
      })(first.context);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "NETWORK" });
      expect(failed.terminal).toBeUndefined();
      expect(parseFailureDetail(failed.errorDetail ?? null)).toMatchObject({
        code: "NETWORK",
        action: "retry",
        stage: "WAITING_FOR_PROVIDER",
      });
      const completed = finishAttempt(t.handle, {
        workItemId: run.workItemId,
        leaseToken: first.claimed.leaseToken,
        attemptId: first.claimed.currentAttemptId,
        outcome: failed,
      });
      expect(completed).toMatchObject({ ok: true, state: "QUEUED" });
      // No terminal moves while budget remains.
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
      expect(job?.tailoringState).toBe("RUNNING");
      expect(getGenerationRequest(t.handle, run.requestId)?.status).toBe("RUNNING");

      const second = claimFRun(t.handle, run.workItemId, { now: "2026-09-16T12:05:00.000Z" });
      const provider = new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } });
      const outcome = await fHandler({
        artifactsDir,
        provider,
        clock: () => "2026-09-16T12:05:00.000Z",
      })(second.context);
      expect(outcome.result).toBe("SUCCEEDED");
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 1 });
    });
  });

  it.each([
    { reason: "AUTHENTICATION", code: "AUTHENTICATION", terminal: true },
    { reason: "RATE_LIMIT", code: "RATE_LIMIT", terminal: false },
    { reason: "TIMEOUT", code: "PROVIDER_TIMEOUT", terminal: false },
    { reason: "NETWORK", code: "NETWORK", terminal: false },
    { reason: "INVALID_RESPONSE", code: "INVALID_RESPONSE", terminal: false },
    { reason: "LOCAL_LAUNCH", code: "LOCAL_LAUNCH", terminal: true, spawnCode: "ENOENT" },
  ] as const)(
    "maps provider reason $reason to $code (terminal=$terminal)",
    async ({ reason, code, terminal, ...rest }) => {
      await withFDatabase(async (t, world) => {
        const run = seedFRun(t.handle, world);
        const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
        const outcome = await fHandler({
          artifactsDir: makeArtifactsDir(),
          provider: throwingProvider(
            new ProviderError(
              reason,
              `simulated ${reason}`,
              "spawnCode" in rest ? rest.spawnCode : null,
            ),
          ),
          clock: () => F_T0,
        })(context);
        expect(outcome).toMatchObject({ result: "FAILED", errorCode: code });
        expect(outcome.terminal ?? false).toBe(terminal);
        const failure = parseFailureDetail(outcome.errorDetail ?? null);
        expect(failure?.code).toBe(code);
        if ("spawnCode" in rest) {
          expect(failure?.launchSubcode).toBe(rest.spawnCode);
        }
        const completed = finishAttempt(t.handle, {
          workItemId: run.workItemId,
          leaseToken: claimed.leaseToken,
          attemptId: claimed.currentAttemptId,
          outcome,
        });
        expect(completed).toMatchObject({ ok: true, state: terminal ? "FAILED" : "QUEUED" });
        const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
        expect(job?.tailoringState).toBe(terminal ? "FAILED" : "RUNNING");
      });
    },
  );

  it("an unclassified throw becomes retryable INTERNAL, never a prose leak", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: throwingProvider(new Error("weird adapter bug with secret-token-abc")),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INTERNAL" });
      expect(outcome.terminal).toBeUndefined();
      expect(outcome.errorDetail).not.toContain("secret-token-abc");
      expect(parseFailureDetail(outcome.errorDetail ?? null)).toMatchObject({
        code: "INTERNAL",
        action: "retry",
      });
    });
  });

  it("fabricated quotes fail INVALID_RESPONSE before any analysis persists", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const good = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const bad = structuredClone(good);
      const requirements = bad["requirements"] as Array<Record<string, unknown>>;
      requirements[0] = { ...requirements[0], jd_quote: "Fabricated quote about nothing" };
      const { context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new TestProvider({ proposals: { [run.jdSnapshotId]: bad } }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INVALID_RESPONSE" });
      expect(outcome.terminal).toBeUndefined();
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 0, versions: 0 });
    });
  });

  it("an unwritable artifact root fails PUBLISH_FAILED after analysis persists", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const facts = factTextsForVersion(t.handle, run.basics.profileVersionId);
      const proposal = proposalForRun({
        recommendations: run.recommendations,
        factTexts: facts,
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const blocker = join(makeArtifactsDir(), "blocker");
      writeFileSync(blocker, "not a directory");
      const { context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: blocker,
        provider: new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "PUBLISH_FAILED" });
      expect(outcome.terminal).toBeUndefined();
      expect(parseFailureDetail(outcome.errorDetail ?? null)?.stage).toBe("PUBLISHING_RESULT");
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 0 });
    });
  });

  it("a tampered payload refuses INPUT_STALE and releases the job to READY", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const row = workItemFor(t.handle, run.workItemId);
      const payload = JSON.parse(String(row.payloadJson)) as Record<string, unknown>;
      payload["inputHash"] = "f".repeat(64);
      t.handle.db
        .update(workItems)
        .set({ payloadJson: JSON.stringify(payload) })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const { context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new TestProvider({ proposals: {} }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "INPUT_STALE" });
      expect(parseFailureDetail(outcome.errorDetail ?? null)).toMatchObject({
        code: "INPUT_STALE",
        action: "edit_focus",
      });
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
      expect(job?.tailoringState).toBe("READY");
      expect(getGenerationRequest(t.handle, run.requestId)?.status).toBe("FAILED");
    });
  });

  it("maps every orchestration reason and spawn code without prose", () => {
    expect(failureCodeForReason("PROVIDER_UNAVAILABLE")).toBe("INTERNAL");
    expect(failureCodeForReason("TIMEOUT")).toBe("PROVIDER_TIMEOUT");
    expect(failureCodeForReason("AUTHENTICATION")).toBe("AUTHENTICATION");
    expect(failureCodeForReason("RATE_LIMIT")).toBe("RATE_LIMIT");
    expect(failureCodeForReason("NETWORK")).toBe("NETWORK");
    expect(failureCodeForReason("INVALID_RESPONSE")).toBe("INVALID_RESPONSE");
    expect(failureCodeForReason("LOCAL_LAUNCH")).toBe("LOCAL_LAUNCH");
    expect(failureCodeForReason("STALE_INPUT")).toBe("CLAIM_VALIDATION");
    expect(failureCodeForReason("RENDER_FAILED")).toBe("RENDER_FAILED");
    expect(launchSubcodeForSpawnCode("ENOENT")).toBe("ENOENT");
    expect(launchSubcodeForSpawnCode("EACCES")).toBe("EACCES");
    expect(launchSubcodeForSpawnCode("EPERM")).toBe("OTHER");
    expect(launchSubcodeForSpawnCode(null)).toBeNull();
    expect(launchSubcodeForSpawnCode("")).toBeNull();
    // Versioned detail round-trips; legacy text never parses.
    const encoded = encodeFailureDetail(buildFailure("NETWORK", { stage: null, occurredAt: F_T0 }));
    expect(parseFailureDetail(encoded)?.code).toBe("NETWORK");
    expect(parseFailureDetail("provider spawn failed: 'node'")).toBeNull();
    expect(parseFailureDetail('{"schemaVersion":"tailoring-failure/v0"}')).toBeNull();
  });
});

describe("F8: actual local-launch failures", () => {
  it("a missing executable reports LOCAL_LAUNCH with verified ENOENT", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new CommandProvider({ argv: ["f-definitely-missing-executable"] }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LOCAL_LAUNCH", terminal: true });
      const failure = parseFailureDetail(outcome.errorDetail ?? null);
      expect(failure).toMatchObject({
        code: "LOCAL_LAUNCH",
        action: "open_settings",
        stage: "WAITING_FOR_PROVIDER",
        launchSubcode: "ENOENT",
      });
      // Versioned envelope only: no argv, paths, or vendor claims.
      expect(outcome.errorDetail).not.toContain("f-definitely-missing-executable");
      expect(Object.keys(JSON.parse(String(outcome.errorDetail))).sort()).toEqual([
        "failure",
        "schemaVersion",
      ]);
      const completed = finishAttempt(t.handle, {
        workItemId: run.workItemId,
        leaseToken: claimed.leaseToken,
        attemptId: claimed.currentAttemptId,
        outcome,
      });
      expect(completed).toMatchObject({ ok: true, state: "FAILED" });
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
      expect(job).toMatchObject({ tailoringState: "FAILED", tailoringReasonCode: "LOCAL_LAUNCH" });
    });
  });

  it("an unlaunchable path reports LOCAL_LAUNCH with verified EACCES", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      // A directory can never exec: the kernel answers EACCES.
      const dir = makeArtifactsDir();
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new CommandProvider({ argv: [dir] }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LOCAL_LAUNCH", terminal: true });
      expect(parseFailureDetail(outcome.errorDetail ?? null)).toMatchObject({
        code: "LOCAL_LAUNCH",
        launchSubcode: "EACCES",
      });
      expect(outcome.errorDetail).not.toContain(dir);
    });
  });

  it("a non-executable file reports EACCES, never missing-Node prose", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const { context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const file = join(makeArtifactsDir(), "noexec");
      writeFileSync(file, "not executable");
      chmodSync(file, 0o644);
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new CommandProvider({ argv: [file] }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LOCAL_LAUNCH" });
      expect(parseFailureDetail(outcome.errorDetail ?? null)?.launchSubcode).toBe("EACCES");
      expect(outcome.errorDetail).not.toContain("node");
      expect(outcome.errorDetail).not.toContain(file);
    });
  });
});
