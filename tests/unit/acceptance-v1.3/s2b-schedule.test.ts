// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  candidateProfiles,
  generationRequests,
  intakeItems,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import {
  ensureFetchShell,
  persistFetchOutcome,
  type PersistExtractionInput,
} from "../../../src/scraping/evidence";
import { submitIntakeBatch } from "../../../src/server/intake";
import {
  retryPreparation,
  schedulePreparation,
} from "../../../src/server/preparation";
import { readLatestWorkAttempt, readPreparationByIntakeItem, readPreparationByJob } from "../../../src/db/step2";
import type { HandlerOutcome } from "../../../src/queue/dispatch";
import { IntakeBindingV1 } from "../../../src/domain/step2";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import { v13ExtractionJson } from "../db/v13world";
import type { DnsResolver } from "../../../src/scraping/ssrf";
import {
  S2B_JD,
  S2B_KEYED_ENV,
  S2B_T0,
  S2B_UNKEYED_ENV,
  claimS2b,
  finishS2bAttempt,
  runS2bAttempt,
  s2bContext,
  s2bProposalKit,
  s2bHandler,
  s2bQ1,
  s2bQ4,
  scheduleS2b,
  seedS2bJob,
  withS2bDatabase,
} from "./s2b-world";

/**
 * WO-1.3-S2-B / S2B2: successful extraction idempotently schedules
 * preparation with zero generation/board movement; the explicit
 * command matrix (202/200/409/422/404) holds with zero writes on
 * every refusal; supersession keeps the old accepted plan until
 * the new one publishes.
 */

function publicResolver(): DnsResolver {
  return async () => ["93.184.216.34"];
}

const KEYED = S2B_KEYED_ENV as unknown as NodeJS.ProcessEnv;
const UNKEYED = S2B_UNKEYED_ENV as unknown as NodeJS.ProcessEnv;

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

async function submitOne(
  t: TestDatabase,
  url: string,
): Promise<{ batchId: string; intakeItemId: string }> {
  const result = await submitIntakeBatch({
    handle: t.handle,
    resolveHost: publicResolver(),
    lines: [url],
  });
  if (result.results[0].outcome !== "ENQUEUED") {
    throw new Error(`S2-B line did not enqueue: ${result.results[0].outcome}`);
  }
  return { batchId: result.batchId, intakeItemId: result.results[0].intakeItemId };
}

