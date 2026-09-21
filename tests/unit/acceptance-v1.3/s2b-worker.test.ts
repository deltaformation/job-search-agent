// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import {
  appendPreparationEventFenced,
  insertPlan,
  markPreparationRunning,
  readLatestWorkAttempt,
  readPlan,
  readPreparationByJob,
  readPreparationEvents,
} from "../../../src/db/step2";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import { PREPARE_PROMPT_VERSION } from "../../../src/domain/step2";
import { PREPARE_PROMPT_VERSION_V2 } from "../../../src/domain/step2Correction";
import { completeWorkItem, recoverStaleLeases, renewLease } from "../../../src/queue/leases";
import {
  readPlanForJob,
  readPreparationStatus,
  retryPreparation,
  schedulePreparation,
} from "../../../src/server/preparation";
import type {
  PreparationProposalV1Type,
  PreparationProposalV2Type,
} from "../../../src/tailoring/contract";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { terminalizeExhaustedPreparation } from "../../../src/tailoring/prepareHandler";
import { buildAcceptedPlan } from "../../../src/tailoring/preparePlan";
import { masterProjectionHashFor, planHashFor } from "../../../src/tailoring/step2policy";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import { v13ExtractionJson } from "../db/v13world";
import {
  claimS2b,
  finishS2bAttempt,
  pmEvidenceFor,
  runS2bAttempt,
  s2bProposalKit,
  s2bQ1,
  s2bQ4,
  S2B_JD,
  S2B_KEYED_ENV,
  S2B_T0,
  scheduleS2b,
  seedS2bJob,
  withS2bDatabase,
} from "./s2b-world";

/**
 * WO-1.3-S2-B worker legs (S2B3, S2B5): real PREPARE execution with
 * the deterministic provider. Success publishes an accepted plan
 * with staged events and lineage; failures preserve the clip and
 * recover through bounded retries; expired leases cannot publish
 * or emit; crashes recover from saved plans without new calls.
 */

const KEYED = S2B_KEYED_ENV as unknown as NodeJS.ProcessEnv;

function expireS2bLease(handle: DatabaseHandle, workItemId: string): void {
  handle.db
    .update(workItems)
    .set({ leaseExpiresAt: "2026-09-17T11:00:00.000Z" })
    .where(eq(workItems.id, workItemId))
    .run();
}

describe("S2B3 successful preparation", () => {
  it("publishes an accepted plan with staged events, lineage, and zero generation/board movement", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const q4Before = s2bQ4(t.handle);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
        model: "s2b-model",
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...claimed, outcome });

      // One provider call with the bound envelope.
      expect(provider.receivedInputs).toHaveLength(1);
      const input = provider.receivedInputs[0];
      expect(input.jdSnapshotId).toBe(basics.jdSnapshotId);
      expect(input.candidateSnapshotId).toBe(kit.snapshots.candidateSnapshotId);
      expect(input.approvedFactIds).toEqual(expect.arrayContaining(["pm-fact-discovery"]));
      expect(input.promptVersion).toBe(PREPARE_PROMPT_VERSION_V2);

      // Row accepted; plan keeps supported priorities, the visible
      // gap, the usable suggestion, and the positioning angle.
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("SUCCEEDED");
      expect(row?.acceptedPlanId).not.toBeNull();
      const stored = readPlan(t.handle, row?.acceptedPlanId as string);
      expect(stored?.providerId).toBe("test-prepare-provider");
      expect(stored?.model).toBe("s2b-model");
      expect(stored?.promptVersion).toBe(PREPARE_PROMPT_VERSION_V2);
      expect(stored?.proposalSchemaVersion).toBe("preparation-proposal/v2");
      expect(stored?.claimsPolicyVersion).toBe("step2-claims/2");
      expect(stored?.inputHash).toBe(sha256HexUtf8(canonicalJson(provider.receivedInputs[0])));
      expect(stored?.proposalHash).toBe(sha256HexUtf8(canonicalJson(kit.proposal)));
      expect(stored?.supersedesPlanId).toBeNull();
      const plan = JSON.parse(stored?.planJson as string) as {
        priorities: Array<{ support: string; factIds: string[] }>;
        featuredPriorityIds: string[];
        suggestions: Array<{ usable: boolean; unusableReason: string | null }>;
        positioning: { angles: Array<{ factIds: string[] }> };
      };
      expect(plan.priorities.map((priority) => priority.support)).toEqual([
        "supported",
        "supported",
        "gap",
      ]);
      expect(plan.featuredPriorityIds.length).toBeGreaterThan(0);
      expect(plan.suggestions).toHaveLength(1);
      expect(plan.suggestions[0]).toMatchObject({ usable: true, unusableReason: null });
      expect(plan.positioning.angles).toHaveLength(1);

      // Exactly seq 1..5 with provider source on the attempt.
      const events = readPreparationEvents(t.handle, claimed.attemptId);
      expect(events.map((event) => [event.seq, event.stage, event.source])).toEqual([
        [1, "LOADING_INPUTS", "provider"],
        [2, "WAITING_FOR_PROVIDER", "provider"],
        [3, "VALIDATING_PROPOSAL", "provider"],
        [4, "STORING_PLAN", "provider"],
        [5, "PUBLISHING_PLAN", "provider"],
      ]);

      // The job row is untouched apart from P's version bump; Q1/Q4 still.
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      expect(job?.status).toBe("NEW");
      expect(job?.tailoringState).toBe("READY");
      expect(job?.rowVersion).toBe(2);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
      expect(s2bQ4(t.handle)).toEqual(q4Before);
    });
  });
});

