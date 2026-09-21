// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getTailoringJob,
  jobExtractions,
  jobs,
  newId,
  resumeArtifacts,
  resumeVersions,
  scrapeAttempts,
  tailoringRequestInputs,
  workItems,
} from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { readWorkspace } from "../../../src/db/tailoringWorkspace";
import { completeWorkItem } from "../../../src/queue/leases";
import { readGenerationProgress } from "../../../src/server/progress";
import { retryGeneration } from "../../../src/server/retries";
import { submitGeneration } from "../../../src/server/generations";
import {
  getRecommendations,
  workspaceRecommendationsProvider,
} from "../../../src/server/recommendations";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import { ProviderError } from "../../../src/tailoring/contract";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { F_KEYED_ENV } from "./f-world";
import {
  attemptsFor,
  claimFRun,
  factTextsForVersion,
  fHandler,
  F_T0,
  makeArtifactsDir,
  proposalForRun,
  q6,
  seedFRun,
  throwingProvider,
  withFDatabase,
} from "./f-world";

/**
 * WO-1.3-F transaction R leg (F10): attempt-specific explicit retry
 * requeues the same work through the existing primitive, replays
 * without writes, and refuses non-retryable states — while prior
 * hashes, artifacts, and the approval pointer survive untouched.
 */

const T1 = "2026-09-16T12:05:00.000Z";

