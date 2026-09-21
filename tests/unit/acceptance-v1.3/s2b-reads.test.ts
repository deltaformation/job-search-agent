// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  intakeItems,
  jobs,
  newId,
  workAttempts,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { saveWorkspaceCAS } from "../../../src/db/tailoringWorkspace";
import { readPreparationByJob } from "../../../src/db/step2";
import { claimNextWorkItem, completeWorkItem } from "../../../src/queue/leases";
import {
  ensureFetchShell,
  persistFetchOutcome,
  type PersistExtractionInput,
} from "../../../src/scraping/evidence";
import type { DnsResolver } from "../../../src/scraping/ssrf";
import { getOrCreateJdSnapshot } from "../../../src/server/candidates";
import { submitIntakeBatch } from "../../../src/server/intake";
import {
  readPlanForJob,
  readPreparationStatus,
  retryPreparation,
  validateDraft,
} from "../../../src/server/preparation";
import { getBatchView } from "../../../src/server/queries";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import {
  claimS2b,
  finishS2bAttempt,
  runS2bAttempt,
  s2bProposalKit,
  seedV1Accepted,
  S2B_JD,
  S2B_T0,
  scheduleS2b,
  seedS2bJob,
  withS2bDatabase,
} from "./s2b-world";

/**
 * WO-1.3-S2-B reads (S2B3 diagnostics, S2B5 purity): the batch view
 * exposes separate scrape/preparation results with safe recovery
 * signals; status/plan/validate reads never heal, rebind, or call
 * providers; draft validation is advisory and persists verdicts.
 */

function publicResolver(): DnsResolver {
  return async () => ["93.184.216.34"];
}

async function submitLines(
  t: TestDatabase,
  lines: string[],
): Promise<{ batchId: string; intakeItemIds: string[] }> {
  const result = await submitIntakeBatch({
    handle: t.handle,
    resolveHost: publicResolver(),
    lines,
  });
  return {
    batchId: result.batchId,
    intakeItemIds: result.results.map((line) => line.intakeItemId),
  };
}

function extractionFor(jdText: string): PersistExtractionInput {
  return {
    fields: {
      title: "Product Manager",
      company: "Harbor Analytics",
      location: "Remote",
      arrangement: "REMOTE",
      salaryText: null,
      salaryCurrency: null,
      salaryMinMinor: null,
      salaryMaxMinor: null,
      descriptionText: jdText,
      postedAt: null,
      applyUrl: null,
    },
    provenance: {},
    adapterId: "generic",
    adapterVersion: "1",
    confidence: 0.9,
    missingFields: [],
    contentHash: "a".repeat(64),
  };
}

function persistSuccess(
  t: TestDatabase,
  intakeItemId: string,
  evidenceDir: string,
  keyPresent = true,
): { jobId: string; extractionId: string | null } {
  const item = t.handle.db
    .select()
    .from(intakeItems)
    .where(eq(intakeItems.id, intakeItemId))
    .get();
  const payload = {
    schemaVersion: "scrape-payload-v1" as const,
    submittedUrl: item?.rawInput ?? "",
    canonicalUrl: item?.canonicalUrl ?? "",
    canonicalKey: `url:${item?.canonicalUrl ?? ""}`,
  };
  const shell = ensureFetchShell(t.handle, { payload, now: S2B_T0 });
  if (!shell.ok) {
    throw new Error("S2-B shell failed");
  }
  const persisted = persistFetchOutcome(t.handle, {
    payload,
    jobId: shell.jobId,
    intakeItemId,
    workerId: "s2b-worker",
    startedAt: S2B_T0,
    finishedAt: S2B_T0,
    finalUrl: item?.canonicalUrl ?? "",
    httpStatus: 200,
    outcome: "SUCCEEDED",
    reasonCode: null,
    detail: null,
    artifacts: [],
    evidenceDir,
    extraction: extractionFor(S2B_JD),
    providerKeyPresent: keyPresent,
    now: S2B_T0,
  });
  return { jobId: shell.jobId, extractionId: persisted.extractionId };
}