describe("S2B3 failure preservation and bounded retry", () => {
  it("missing provider fails closed as CONFIGURATION and recovers through explicit retry", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const q4Before = s2bQ4(t.handle);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, null);
      expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "CONFIGURATION" });
      finishS2bAttempt(t.handle, { ...claimed, outcome });

      // Terminal FAILED item, versioned row failure, clip intact.
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, claimed.workItemId))
        .get();
      expect(item?.state).toBe("FAILED");
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("FAILED");
      const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(status?.failure?.code).toBe("CONFIGURATION");
      expect(status?.retryAllowed).toBe(true);
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      expect(job?.status).toBe("NEW");
      expect(job?.tailoringState).toBe("READY");
      expect(job?.activeExtractionId).toBe(basics.extractionId);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
      expect(s2bQ4(t.handle)).toEqual(q4Before);

      // Safe recovery: after the operator configures a provider, the
      // explicit retry requeues the BLOCKED attempt (mirroring R)
      // and the new run publishes on the same work item.
      const requeued = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare-retry/v1",
          observedAttemptId: claimed.attemptId,
          observedRowVersion: 2,
        },
        now: S2B_T0,
      });
      expect(requeued).toMatchObject({ ok: true, value: { replayed: false } });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const retry = claimS2b(t.handle);
      expect(retry.workItemId).toBe(claimed.workItemId);
      const recovered = await runS2bAttempt(t.handle, retry, provider);
      expect(recovered.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...retry, outcome: recovered });
      expect(readPreparationByJob(t.handle, basics.jobId)?.state).toBe("SUCCEEDED");
    });
  });

  it("transient failures auto-retry within budget", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const flaky = new TestPrepareProvider({
        proposals: {},
        failures: { [kit.snapshots.jdSnapshotId]: { reason: "TIMEOUT" } },
      });
      // Attempt 1 fails transiently: the item requeues itself.
      const first = claimS2b(t.handle);
      const failed = await runS2bAttempt(t.handle, first, flaky);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "PROVIDER_TIMEOUT" });
      expect(failed.terminal).toBeUndefined();
      finishS2bAttempt(t.handle, { ...first, outcome: failed, backoff: { baseMs: 0 } });
      const requeued = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, first.workItemId))
        .get();
      expect(requeued?.state).toBe("QUEUED");
      expect(readLatestWorkAttempt(t.handle, first.workItemId)?.result).toBe("FAILED");
      // Attempt 2 (replacement provider) succeeds; numbering kept.
      const good = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const second = claimS2b(t.handle);
      expect(second.workItemId).toBe(first.workItemId);
      const outcome = await runS2bAttempt(t.handle, second, good);
      expect(outcome.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...second, outcome });
      expect(readPreparationByJob(t.handle, basics.jobId)?.state).toBe("SUCCEEDED");
      expect(flaky.receivedInputs).toHaveLength(1);
      expect(good.receivedInputs).toHaveLength(1);
    });
  });

  it("exhausting the budget terminates; explicit retry extends it", async () => {
      await withS2bDatabase(async (t, world) => {
        const basics = seedS2bJob(t.handle, world);
        const kit = s2bProposalKit(t.handle, basics, world);
        scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
        const down = new TestPrepareProvider({
          proposals: {},
          failures: { [kit.snapshots.jdSnapshotId]: { reason: "TIMEOUT" } },
        });
        let lastAttemptId = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const claimed = claimS2b(t.handle);
          lastAttemptId = claimed.attemptId;
          const outcome = await runS2bAttempt(t.handle, claimed, down);
          expect(outcome).toMatchObject({ result: "FAILED", errorCode: "PROVIDER_TIMEOUT" });
          finishS2bAttempt(t.handle, { ...claimed, outcome, backoff: { baseMs: 0 } });
        }
        const item = t.handle.db
          .select()
          .from(workItems)
          .where(eq(workItems.jobId, basics.jobId))
          .get();
        expect(item?.state).toBe("FAILED");
        expect(item?.attemptCount).toBe(3);
        const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
        expect(status?.failure?.code).toBe("PROVIDER_TIMEOUT");
        expect(status?.retryAllowed).toBe(true);
        // Explicit retry extends the budget; attempt 4 keeps numbering.
        const requeued = retryPreparation(t.handle, {
          jobId: basics.jobId,
          body: {
            schemaVersion: "step2-prepare-retry/v1",
            observedAttemptId: lastAttemptId,
            observedRowVersion: 2,
          },
          now: S2B_T0,
        });
        expect(requeued).toMatchObject({ ok: true, value: { replayed: false } });
        const good = new TestPrepareProvider({
          proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
        });
        const fourth = claimS2b(t.handle);
        expect(fourth.workItemId).toBe(item?.id);
        const outcome = await runS2bAttempt(t.handle, fourth, good);
        expect(outcome.result).toBe("SUCCEEDED");
        finishS2bAttempt(t.handle, { ...fourth, outcome });
        expect(readLatestWorkAttempt(t.handle, item?.id as string)?.attemptNumber).toBe(4);
      });
  });

  it("invalid proposals fail INVALID_RESPONSE and publish nothing", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const kit = s2bProposalKit(t.handle, basics, world);
      // Every span fabricated: correct text, wrong offsets.
      const fabricated: PreparationProposalV2Type = {
        ...kit.proposal,
        priorities: kit.proposal.priorities.map((priority) => ({
          ...priority,
          quote: {
            text: priority.quote.text,
            startByte: priority.quote.startByte + 1,
            endByte: priority.quote.endByte + 1,
          },
        })),
      };
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: fabricated },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "INVALID_RESPONSE" });
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("FAILED");
      expect(row?.acceptedPlanId).toBeNull();
      const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(status?.failure?.code).toBe("INVALID_RESPONSE");
      expect(s2bQ1(t.handle)).toEqual(q1Before);
    });
  });
});