describe("F10: attempt-specific retry", () => {
  it("retries a failed attempt into QUEUED and replays repeats without writes", async () => {
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
        { now: F_T0 },
      );
      const job = getTailoringJob(t.handle, run.basics.jobId);
      if (job === null) {
        throw new Error("job missing");
      }
      const retry = retryGeneration(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        observedAttemptId: first.claimed.currentAttemptId,
        observedRowVersion: job.rowVersion,
        now: T1,
      });
      expect(retry).toMatchObject({
        ok: true,
        requestId: run.requestId,
        workItemId: run.workItemId,
        status: "QUEUED",
        replayed: false,
        jobRowVersion: job.rowVersion + 1,
        workspaceRevision: 2,
      });
      // Same work requeued; no new attempt until the next claim.
      expect(attemptsFor(t.handle, run.workItemId)).toHaveLength(1);
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, run.workItemId))
        .get();
      expect(item).toMatchObject({ state: "QUEUED", maxAttempts: 4 });
      expect(getGenerationRequest(t.handle, run.requestId)).toMatchObject({
        status: "QUEUED",
        errorCode: null,
        errorDetail: null,
      });

      // Repeat: 200 replay, byte-identical rows.
      const before = JSON.stringify({
        attempts: attemptsFor(t.handle, run.workItemId),
        request: getGenerationRequest(t.handle, run.requestId),
        job: getTailoringJob(t.handle, run.basics.jobId),
        item: t.handle.db.select().from(workItems).where(eq(workItems.id, run.workItemId)).get(),
      });
      const replayed = retryGeneration(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        observedAttemptId: first.claimed.currentAttemptId,
        observedRowVersion: job.rowVersion,
        now: "2026-09-16T12:06:00.000Z",
      });
      expect(replayed).toMatchObject({ ok: true, status: "QUEUED", replayed: true });
      const after = JSON.stringify({
        attempts: attemptsFor(t.handle, run.workItemId),
        request: getGenerationRequest(t.handle, run.requestId),
        job: getTailoringJob(t.handle, run.basics.jobId),
        item: t.handle.db.select().from(workItems).where(eq(workItems.id, run.workItemId)).get(),
      });
      expect(after).toBe(before);
    });
  });

  it("an earlier observed attempt cannot requeue a later failure", async () => {
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const failOnce = async (now: string) => {
        const claimed = claimFRun(t.handle, run.workItemId, { now });
        const failed = await fHandler({
          artifactsDir: makeArtifactsDir(),
          provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
          clock: () => now,
        })(claimed.context);
        completeWorkItem(
          t.handle,
          {
            workItemId: run.workItemId,
            leaseToken: claimed.claimed.leaseToken,
            attemptId: claimed.claimed.currentAttemptId,
            result: "FAILED",
            errorCode: failed.errorCode ?? null,
            errorDetail: failed.errorDetail ?? null,
          },
          { now },
        );
        return claimed.claimed.currentAttemptId;
      };
      const attemptA = await failOnce(F_T0);
      const job = getTailoringJob(t.handle, run.basics.jobId);
      if (job === null) {
        throw new Error("job missing");
      }
      const retry = retryGeneration(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        observedAttemptId: attemptA,
        observedRowVersion: job.rowVersion,
        now: T1,
      });
      expect(retry).toMatchObject({ ok: true, replayed: false });
      // Cap the budget so the second failure is terminal too.
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 2 })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const attemptB = await failOnce("2026-09-16T12:10:00.000Z");
      expect(attemptB).not.toBe(attemptA);

      const stale = retryGeneration(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        observedAttemptId: attemptA,
        observedRowVersion: job.rowVersion,
        now: "2026-09-16T12:11:00.000Z",
      });
      expect(stale).toMatchObject({ ok: true, replayed: true, status: "FAILED" });
      expect(attemptsFor(t.handle, run.workItemId)).toHaveLength(2);

      // The latest failure remains retryable on its own observation.
      const current = getTailoringJob(t.handle, run.basics.jobId);
      if (current === null) {
        throw new Error("job missing");
      }
      const fresh = retryGeneration(t.handle, {
        jobId: run.basics.jobId,
        requestId: run.requestId,
        observedAttemptId: attemptB,
        observedRowVersion: current.rowVersion,
        now: "2026-09-16T12:12:00.000Z",
      });
      expect(fresh).toMatchObject({ ok: true, replayed: false, status: "QUEUED" });
    });
  });

  it("refuses non-retryable failures, conflicts, and stale inputs without writes", async () => {
    // Non-retryable INPUT_STALE → 422.
    await withFDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const row = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, run.workItemId))
        .get();
      const payload = JSON.parse(String(row?.payloadJson)) as Record<string, unknown>;
      payload["inputHash"] = "f".repeat(64);
      t.handle.db
        .update(workItems)
        .set({ payloadJson: JSON.stringify(payload) })
        .where(eq(workItems.id, run.workItemId))
        .run();
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: new TestProvider({ proposals: {} }),
        clock: () => F_T0,
      })(first.context);
      expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "INPUT_STALE" });
      completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "BLOCKED",
          errorCode: outcome.errorCode ?? null,
          errorDetail: outcome.errorDetail ?? null,
        },
        { now: F_T0 },
      );
      const job = getTailoringJob(t.handle, run.basics.jobId);
      if (job === null) {
        throw new Error("job missing");
      }
      const before = JSON.stringify({
        attempts: attemptsFor(t.handle, run.workItemId),
        request: getGenerationRequest(t.handle, run.requestId),
        job,
      });
      expect(
        retryGeneration(t.handle, {
          jobId: run.basics.jobId,
          requestId: run.requestId,
          observedAttemptId: first.claimed.currentAttemptId,
          observedRowVersion: job.rowVersion,
          now: T1,
        }),
      ).toMatchObject({ ok: false, failure: { error: "retry-not-allowed" } });
      const after = JSON.stringify({
        attempts: attemptsFor(t.handle, run.workItemId),
        request: getGenerationRequest(t.handle, run.requestId),
        job: getTailoringJob(t.handle, run.basics.jobId),
      });
      expect(after).toBe(before);
    });

    // Stale job revision → 409 with the current revision.
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
        { now: F_T0 },
      );
      const job = getTailoringJob(t.handle, run.basics.jobId);
      if (job === null) {
        throw new Error("job missing");
      }
      expect(
        retryGeneration(t.handle, {
          jobId: run.basics.jobId,
          requestId: run.requestId,
          observedAttemptId: first.claimed.currentAttemptId,
          observedRowVersion: job.rowVersion + 99,
          now: T1,
        }),
      ).toMatchObject({
        ok: false,
        failure: { error: "job-conflict", currentRowVersion: job.rowVersion },
      });
    });

    // Replaced extraction → 409 input-stale.
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
        { now: F_T0 },
      );
      const replacementAttemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: replacementAttemptId,
          jobId: run.basics.jobId,
          canonicalUrl: `https://example.com/jobs/${run.basics.jobId}/v2`,
          startedAt: T1,
          finishedAt: T1,
          outcome: "SUCCEEDED",
        })
        .run();
      const replacementId = newId();
      t.handle.db
        .insert(jobExtractions)
        .values({
          id: replacementId,
          jobId: run.basics.jobId,
          scrapeAttemptId: replacementAttemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: "{}",
        })
        .run();
      t.handle.db
        .update(jobs)
        .set({ activeExtractionId: replacementId })
        .where(eq(jobs.id, run.basics.jobId))
        .run();
      const job = getTailoringJob(t.handle, run.basics.jobId);
      if (job === null) {
        throw new Error("job missing");
      }
      expect(
        retryGeneration(t.handle, {
          jobId: run.basics.jobId,
          requestId: run.requestId,
          observedAttemptId: first.claimed.currentAttemptId,
          observedRowVersion: job.rowVersion,
          now: T1,
        }),
      ).toMatchObject({ ok: false, failure: { error: "input-stale" } });
    });

    // Another live run → 409 busy.
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
        { now: F_T0 },
      );
      // A newer request goes live for the same job.
      const recs = getRecommendations(t.handle, {
        jobId: run.basics.jobId,
        extractionId: run.basics.extractionId,
        profileVersionId: run.basics.profileVersionId,
      });
      if (!recs.ok) {
        throw new Error("recommendations failed");
      }
      const workspace = readWorkspace(t.handle, run.basics.jobId);
      if (workspace === null) {
        throw new Error("workspace missing");
      }
      const jobBefore = getTailoringJob(t.handle, run.basics.jobId);
      if (jobBefore === null) {
        throw new Error("job missing");
      }
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: run.basics.jobId,
          requestId: newId(),
          workspaceRevision: workspace.revision,
          observedRowVersion: jobBefore.rowVersion,
          actor: "human",
          now: T1,
        },
        { env: F_KEYED_ENV },
      );
      expect(submitted.ok).toBe(true);
      const job = getTailoringJob(t.handle, run.basics.jobId);
      if (job === null) {
        throw new Error("job missing");
      }
      expect(
        retryGeneration(t.handle, {
          jobId: run.basics.jobId,
          requestId: run.requestId,
          observedAttemptId: first.claimed.currentAttemptId,
          observedRowVersion: job.rowVersion,
          now: T1,
        }),
      ).toMatchObject({ ok: false, failure: { error: "generation-busy" } });
    });
  });

  it("changed guidance starts a new request while prior hashes survive retry", async () => {
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
      // Request 1 publishes; artifacts and pointer are the baseline.
      const first = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const published = await fHandler({
        artifactsDir,
        provider: new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } }),
        clock: () => F_T0,
      })(first.context);
      expect(published.result).toBe("SUCCEEDED");
      completeWorkItem(
        t.handle,
        {
          workItemId: run.workItemId,
          leaseToken: first.claimed.leaseToken,
          attemptId: first.claimed.currentAttemptId,
          result: "SUCCEEDED",
          inputHash: published.inputHash ?? null,
          outputHash: published.outputHash ?? null,
        },
        { now: F_T0 },
      );
      const baselineArtifacts = t.handle.db
        .select({
          relativePath: resumeArtifacts.relativePath,
          sha256: resumeArtifacts.sha256,
          byteSize: resumeArtifacts.byteSize,
        })
        .from(resumeArtifacts)
        .all();
      expect(baselineArtifacts.length).toBeGreaterThan(0);

      // Changed guidance is a new request, never a retry of request 1.
      const recs = getRecommendations(t.handle, {
        jobId: run.basics.jobId,
        extractionId: run.basics.extractionId,
        profileVersionId: run.basics.profileVersionId,
      });
      if (!recs.ok) {
        throw new Error("recommendations failed");
      }
      const workspace = readWorkspace(t.handle, run.basics.jobId);
      if (workspace === null) {
        throw new Error("workspace missing");
      }
      const parent = t.handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.jobId, run.basics.jobId))
        .get();
      if (parent === undefined) {
        throw new Error("parent version missing");
      }
      const edited = saveWorkspace(
        t.handle,
        run.basics.jobId,
        workspace.revision,
        {
          schemaVersion: "tailoring-workspace/v1",
          extractionId: run.basics.extractionId,
          profileId: run.basics.profileId,
          profileVersionId: run.basics.profileVersionId,
          requestKind: "NEW_VERSION",
          parentVersionId: parent.id,
          revisionNote: null,
          recommendationHash: workspace.recommendationHash,
          focus: {
            ...recs.recommendations.preset,
            additionalGuidance: "Changed guidance for the second run.",
          },
        },
        { now: () => T1, recommendations: workspaceRecommendationsProvider },
      );
      expect(edited.ok).toBe(true);
      const jobBefore = getTailoringJob(t.handle, run.basics.jobId);
      if (jobBefore === null) {
        throw new Error("job missing");
      }
      const secondRequestId = newId();
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: run.basics.jobId,
          requestId: secondRequestId,
          workspaceRevision: workspace.revision + 1,
          observedRowVersion: jobBefore.rowVersion,
          actor: "human",
          now: T1,
        },
        { env: F_KEYED_ENV },
      );
      if (!submitted.ok) {
        throw new Error(`second submit failed: ${submitted.failure.error}`);
      }
      expect(submitted.workItemId).not.toBe(run.workItemId);
      const priorPayloadHash = getGenerationRequest(t.handle, secondRequestId)?.payloadHash;
      const priorInputHash = t.handle.db
        .select()
        .from(tailoringRequestInputs)
        .where(eq(tailoringRequestInputs.requestId, secondRequestId))
        .get()?.inputHash;

      // Request 2 fails terminally, retries, and publishes — while
      // request 1's artifacts and every prior hash survive.
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, submitted.workItemId))
        .run();
      const attempt = claimFRun(t.handle, submitted.workItemId, { now: T1 });
      const failed = await fHandler({
        artifactsDir,
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => T1,
      })(attempt.context);
      completeWorkItem(
        t.handle,
        {
          workItemId: submitted.workItemId,
          leaseToken: attempt.claimed.leaseToken,
          attemptId: attempt.claimed.currentAttemptId,
          result: "FAILED",
          errorCode: failed.errorCode ?? null,
          errorDetail: failed.errorDetail ?? null,
        },
        { now: T1 },
      );
      const failedJob = getTailoringJob(t.handle, run.basics.jobId);
      if (failedJob === null) {
        throw new Error("job missing");
      }
      const retry = retryGeneration(t.handle, {
        jobId: run.basics.jobId,
        requestId: secondRequestId,
        observedAttemptId: attempt.claimed.currentAttemptId,
        observedRowVersion: failedJob.rowVersion,
        now: "2026-09-16T12:10:00.000Z",
      });
      expect(retry).toMatchObject({ ok: true, replayed: false, status: "QUEUED" });
      const retryClaim = claimFRun(t.handle, submitted.workItemId, {
        now: "2026-09-16T12:10:00.000Z",
      });
      const request2 = getGenerationRequest(t.handle, secondRequestId);
      const inputs2 = t.handle.db
        .select()
        .from(tailoringRequestInputs)
        .where(eq(tailoringRequestInputs.requestId, secondRequestId))
        .get();
      if (request2 === null || inputs2 === undefined) {
        throw new Error("second request rows missing");
      }
      const proposal2 = new TestProvider({
        proposals: {
          [request2.jdSnapshotId]: proposalForRun({
            recommendations: run.recommendations,
            factTexts: facts,
            jdSnapshotId: request2.jdSnapshotId,
            candidateSnapshotId: inputs2.candidateSnapshotId,
          }),
        },
      });
      const republished = await fHandler({
        artifactsDir,
        provider: proposal2,
        clock: () => "2026-09-16T12:10:00.000Z",
      })(retryClaim.context);
      expect(republished.result).toBe("SUCCEEDED");
      completeWorkItem(
        t.handle,
        {
          workItemId: submitted.workItemId,
          leaseToken: retryClaim.claimed.leaseToken,
          attemptId: retryClaim.claimed.currentAttemptId,
          result: "SUCCEEDED",
          inputHash: republished.inputHash ?? null,
          outputHash: republished.outputHash ?? null,
        },
        { now: "2026-09-16T12:10:00.000Z" },
      );

      expect(getGenerationRequest(t.handle, secondRequestId)?.payloadHash).toBe(priorPayloadHash);
      expect(
        t.handle.db
          .select()
          .from(tailoringRequestInputs)
          .where(eq(tailoringRequestInputs.requestId, secondRequestId))
          .get()?.inputHash,
      ).toBe(priorInputHash);
      const surviving = t.handle.db
        .select({
          relativePath: resumeArtifacts.relativePath,
          sha256: resumeArtifacts.sha256,
          byteSize: resumeArtifacts.byteSize,
        })
        .from(resumeArtifacts)
        .all();
      for (const row of baselineArtifacts) {
        expect(surviving).toContainEqual(row);
      }
      // Identical derived content dedupes onto version 1 instead
      // of forking — and the rerun's progress still reports the
      // committed output it converged onto.
      const versions = t.handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.jobId, run.basics.jobId))
        .all();
      expect(versions).toHaveLength(1);
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, run.basics.jobId)).get();
      expect(job?.selectedResumeVersionId).toBeNull();
      expect(q6(t.handle, run.requestId)).toEqual({ analyses: 1, versions: 1 });
      expect(q6(t.handle, secondRequestId)).toEqual({ analyses: 1, versions: 0 });
      const rerun = readGenerationProgress(t.handle, {
        jobId: run.basics.jobId,
        requestId: secondRequestId,
        now: "2026-09-16T12:10:00.000Z",
      });
      expect(rerun.ok).toBe(true);
      if (rerun.ok) {
        expect(rerun.reply).toMatchObject({
          state: "SUCCEEDED",
          resumeVersionId: versions[0]?.id,
          failure: null,
          retryAllowed: false,
        });
      }
    });
  });
});