describe("S2B2 extraction linkage", () => {
  it("successful extraction links and schedules exactly one PREPARE item", async () => {
    await withS2bDatabase(async (t) => {
      const evidenceDir = mkdtempSync(join(tmpdir(), "s2b-link-"));
      try {
        const { intakeItemId } = await submitOne(t, "https://example.com/jobs/s2b-link-1");
        const item = t.handle.db
          .select()
          .from(intakeItems)
          .where(eq(intakeItems.id, intakeItemId))
          .get();
        const shell = ensureFetchShell(t.handle, {
          payload: {
            schemaVersion: "scrape-payload-v1",
            submittedUrl: item?.rawInput ?? "",
            canonicalUrl: item?.canonicalUrl ?? "",
            canonicalKey: `url:${item?.canonicalUrl ?? ""}`,
          },
          now: S2B_T0,
        });
        if (!shell.ok) {
          throw new Error("S2-B shell failed");
        }
        const q1Before = s2bQ1(t.handle);
        const q4Before = s2bQ4(t.handle);
        const analysesBefore = t.handle.db.select({ n: count() }).from(jobAnalyses).get()?.n ?? 0;
        const requestsBefore = t.handle.db.select().from(generationRequests).all().length;
        const persisted = persistFetchOutcome(t.handle, {
          payload: {
            schemaVersion: "scrape-payload-v1",
            submittedUrl: item?.rawInput ?? "",
            canonicalUrl: item?.canonicalUrl ?? "",
            canonicalKey: `url:${item?.canonicalUrl ?? ""}`,
          },
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
          providerKeyPresent: true,
          now: S2B_T0,
        });
        expect(persisted.extractionId).not.toBeNull();
        const row = readPreparationByIntakeItem(t.handle, intakeItemId);
        expect(row?.jobId).toBe(shell.jobId);
        expect(row?.extractionId).toBe(persisted.extractionId);
        expect(row?.state).toBe("QUEUED");
        expect(row?.workItemId).not.toBeNull();
        const prepares = t.handle.db
          .select()
          .from(workItems)
          .where(eq(workItems.kind, "PREPARE"))
          .all();
        expect(prepares).toHaveLength(1);
        expect(prepares[0].maxAttempts).toBe(3);
        expect(prepares[0].idempotencyKey).toBe(
          `prepare:${shell.jobId}:${row?.id}:${persisted.extractionId}`,
        );
        // Preparation creates no generation request, version,
        // review, analysis, or board movement (delta-zero against
        // the seeded world, which owns its own rows).
        expect(s2bQ1(t.handle)).toEqual(q1Before);
        expect(s2bQ4(t.handle)).toEqual(q4Before);
        expect(t.handle.db.select({ n: count() }).from(jobAnalyses).get()?.n ?? 0).toBe(analysesBefore);
        expect(t.handle.db.select().from(generationRequests).all()).toHaveLength(requestsBefore);
      } finally {
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    });
  });

  it("crash recovery, live TAILOR, missing key, and missing binding never duplicate or fail the clip", async () => {
    await withS2bDatabase(async (t) => {
      const evidenceDir = mkdtempSync(join(tmpdir(), "s2b-link-skip-"));
      try {
        const { intakeItemId } = await submitOne(t, "https://example.com/jobs/s2b-link-2");
        const shellFor = (itemId: string) => {
          const item = t.handle.db
            .select()
            .from(intakeItems)
            .where(eq(intakeItems.id, itemId))
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
          return { item, payload, shell };
        };
        const persist = (itemId: string, jobId: string, keyPresent: boolean, jdText = S2B_JD) => {
          const item = t.handle.db
            .select()
            .from(intakeItems)
            .where(eq(intakeItems.id, itemId))
            .get();
          const payload = {
            schemaVersion: "scrape-payload-v1" as const,
            submittedUrl: item?.rawInput ?? "",
            canonicalUrl: item?.canonicalUrl ?? "",
            canonicalKey: `url:${item?.canonicalUrl ?? ""}`,
          };
          return persistFetchOutcome(t.handle, {
            payload,
            jobId,
            intakeItemId: itemId,
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
            extraction: extractionFor(jdText),
            providerKeyPresent: keyPresent,
            now: S2B_T0,
          });
        };
        // Missing key: linked, PENDING, no work item.
        const { shell } = shellFor(intakeItemId);
        persist(intakeItemId, shell.jobId, false);
        const row = readPreparationByIntakeItem(t.handle, intakeItemId);
        expect(row?.state).toBe("PENDING");
        expect(row?.jobId).not.toBeNull();
        const countPrepares = () =>
          t.handle.db.select().from(workItems).where(eq(workItems.kind, "PREPARE")).all().length;
        expect(countPrepares()).toBe(0);
        // Crash between shell and persist: re-entering the shell and
        // persisting once links and schedules exactly one item.
        const { intakeItemId: crashItem } = await submitOne(t, "https://example.com/jobs/s2b-link-crash");
        const firstShell = shellFor(crashItem).shell;
        const reentered = shellFor(crashItem).shell;
        expect(reentered.jobId).toBe(firstShell.jobId);
        persist(crashItem, firstShell.jobId, true);
        const crashed = readPreparationByIntakeItem(t.handle, crashItem);
        expect(crashed?.state).toBe("QUEUED");
        expect(countPrepares()).toBe(1);
        // Duplicate dispatch after success aborts instead of duplicating.
        expect(() => persist(crashItem, firstShell.jobId, true)).toThrow();
        expect(countPrepares()).toBe(1);
        expect(readPreparationByIntakeItem(t.handle, crashItem)?.state).toBe("QUEUED");
        // Live TAILOR blocks the automatic schedule (fresh line).
        const { intakeItemId: thirdItem } = await submitOne(t, "https://example.com/jobs/s2b-link-3");
        const third = t.handle.db
          .select()
          .from(intakeItems)
          .where(eq(intakeItems.id, thirdItem))
          .get();
        const thirdPayload = {
          schemaVersion: "scrape-payload-v1" as const,
          submittedUrl: third?.rawInput ?? "",
          canonicalUrl: third?.canonicalUrl ?? "",
          canonicalKey: `url:${third?.canonicalUrl ?? ""}`,
        };
        const thirdShell = ensureFetchShell(t.handle, { payload: thirdPayload, now: S2B_T0 });
        if (!thirdShell.ok) {
          throw new Error("S2-B shell failed");
        }
        t.handle.db
          .insert(workItems)
          .values({
            id: newId(),
            kind: "TAILOR",
            idempotencyKey: `tailor-block:${thirdShell.jobId}`,
            jobId: thirdShell.jobId,
            payloadJson: JSON.stringify({ schemaVersion: "tailor-queue/v3" }),
          })
          .run();
        persistFetchOutcome(t.handle, {
          payload: thirdPayload,
          jobId: thirdShell.jobId,
          intakeItemId: thirdItem,
          workerId: "s2b-worker",
          startedAt: S2B_T0,
          finishedAt: S2B_T0,
          finalUrl: third?.canonicalUrl ?? "",
          httpStatus: 200,
          outcome: "SUCCEEDED",
          reasonCode: null,
          detail: null,
          artifacts: [],
          evidenceDir,
          extraction: extractionFor(S2B_JD),
          providerKeyPresent: true,
          now: S2B_T0,
        });
        const blocked = readPreparationByIntakeItem(t.handle, thirdItem);
        expect(blocked?.state).toBe("PENDING");
        expect(blocked?.workItemId).toBeNull();
        expect(countPrepares()).toBe(1);
        // The clip itself still succeeded: scrape SUCCEEDED with the
        // extraction kept (the live TAILOR run keeps the job's
        // PENDING tailoring state per R-ADR-015).
        const blockedJob = t.handle.db.select().from(jobs).where(eq(jobs.id, thirdShell.jobId)).get();
        expect(blockedJob?.scrapeState).toBe("SUCCEEDED");
        expect(blockedJob?.activeExtractionId).not.toBeNull();
        expect(blockedJob?.tailoringState).toBe("PENDING");
        // Missing binding (no default profile at acceptance): the clip
        // still succeeds with no preparation row and no PREPARE item.
        t.handle.db.update(candidateProfiles).set({ isDefault: false }).run();
        const { intakeItemId: nobindItem } = await submitOne(t, "https://example.com/jobs/s2b-link-nobind");
        expect(readPreparationByIntakeItem(t.handle, nobindItem)).toBeNull();
        const { shell: nobindShell } = shellFor(nobindItem);
        const nobindPersisted = persist(nobindItem, nobindShell.jobId, true);
        expect(nobindPersisted.extractionId).not.toBeNull();
        expect(readPreparationByIntakeItem(t.handle, nobindItem)).toBeNull();
        expect(countPrepares()).toBe(1);
        const nobindJob = t.handle.db.select().from(jobs).where(eq(jobs.id, nobindShell.jobId)).get();
        expect(nobindJob?.tailoringState).toBe("READY");
      } finally {
        rmSync(evidenceDir, { recursive: true, force: true });
      }
    });
  });
});

describe("S2B2 explicit schedule matrix", () => {
  it("202 schedules, 200 replays, 409 conflicts, with zero writes on refusal", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const operationId = newId();
      const first = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId,
          observedRowVersion: 1,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error("S2-B schedule failed");
      }
      expect(first.value).toEqual({
        preparationId: first.value.preparationId,
        state: "QUEUED",
        replayed: false,
        profileId: world.pmProfileId,
        profileVersionId: world.pmVersionId,
      });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.profileVersionId).toBe(world.pmVersionId);
      expect(row?.lastOperationId).toBe(operationId);
      // Identical replay (exact bytes, including the observed
      // version) converges with zero writes.
      const replay = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId,
          observedRowVersion: 1,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(replay).toEqual({
        ok: true,
        value: {
          preparationId: first.value.preparationId,
          state: "QUEUED",
          replayed: true,
          profileId: world.pmProfileId,
          profileVersionId: world.pmVersionId,
        },
      });
      // Same id, changed bytes (even just the observed version):
      // conflict.
      const mismatch = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId,
          observedRowVersion: 2,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(mismatch.ok).toBe(false);
      if (mismatch.ok) {
        throw new Error("unreachable");
      }
      expect(mismatch.error).toBe("idempotency-mismatch");
      // Live run: busy.
      const busy = schedulePreparation(t.handle, {
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
      expect(busy.ok).toBe(false);
      if (busy.ok) {
        throw new Error("unreachable");
      }
      expect(busy.error).toBe("preparation-busy");
      expect(s2bQ1(t.handle)).toEqual(q1Before);
    });
  });

  it("unknown job/profile, conflicts, rejection, and unreadiness refuse write-free", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const q4Before = s2bQ4(t.handle);
      const missing = schedulePreparation(t.handle, {
        jobId: newId(),
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(missing.ok).toBe(false);
      const unknownProfile = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: "no-such-profile",
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(unknownProfile).toMatchObject({ ok: false, error: "profile-unknown" });
      const conflict = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 99,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(conflict).toMatchObject({ ok: false, error: "job-conflict", currentRowVersion: 1 });
      const keyless = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: world.pmProfileId,
        },
        env: UNKEYED,
        now: S2B_T0,
      });
      expect(keyless).toMatchObject({ ok: false, error: "provider-not-ready" });
      // Rejected jobs refuse (the rejection update is the test's own
      // fixture move, so prove Q4 stillness before it and re-snapshot).
      expect(s2bQ4(t.handle)).toEqual(q4Before);
      t.handle.db.update(jobs).set({ status: "REJECTED" }).where(eq(jobs.id, basics.jobId)).run();
      const q4Mid = s2bQ4(t.handle);
      const rejected = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(rejected).toMatchObject({ ok: false, error: "job-rejected" });
      // Zero writes: no preparation row, version untouched, Q1/Q4 still.
      expect(readPreparationByJob(t.handle, basics.jobId)).toBeNull();
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get();
      expect(job?.rowVersion).toBe(1);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
      expect(s2bQ4(t.handle)).toEqual(q4Mid);
    });
  });

  it("legacy explicit preparation shows the chosen profile and binds it once", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const bodiless = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: null,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(bodiless).toMatchObject({ ok: false, error: "profile-not-ready" });
      const scheduled = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 1,
          profileId: world.spmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(scheduled.ok).toBe(true);
      const row = readPreparationByJob(t.handle, basics.jobId);
      const binding = IntakeBindingV1.parse(JSON.parse(row?.bindingJson as string));
      expect(binding.profileId).toBe(world.spmProfileId);
      expect(binding.intakeItemId).toBeNull();
      expect(binding.batchId).toBeNull();
      expect(row?.intakeItemId).toBeNull();
    });
  });

  it("retry replays live and superseded attempts, requeues the latest terminal failure", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const q1Before = s2bQ1(t.handle);
      const q4Before = s2bQ4(t.handle);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const retryBody = (observedAttemptId: string, observedRowVersion: number) => ({
        schemaVersion: "step2-prepare-retry/v1" as const,
        observedAttemptId,
        observedRowVersion,
      });
      // Unknown attempt: 404 even before any run exists.
      const unknown = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(newId(), 2),
        now: S2B_T0,
      });
      expect(unknown).toMatchObject({ ok: false, error: "attempt-not-found" });

      // Live run replays with zero writes.
      const claimed1 = claimS2b(t.handle);
      const live = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(claimed1.attemptId, 2),
        now: S2B_T0,
      });
      expect(live).toEqual({
        ok: true,
        value: {
          preparationId: readPreparationByJob(t.handle, basics.jobId)?.id,
          state: "QUEUED",
          replayed: true,
        },
      });
      const liveItem = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, claimed1.workItemId))
        .get();
      expect(liveItem?.state).toBe("RUNNING");
      expect(liveItem?.attemptCount).toBe(1);
      expect(t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion).toBe(2);

      // Drive the live attempt to a terminal AUTH failure through the
      // real handler: the row records the versioned failure, the item
      // finishes FAILED immediately (explicit-only, no auto-retry).
      const authProvider = new TestPrepareProvider({
        proposals: {},
        failures: { [basics.jdSnapshotId]: { reason: "AUTHENTICATION" } },
      });
      const outcome1: HandlerOutcome = await s2bHandler({ provider: authProvider })(
        s2bContext(t.handle, claimed1),
      );
      expect(outcome1.result).toBe("FAILED");
      expect(outcome1.errorCode).toBe("AUTHENTICATION");
      expect(outcome1.terminal).toBe(true);
      finishS2bAttempt(t.handle, { ...claimed1, outcome: outcome1 });
      const failedItem = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, claimed1.workItemId))
        .get();
      expect(failedItem?.state).toBe("FAILED");
      expect(readPreparationByJob(t.handle, basics.jobId)?.state).toBe("FAILED");

      // Latest terminal retryable failure requeues: new budget, same
      // binding, version bumped, numbering kept.
      const requeued = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(claimed1.attemptId, 2),
        now: S2B_T0,
      });
      expect(requeued.ok).toBe(true);
      if (!requeued.ok) {
        throw new Error("S2-B retry failed");
      }
      expect(requeued.value.replayed).toBe(false);
      expect(requeued.value.state).toBe("QUEUED");
      expect(t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion).toBe(3);
      expect(readPreparationByJob(t.handle, basics.jobId)?.profileVersionId).toBe(world.pmVersionId);
      expect(readPreparationByJob(t.handle, basics.jobId)?.state).toBe("QUEUED");

      // Requeued run replays live again; fail it terminally too.
      const claimed2 = claimS2b(t.handle);
      expect(claimed2.workItemId).toBe(claimed1.workItemId);
      const liveAgain = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(claimed1.attemptId, 3),
        now: S2B_T0,
      });
      expect(liveAgain).toMatchObject({ ok: true, value: { replayed: true } });
      const outcome2: HandlerOutcome = await s2bHandler({ provider: authProvider })(
        s2bContext(t.handle, claimed2),
      );
      finishS2bAttempt(t.handle, { ...claimed2, outcome: outcome2 });
      expect(readLatestWorkAttempt(t.handle, claimed1.workItemId)?.id).toBe(claimed2.attemptId);

      // Superseded attempt replays with zero writes.
      const superseded = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(claimed1.attemptId, 3),
        now: S2B_T0,
      });
      expect(superseded).toMatchObject({ ok: true, value: { replayed: true } });
      expect(t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion).toBe(3);

      // Stale version conflicts; the fresh retry requeues again.
      const conflict = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(claimed2.attemptId, 2),
        now: S2B_T0,
      });
      expect(conflict).toMatchObject({ ok: false, error: "job-conflict", currentRowVersion: 3 });
      const requeuedAgain = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: retryBody(claimed2.attemptId, 3),
        now: S2B_T0,
      });
      expect(requeuedAgain).toMatchObject({ ok: true, value: { replayed: false } });
      expect(t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion).toBe(4);
      // Still exactly one PREPARE item (numbering kept, never duplicated).
      const prepares = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.kind, "PREPARE"))
        .all();
      expect(prepares).toHaveLength(1);
      expect(s2bQ1(t.handle)).toEqual(q1Before);
      expect(s2bQ4(t.handle)).toEqual(q4Before);
    });
  });

  it("drifted extraction refuses retry and needs the explicit schedule to relink", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      // A re-scrape lands before the run starts: the queued payload is stale.
      const rescrapeAttemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: rescrapeAttemptId,
          jobId: basics.jobId,
          canonicalUrl: `https://example.com/jobs/${basics.jobId}/rescrape`,
          startedAt: S2B_T0,
          finishedAt: S2B_T0,
          outcome: "SUCCEEDED",
        })
        .run();
      const driftedExtractionId = newId();
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
          extractedJson: v13ExtractionJson(`${S2B_JD}\n\nSecond paragraph.`),
        })
        .run();
      t.handle.db
        .update(jobs)
        .set({ activeExtractionId: driftedExtractionId })
        .where(eq(jobs.id, basics.jobId))
        .run();

      // The run verifies before any provider call: INPUT_STALE, zero calls.
      const claimed = claimS2b(t.handle);
      const provider = new TestPrepareProvider({ proposals: {} });
      const outcome: HandlerOutcome = await s2bHandler({ provider })(s2bContext(t.handle, claimed));
      expect(outcome.result).toBe("BLOCKED");
      expect(outcome.errorCode).toBe("INPUT_STALE");
      expect(provider.receivedInputs).toHaveLength(0);
      finishS2bAttempt(t.handle, { ...claimed, outcome });

      // PR cannot replay a stale run: BLOCKED is not retryable-failed.
      const refused = retryPreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare-retry/v1",
          observedAttemptId: claimed.attemptId,
          observedRowVersion: 2,
        },
        now: S2B_T0,
      });
      expect(refused).toMatchObject({ ok: false, error: "retry-not-allowed" });
      expect(t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion).toBe(2);

      // The explicit schedule relinks the same row to the new extraction.
      const before = readPreparationByJob(t.handle, basics.jobId);
      const relinked = schedulePreparation(t.handle, {
        jobId: basics.jobId,
        body: {
          schemaVersion: "step2-prepare/v1",
          operationId: newId(),
          observedRowVersion: 2,
          profileId: world.pmProfileId,
        },
        env: KEYED,
        now: S2B_T0,
      });
      expect(relinked.ok).toBe(true);
      const after = readPreparationByJob(t.handle, basics.jobId);
      expect(after?.id).toBe(before?.id);
      expect(after?.extractionId).toBe(driftedExtractionId);
      expect(after?.profileVersionId).toBe(world.pmVersionId);
      expect(after?.acceptedPlanId).toBeNull();
    });
  });

  it("same-extraction P after terminal failure reuses the work item", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const scheduled = scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const authProvider = new TestPrepareProvider({
        proposals: {},
        failures: { [basics.jdSnapshotId]: { reason: "AUTHENTICATION" } },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, authProvider);
      finishS2bAttempt(t.handle, { ...claimed, outcome });
      expect(readPreparationByJob(t.handle, basics.jobId)?.state).toBe("FAILED");

      // A fresh explicit schedule (not the retry) requeues the same
      // item instead of colliding on the unique key: numbering
      // continues on the same work item.
      const rescheduled = schedulePreparation(t.handle, {
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
      expect(rescheduled).toMatchObject({ ok: true, value: { state: "QUEUED", replayed: false } });
      const row = readPreparationByJob(t.handle, basics.jobId);
      expect(row?.workItemId).toBe(scheduled.workItemId);
      expect(
        t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion,
      ).toBe(3);
      const prepares = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.kind, "PREPARE"))
        .all();
      expect(prepares).toHaveLength(1);
      const next = claimS2b(t.handle);
      expect(next.workItemId).toBe(scheduled.workItemId);
      expect(readLatestWorkAttempt(t.handle, scheduled.workItemId)?.attemptNumber).toBe(2);
    });
  });

  it("same-extraction P on completed work converges with zero writes", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const kit = s2bProposalKit(t.handle, basics, world);
      scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const claimed = claimS2b(t.handle);
      const outcome = await runS2bAttempt(t.handle, claimed, provider);
      expect(outcome.result).toBe("SUCCEEDED");
      finishS2bAttempt(t.handle, { ...claimed, outcome });

      // A duplicate schedule with a new operation id converges on
      // the completed work: no new item, no version bump, no writes.
      const before = readPreparationByJob(t.handle, basics.jobId);
      const converged = schedulePreparation(t.handle, {
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
      expect(converged).toEqual({
        ok: true,
        value: {
          preparationId: readPreparationByJob(t.handle, basics.jobId)?.id,
          state: "SUCCEEDED",
          replayed: true,
          profileId: world.pmProfileId,
          profileVersionId: world.pmVersionId,
        },
      });
      expect(
        t.handle.db.select().from(jobs).where(eq(jobs.id, basics.jobId)).get()?.rowVersion,
      ).toBe(2);
      expect(
        t.handle.db.select().from(workItems).where(eq(workItems.kind, "PREPARE")).all(),
      ).toHaveLength(1);
      const after = readPreparationByJob(t.handle, basics.jobId);
      expect(after?.lastOperationId).toBe(before?.lastOperationId);
      expect(after?.lastOperationHash).toBe(before?.lastOperationHash);
      expect(after?.updatedAt).toBe(before?.updatedAt);
    });
  });
});