describe("S2B5 lease fencing and cached recovery", () => {
  it("an expired lease cannot publish or emit; the successor run converges", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      // Worker A loses its lease before doing anything.
      const stale = claimS2b(t.handle, { workerId: "s2b-worker-a" });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const lost = await runS2bAttempt(t.handle, stale, provider, { heartbeat: () => false });
      expect(lost).toMatchObject({ result: "FAILED", errorCode: "LEASE_LOST" });
      expect(provider.receivedInputs).toHaveLength(0);
      expect(readPreparationEvents(t.handle, stale.attemptId)).toHaveLength(0);
      // The expired attempt cannot emit even before reclaim: the
      // progress fence rejects the stale token.
      expireS2bLease(t.handle, stale.workItemId);
      expect(() =>
        appendPreparationEventFenced(t.handle, {
          preparationId: readPreparationByJob(t.handle, basics.jobId)?.id as string,
          workItemId: stale.workItemId,
          attemptId: stale.attemptId,
          seq: 1,
          stage: "LOADING_INPUTS",
          source: "provider",
          leaseToken: "stale-token",
          recordedAt: S2B_T0,
        }),
      ).toThrow();
      // Recovery requeues; A's completion is lease-lost; B succeeds.
      const recovered = recoverStaleLeases(t.handle, { now: S2B_T0 });
      expect(recovered).toMatchObject({ recovered: 1, requeued: 1, failed: 0 });
      const late = completeWorkItem(
        t.handle,
        {
          workItemId: stale.workItemId,
          leaseToken: stale.leaseToken,
          attemptId: stale.attemptId,
          result: lost.result,
          errorCode: lost.errorCode ?? null,
          errorDetail: lost.errorDetail ?? null,
        },
        { now: S2B_T0 },
      );
      expect(late).toEqual({ ok: false, error: "lease-lost" });
      // The expired token cannot renew either; the successor's can.
      expect(
        renewLease(t.handle, {
          workItemId: stale.workItemId,
          leaseToken: stale.leaseToken,
          leaseDurationMs: 300_000,
          now: S2B_T0,
        }),
      ).toEqual({ ok: false, error: "lease-lost" });
      const next = claimS2b(t.handle, { workerId: "s2b-worker-b" });
      expect(next.workItemId).toBe(stale.workItemId);
      const renewed = renewLease(t.handle, {
        workItemId: next.workItemId,
        leaseToken: next.leaseToken,
        leaseDurationMs: 300_000,
        now: S2B_T0,
      });
      expect(renewed).toMatchObject({ ok: true });
      const outcome = await runS2bAttempt(t.handle, next, provider);
      expect(outcome.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...next, outcome });
      expect(provider.receivedInputs).toHaveLength(1);
      expect(
        readPreparationEvents(t.handle, next.attemptId).map((event) => event.seq),
      ).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it("a crash after accept converges on the next attempt without a new provider call", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      // Attempt 1 publishes, then the worker dies before completing.
      const first = claimS2b(t.handle);
      const published = await runS2bAttempt(t.handle, first, provider);
      expect(published.result).toBe("SUCCEEDED");
      const acceptedId = readPreparationByJob(t.handle, basics.jobId)?.acceptedPlanId;
      expect(acceptedId).not.toBeNull();
      // Recovery requeues the uncompleted attempt; the successor
      // converges with a null provider (no call is possible).
      expireS2bLease(t.handle, first.workItemId);
      const recovered = recoverStaleLeases(t.handle, { now: S2B_T0 });
      expect(recovered).toMatchObject({ recovered: 1, requeued: 1 });
      const second = claimS2b(t.handle);
      const converged = await runS2bAttempt(t.handle, second, null);
      expect(converged.result).toBe("SUCCEEDED");
      expect(converged.outputHash).toBe(published.outputHash);
      finishS2bAttempt(t.handle, { ...second, outcome: converged });
      expect(readPreparationByJob(t.handle, basics.jobId)?.acceptedPlanId).toBe(acceptedId);
      expect(readPreparationEvents(t.handle, second.attemptId)).toHaveLength(0);
      expect(provider.receivedInputs).toHaveLength(1);
    });
  });

  it("a crash between store and accept recovers from the saved plan without a provider call", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const evidence = pmEvidenceFor(t.handle, world);
      const row = readPreparationByJob(t.handle, basics.jobId);
      if (row === null) {
        throw new Error("S2-B schedule left no row");
      }
      // Attempt 1 stores its plan, then dies before the accept flip.
      // The planted row is exactly the crashed state: committed plan
      // under attempt 1, preparation still RUNNING, nothing accepted.
      // A v1 row is planted deliberately: recovery must converge
      // historical rows untouched (v1-row crash-compat pin).
      const first = claimS2b(t.handle);
      markPreparationRunning(t.handle, { preparationId: row.id, now: S2B_T0 });
      const canonicalJd = canonicalText(S2B_JD);
      const v1proposal: PreparationProposalV1Type = {
        schemaVersion: "preparation-proposal/v1",
        jdSnapshotId: kit.proposal.jdSnapshotId,
        candidateSnapshotId: kit.proposal.candidateSnapshotId,
        priorities: kit.proposal.priorities,
        angles: kit.proposal.angles.map((angle) => ({
          title: angle.title,
          summaryText: angle.summaryText,
          factIds: [...angle.factIds],
        })),
        suggestions: kit.proposal.suggestions.map((suggestion) => ({
          roleId: suggestion.roleId,
          text: suggestion.text,
          factIds: [...suggestion.factIds],
        })),
        rationale: kit.proposal.rationale,
      };
      const built = buildAcceptedPlan({
        planId: newId(),
        preparationId: row.id,
        extractionId: basics.extractionId,
        jdHash: sha256HexUtf8(canonicalJd),
        canonicalJdText: canonicalJd,
        profileVersionId: world.pmVersionId,
        evidenceHash: row.evidenceHash,
        masterProjectionHash: masterProjectionHashFor(evidence.payload),
        payload: evidence.payload,
        facts: evidence.payload.achievements.map((achievement) => ({
          factId: achievement.factId,
          statement: achievement.text,
          verification: achievement.verification,
          profileVersionId: world.pmVersionId,
          employmentId: achievement.employmentId ?? null,
          metrics: [...achievement.metrics],
        })),
        proposal: v1proposal,
      });
      if (!built.ok) {
        throw new Error(`S2-B plan build failed: ${built.error}`);
      }
      const saved = insertPlan(t.handle, {
        id: built.plan.planId,
        preparationId: row.id,
        planJson: canonicalJson(built.plan),
        planHash: planHashFor(built.plan),
        providerId: "test-prepare-provider",
        model: null,
        promptVersion: PREPARE_PROMPT_VERSION,
        proposalSchemaVersion: "preparation-proposal/v1",
        claimsPolicyVersion: "step2-claims/1",
        inputHash: "0".repeat(64),
        proposalHash: "1".repeat(64),
        attemptId: first.attemptId,
        validationJson: canonicalJson(built.validation),
        supersedesPlanId: null,
        now: S2B_T0,
      });
      // Recovery requeues; attempt 2 accepts the saved plan with
      // cached-source events and zero provider calls (the provider
      // stays configured — recovery simply never calls it).
      expireS2bLease(t.handle, first.workItemId);
      const recovered = recoverStaleLeases(t.handle, { now: S2B_T0 });
      expect(recovered).toMatchObject({ recovered: 1, requeued: 1 });
      const nochain = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const second = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, second, nochain);
      expect(nochain.receivedInputs).toHaveLength(0);
      expect(outcome.result).toBe("SUCCEEDED");
      expect(outcome.outputHash).toBe(saved.planHash);
      finishS2bAttempt(t.handle, { ...second, outcome });
      expect(readPreparationByJob(t.handle, basics.jobId)?.acceptedPlanId).toBe(saved.id);
      expect(
        readPreparationEvents(t.handle, second.attemptId).map((event) => [
          event.seq,
          event.stage,
          event.source,
        ]),
      ).toEqual([
        [1, "LOADING_INPUTS", "cached"],
        [2, "WAITING_FOR_PROVIDER", "cached"],
        [3, "VALIDATING_PROPOSAL", "cached"],
        [4, "STORING_PLAN", "cached"],
        [5, "PUBLISHING_PLAN", "cached"],
      ]);
    });
  });

  it("stale recovery exhaustion terminalizes the preparation row only", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const q4Before = s2bQ4(t.handle);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      // Three claims die without completing: the third recovery
      // exhausts the item and reports it for terminalization.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        claimS2b(t.handle, { workerId: `s2b-dead-${attempt}` });
        const item = t.handle.db
          .select()
          .from(workItems)
          .where(eq(workItems.jobId, basics.jobId))
          .get();
        if (item === undefined) {
          throw new Error("S2-B lost its work item");
        }
        expireS2bLease(t.handle, item.id);
        const recovered = recoverStaleLeases(t.handle, { now: S2B_T0 });
        if (attempt < 3) {
          expect(recovered).toMatchObject({ recovered: 1, requeued: 1, failed: 0 });
        } else {
          expect(recovered).toMatchObject({ recovered: 1, requeued: 0, failed: 1 });
          expect(recovered.exhausted).toHaveLength(1);
          const terminalized = terminalizeExhaustedPreparation(t.handle, {
            jobId: basics.jobId,
            workItemId: item.id,
            attempts: recovered.exhausted[0].attempts,
            now: S2B_T0,
          });
          expect(terminalized).toEqual({ ok: true, terminalized: true });
        }
      }
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("FAILED");
      const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(status?.failure?.code).toBe("LEASE_LOST");
      expect(status?.retryAllowed).toBe(true);
      // Only the preparation row moved: job, board, generation still.
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      expect(job?.status).toBe("NEW");
      expect(job?.tailoringState).toBe("READY");
      expect(job?.rowVersion).toBe(2);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
      expect(s2bQ4(t.handle)).toEqual(q4Before);
      // Terminalizing a moved row is a no-op, never an error.
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.jobId, basics.jobId))
        .get();
      const again = terminalizeExhaustedPreparation(t.handle, {
        jobId: basics.jobId,
        workItemId: item?.id as string,
        attempts: 3,
        now: S2B_T0,
      });
      expect(again).toEqual({ ok: true, terminalized: false });
    });
  });
});