function queueCounts(t: TestDatabase): {
  items: number;
  attempts: number;
  prepares: number;
} {
  return {
    items: t.handle.db.select({ n: count() }).from(workItems).get()?.n ?? 0,
    attempts: t.handle.db.select({ n: count() }).from(workAttempts).get()?.n ?? 0,
    prepares: t.handle.db.select().from(workItems).where(eq(workItems.kind, "PREPARE")).all().length,
  };
}

/** Finish QUEUED SCRAPE items the way the dispatcher would after persist. */
function finishScrapes(
  t: TestDatabase,
  outcomes: Map<string, "SUCCEEDED" | "FAILED">,
): void {
  const claimed = [];
  for (let pending = 0; pending < outcomes.size; pending += 1) {
    const item = claimNextWorkItem(t.handle, {
      workerId: "s2b-worker",
      kinds: ["SCRAPE"],
      leaseDurationMs: 300_000,
      now: S2B_T0,
    });
    if (item === null) {
      throw new Error("S2-B SCRAPE claim missed its line");
    }
    claimed.push(item);
  }
  for (const item of claimed) {
    const result = outcomes.get(item.intakeItemId as string);
    if (result === undefined) {
      throw new Error("S2-B SCRAPE claim covered an unexpected line");
    }
    const finished = completeWorkItem(
      t.handle,
      {
        workItemId: item.id,
        leaseToken: item.leaseToken as string,
        attemptId: item.currentAttemptId as string,
        result,
        errorCode: result === "FAILED" ? "CAPTCHA_REQUIRED" : null,
        errorDetail: null,
      },
      { now: S2B_T0, terminal: result === "FAILED" },
    );
    if (!finished.ok) {
      throw new Error("S2-B SCRAPE completion failed");
    }
  }
}