describe("S2B2 supersession keeps the accepted plan until the new one publishes", () => {
  it("re-scrape stales reads; relink retains P1; the new cycle supersedes it", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const q4Before = s2bQ4(t.handle);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const first = claimS2b(t.handle);
      const published = await runS2bAttempt(t.handle, first, provider);
      expect(published.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...first, outcome: published });
      const plan1 = readPreparationByJob(t.handle, basics.jobId)?.acceptedPlanId as string;

      // A re-scrape lands: plan reads report PLAN_STALE with the id.
      const rescrapeAttemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: rescrapeAttemptId,
          jobId: basics.jobId,
          canonicalUrl: `https://example.com/jobs/${basics.jobId}/supersede`,
          startedAt: S2B_T0,
          finishedAt: S2B_T0,
          outcome: "SUCCEEDED",
        })
        .run();
      const driftedExtractionId = newId();
      const driftedJd = `${S2B_JD}\nSecond paragraph.`;
      t.handle.db
        .insert(jobExtractions)
        .values({
          id: driftedExtractionId,
          jobId: basics.jobId,
          scrapeAttemptId: rescrapeAttemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          adapterVersion: "v1",
          extractedJson: v13ExtractionJson(driftedJd),
        })
        .run();
      t.handle.db
        .update(jobs)
        .set({ activeExtractionId: driftedExtractionId })
        .where(eq(jobs.id, basics.jobId))
        .run();
      const stale = readPlanForJob(t.handle, basics.jobId, null);
      expect(stale).toMatchObject({ ok: false, error: "plan-stale", planId: plan1 });

      // The explicit schedule relinks the same row and keeps P1 accepted.
      const relinked = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 2,
          profileId: null,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(relinked.ok).toBe(true);
      const retained = readPreparationByJob(t.handle, basics.jobId);
      expect(retained?.extractionId).toBe(driftedExtractionId);
      expect(retained?.acceptedPlanId).toBe(plan1);
      expect(retained?.state).toBe("QUEUED");

      // The new cycle publishes P2 naming P1; P1 stays inspectable.
      const kit2 = s2bProposalKit(t.handle, { ...basics, extractionId: driftedExtractionId }, world, driftedJd);
      const provider2 = new TestPrepareProvider({
        proposals: { [kit2.snapshots.jdSnapshotId]: kit2.proposal },
      });
      const second = claimS2b(t.handle);
      const republished = await runS2bAttempt(t.handle, second, provider2);
      expect(republished.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...second, outcome: republished });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.state).toBe("SUCCEEDED");
      expect(row?.acceptedPlanId).not.toBe(plan1);
      const stored2 = readPlan(t.handle, row?.acceptedPlanId as string);
      expect(stored2?.supersedesPlanId).toBe(plan1);
      const stored1 = readPlan(t.handle, plan1);
      expect(stored1?.planHash).not.toBeNull();
      expect(JSON.parse(stored1?.planJson as string).planId).toBe(plan1);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
      expect(s2bQ4(t.handle)).toEqual(q4Before);
    });
  });
});