describe("S2B3 batch diagnostics", () => {
  it("exposes separate scrape and preparation results, with duplicates inheriting", async () => {
    await withS2bDatabase(async (t) => {
      const evidenceDir = mkdtempSync(join(tmpdir(), "s2b-reads-"));
      try {
        const firstUrl = "https://example.com/jobs/s2b-read-ok";
        const failedUrl = "https://example.com/jobs/s2b-read-fail";
        const { batchId, intakeItemIds } = await submitLines(t, [firstUrl, failedUrl]);
        // Line 1 runs to an accepted plan through the real pipeline.
        const line1 = persistSuccess(t, intakeItemIds[0], evidenceDir);
        const row1 = readPreparationByJob(t.handle, line1.jobId);
        expect(row1?.state).toBe("QUEUED");
        // Line 2's scrape fails; its capture stays pending and unlinked.
        const failed = t.handle.db
          .select()
          .from(intakeItems)
          .where(eq(intakeItems.id, intakeItemIds[1]))
          .get();
        const failedPayload = {
          schemaVersion: "scrape-payload-v1" as const,
          submittedUrl: failed?.rawInput ?? "",
          canonicalUrl: failed?.canonicalUrl ?? "",
          canonicalKey: `url:${failed?.canonicalUrl ?? ""}`,
        };
        const failedShell = ensureFetchShell(t.handle, { payload: failedPayload, now: S2B_T0 });
        if (!failedShell.ok) {
          throw new Error("S2-B shell failed");
        }
        persistFetchOutcome(t.handle, {
          payload: failedPayload,
          jobId: failedShell.jobId,
          intakeItemId: intakeItemIds[1],
          workerId: "s2b-worker",
          startedAt: S2B_T0,
          finishedAt: S2B_T0,
          finalUrl: failed?.canonicalUrl ?? "",
          httpStatus: null,
          outcome: "FAILED",
          reasonCode: "CAPTCHA_REQUIRED",
          detail: "captcha",
          artifacts: [],
          evidenceDir,
          providerKeyPresent: true,
          now: S2B_T0,
        });

        finishScrapes(
          t,
          new Map([
            [intakeItemIds[0], "SUCCEEDED"],
            [intakeItemIds[1], "FAILED"],
          ]),
        );
        const view = getBatchView(t.handle, batchId);
        expect(view?.items).toHaveLength(2);
        // Scrape and preparation read separately on each line.
        expect(view?.items[0].outcome).toBe("ENQUEUED");
        expect(view?.items[0].queue?.workState).toBe("SUCCEEDED");
        expect(view?.items[0].preparation?.state).toBe("QUEUED");
        expect(view?.items[0].preparation?.jobId).toBe(line1.jobId);
        expect(view?.items[0].preparation?.failureCode).toBeNull();
        expect(view?.items[0].preparation?.retryAllowed).toBe(false);
        expect(view?.items[1].outcome).toBe("ENQUEUED");
        expect(view?.items[1].queue?.workState).toBe("FAILED");
        expect(view?.items[1].preparation?.state).toBe("PENDING");
        expect(view?.items[1].preparation?.jobId).toBeNull();

        // A duplicate clip inherits the owning job's preparation.
        const duped = await submitLines(t, [firstUrl]);
        const dupView = getBatchView(t.handle, duped.batchId);
        expect(duped.intakeItemIds).toHaveLength(1);
        expect(dupView?.items[0].outcome).toBe("DUPLICATE");
        expect(dupView?.items[0].jobId).toBe(line1.jobId);
        expect(dupView?.items[0].preparation?.state).toBe("QUEUED");
        expect(dupView?.items[0].preparation?.preparationId).toBe(
          view?.items[0].preparation?.preparationId,
        );
        expect(dupView?.items[0].preparation?.jobId).toBe(line1.jobId);
      } finally {
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    });
  });

  it("failed preparation surfaces its code and recovery; retry clears the signal", async () => {
    await withS2bDatabase(async (t) => {
      const evidenceDir = mkdtempSync(join(tmpdir(), "s2b-reads-fail-"));
      try {
        const url = "https://example.com/jobs/s2b-read-auth";
        const { batchId, intakeItemIds } = await submitLines(t, [url]);
        const line = persistSuccess(t, intakeItemIds[0], evidenceDir);
        const jdSnapshot = getOrCreateJdSnapshot(t.handle, {
          jobId: line.jobId,
          extractionId: line.extractionId as string,
          jdText: S2B_JD,
        });
        if (!jdSnapshot.ok) {
          throw new Error("S2-B JD snapshot failed");
        }
        const authProvider = new TestPrepareProvider({
          proposals: {},
          failures: { [jdSnapshot.snapshotId]: { reason: "AUTHENTICATION" } },
        });
        const claimed = claimS2b(t.handle);
        const outcome = await runS2bAttempt(t.handle, claimed, authProvider);
        finishS2bAttempt(t.handle, { ...claimed, outcome });

        const failed = getBatchView(t.handle, batchId);
        expect(failed?.items[0].preparation).toMatchObject({
          state: "FAILED",
          failureCode: "AUTHENTICATION",
          retryAllowed: true,
          jobId: line.jobId,
        });
        expect(failed?.items[0].preparation?.acceptedPlanId).toBeNull();

        // Explicit retry requeues; the batch read follows the recovery.
        const requeued = retryPreparation(t.handle, {
          jobId: line.jobId,
          body: {
            schemaVersion: "step2-prepare-retry/v1",
            observedAttemptId: claimed.attemptId,
            observedRowVersion: 1,
          },
          now: S2B_T0,
        });
        expect(requeued.ok).toBe(true);
        const recovering = getBatchView(t.handle, batchId);
        expect(recovering?.items[0].preparation).toMatchObject({
          state: "QUEUED",
          failureCode: null,
          retryAllowed: false,
        });
      } finally {
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    });
  });
});

describe("S2B5 read purity and lifecycle", () => {
  it("status walks ABSENT to SUCCEEDED with zero side effects", async () => {
    await withS2bDatabase(async (t, world) => {
      // Legacy seeded job: no row, ABSENT.
      const legacy = seedS2bJob(t.handle, world);
      const absent = readPreparationStatus(t.handle, legacy.jobId, S2B_T0);
      expect(absent).toMatchObject({
        state: "ABSENT",
        preparationId: null,
        binding: null,
        retryAllowed: false,
      });
      expect(readPreparationStatus(t.handle, "no-such-job", S2B_T0)).toBeNull();

      // Full lifecycle on a second job.
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      const before = queueCounts(t);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const queued = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(queued).toMatchObject({ state: "QUEUED", retryAllowed: false });
      expect(queued?.binding?.profileVersionId).toBe(world.pmVersionId);
      expect(queued?.events).toEqual([]);
      const claimed = claimS2b(t.handle);
      const running = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(running?.state).toBe("QUEUED");
      expect(running?.attemptId).toBe(claimed.attemptId);
      expect(running?.leaseExpiresAt).toBe(claimed.leaseExpiresAt);
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const done = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(done).toMatchObject({ state: "SUCCEEDED", retryAllowed: false });
      expect(done?.acceptedPlanId).not.toBeNull();
      expect(done?.acceptedPlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(done?.events.map((event) => event.stage)).toEqual([
        "LOADING_INPUTS",
        "WAITING_FOR_PROVIDER",
        "VALIDATING_PROPOSAL",
        "STORING_PLAN",
        "PUBLISHING_PLAN",
      ]);
      expect(done?.failure).toBeNull();
      // Reads add no queue rows; the run made exactly one provider call.
      const after = queueCounts(t);
      expect(after.items).toBe(before.items + 1);
      expect(after.attempts).toBe(before.attempts + 1);
      expect(provider.receivedInputs).toHaveLength(1);
      // Repeated status/plan reads plus workspace autosaves (the
      // navigation/autosave loop) cause zero queue inserts and zero
      // provider calls: reads never schedule, heal, or rebind.
      let revision = 0;
      for (let read = 0; read < 5; read += 1) {
        readPreparationStatus(t.handle, basics.jobId, S2B_T0);
        readPlanForJob(t.handle, basics.jobId, null);
        const saved = saveWorkspaceCAS(t.handle, {
          jobId: basics.jobId,
          observedRevision: revision,
          extractionId: basics.extractionId,
          profileId: world.pmProfileId,
          profileVersionId: world.pmVersionId,
          requestKind: "INITIAL",
          parentVersionId: null,
          revisionNote: null,
          focusJson: "{}",
          recommendationsJson: null,
          recommendationHash: null,
          now: S2B_T0,
        });
        if (!saved.ok) {
          throw new Error("S2-B autosave failed");
        }
        revision = saved.revision;
      }
      expect(queueCounts(t)).toEqual(after);
      expect(provider.receivedInputs).toHaveLength(1);
    });
  });

  it("failure prefers the row record and retries only retryable codes", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const authProvider = new TestPrepareProvider({
        proposals: {},
        failures: { [basics.jdSnapshotId]: { reason: "AUTHENTICATION" } },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, authProvider);
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(status?.state).toBe("FAILED");
      expect(status?.failure?.code).toBe("AUTHENTICATION");
      expect(status?.retryAllowed).toBe(true);
      expect(status?.attemptId).toBe(claimed.attemptId);
      expect(status?.finishedAt).not.toBeNull();
    });
  });

  it("plan reads serve accepted and owned plans, refuse foreign and stale ones", async () => {
    await withS2bDatabase(async (t, world) => {
      const first = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, first, world);
      expect(readPlanForJob(t.handle, first.jobId, null)).toMatchObject({
        ok: false,
        error: "plan-not-found",
      });
      scheduleS2b(t.handle, first, { profileId: world.pmProfileId });
      expect(readPlanForJob(t.handle, first.jobId, null)).toMatchObject({
        ok: false,
        error: "plan-not-found",
      });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      const accepted = readPlanForJob(t.handle, first.jobId, null);
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) {
        throw new Error("S2-B plan read failed");
      }
      expect(accepted.value.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(accepted.value.supersedesPlanId).toBeNull();
      const named = readPlanForJob(
        t.handle,
        first.jobId,
        readPreparationByJob(t.handle, first.jobId)?.acceptedPlanId ?? null,
      );
      expect(named).toMatchObject({ ok: true });

      // A foreign plan id (owned by another job) refuses.
      const second = seedS2bJob(t.handle, world);
      const kit2 = s2bProposalKit(t.handle, second, world);
      scheduleS2b(t.handle, second, { profileId: world.pmProfileId });
      const provider2 = new TestPrepareProvider({
        proposals: { [kit2.snapshots.jdSnapshotId]: kit2.proposal },
      });
      const claimed2 = claimS2b(t.handle);
      const outcome2 = await runS2bAttempt(t.handle, claimed2, provider2);
      finishS2bAttempt(t.handle, { ...claimed2, outcome: outcome2 });
      const foreignPlanId = readPreparationByJob(t.handle, second.jobId)?.acceptedPlanId as string;
      expect(readPlanForJob(t.handle, first.jobId, foreignPlanId)).toMatchObject({
        ok: false,
        error: "plan-not-found",
      });
      expect(readPlanForJob(t.handle, first.jobId, "no-such-plan")).toMatchObject({
        ok: false,
        error: "plan-not-found",
      });
      expect(readPlanForJob(t.handle, "no-such-job", null)).toMatchObject({
        ok: false,
        error: "job-not-found",
      });
    });
  });

  it("draft validation is advisory, persists verdicts, and refuses stale inputs", async () => {
    await withS2bDatabase(async (t, world) => {
      // The world seeds profile versions at real-now; this flow runs
      // on a clock past real-now so chronology Rule 1 sees the
      // production ordering (version before plan before validation).
      const later = new Date(Date.now() + 3_600_000).toISOString();
      // Direct v1 seed: this leg proves the preserved v1 validation
      // path (the handler produces v2 plans after the cutover).
      const seed = seedV1Accepted(t.handle, world, S2B_JD, later);
      const basics = seed.basics;
      const plan = seed.plan;
      const saved = saveWorkspaceCAS(t.handle, {
        jobId: basics.jobId,
        observedRevision: 0,
        extractionId: basics.extractionId,
        profileId: world.pmProfileId,
        profileVersionId: world.pmVersionId,
        requestKind: "INITIAL",
        parentVersionId: null,
        revisionNote: null,
        focusJson: "{}",
        recommendationsJson: null,
        recommendationHash: null,
        now: later,
      });
      expect(saved.ok).toBe(true);

      const queueBefore = queueCounts(t);
      // Supported verbatim add plus an unsupported number: advisory
      // needs-evidence is data, and the verdict row persists.
      const goodOpId = newId();
      const gapOpId = newId();
      const advisory = validateDraft(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: 1,
          summaryText: "Product manager.",
          operations: [
            {
              op: "add",
              operationId: goodOpId,
              suggestionId: plan.suggestions[0].suggestionId,
              roleId: "emp-harbor",
              editedText: null,
            },
            {
              op: "add",
              operationId: gapOpId,
              suggestionId: plan.suggestions[0].suggestionId,
              roleId: "emp-harbor",
              editedText: "Led discovery with 400+ buyers.",
            },
          ],
        },
        now: later,
      });
      expect(advisory.ok).toBe(true);
      if (!advisory.ok) {
        throw new Error("S2-B validation failed");
      }
      const verdicts = new Map(
        advisory.value.validation.segments.map((segment) => [segment.segmentId, segment.verdict]),
      );
      expect(verdicts.get(`op:${goodOpId}`)).toBe("supported");
      expect(verdicts.get(`op:${gapOpId}`)).toBe("needs-evidence");
      expect(advisory.value.validationId).not.toBe("");
      // No queue movement and no provider call from the validation.
      expect(queueCounts(t)).toEqual(queueBefore);

      // Stale workspace revision conflicts with the current revision.
      const conflicted = validateDraft(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: 7,
          summaryText: "Product manager.",
          operations: [],
        },
        now: later,
      });
      expect(conflicted).toMatchObject({
        ok: false,
        error: "workspace-conflict",
        currentWorkspaceRevision: 1,
      });
      expect(validateDraft(t.handle, { jobId: "no-such-job", body: {
        schemaVersion: "step2-validate-draft/v1",
        workspaceRevision: 1,
        summaryText: "",
        operations: [],
      }, now: later })).toMatchObject({ ok: false, error: "job-not-found" });
      // A job with no accepted plan has nothing to validate against.
      const bare = seedS2bJob(t.handle, world);
      expect(validateDraft(t.handle, {
        jobId: bare.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: 1,
          summaryText: "",
          operations: [],
        },
        now: S2B_T0,
      })).toMatchObject({ ok: false, error: "plan-not-found" });
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      expect(job?.rowVersion).toBe(2);
    });
  });
});
