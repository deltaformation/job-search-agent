// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  generationRequests,
  newId,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { jobExtractions, jobs, scrapeAttempts } from "../../../src/db/schema";
import { createProfile } from "../../../src/db/candidates";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import { requestGeneration } from "../../../src/server/tailoring";
import { seedResumeChain } from "../db/helpers";

const T0 = "2026-09-11T12:00:00.000Z";
const PROVIDER = { providerAvailable: () => true };
const NO_PROVIDER = { providerAvailable: () => false };

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-generation-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function pmDocument(): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
  ) as unknown;
}

/** Import + activate the PM master once per database. */
function seedProfile(handle: DatabaseHandle): { profileId: string; profileVersionId: string } {
  const profile = createProfile(handle, { name: "pm", displayName: "Product Manager" });
  const imported = importCandidate(handle, {
    document: pmDocument(),
    actor: "human",
    profileId: profile.id,
  });
  if (!imported.ok) {
    throw new Error(`seed failed: ${JSON.stringify(imported)}`);
  }
  const activated = activateProfileVersion(handle, {
    versionId: imported.versionId,
    actor: "human",
  });
  if (!activated.ok) {
    throw new Error(`seed failed: ${JSON.stringify(activated)}`);
  }
  return { profileId: profile.id, profileVersionId: imported.versionId };
}

/**
 * Seed a READY job (extracted JD) that satisfies preflight once a
 * profile exists. Returns the ids a generation command needs.
 */
function seedReadyJob(
  handle: DatabaseHandle,
  overrides: { descriptionText?: string | null; withExtraction?: boolean } = {},
): { jobId: string; extractionId: string } {
  const jobId = newId();
  handle.db
    .insert(jobs)
    .values({
      id: jobId,
      status: "NEW",
      rank: 0,
      rowVersion: 1,
      title: "Product Manager",
      company: "Harbor Analytics",
      descriptionText: overrides.descriptionText ?? "Own product strategy and roadmap prioritization.",
      tailoringState: "READY",
      createdAt: T0,
      updatedAt: T0,
    })
    .run();
  let extractionId = "";
  if (overrides.withExtraction !== false) {
    const attemptId = newId();
    handle.db
      .insert(scrapeAttempts)
      .values({
        id: attemptId,
        jobId,
        canonicalUrl: "https://example.com/jobs/9",
        adapter: "generic",
        startedAt: T0,
        finishedAt: T0,
        outcome: "SUCCEEDED",
        workerId: "worker-a",
      })
      .run();
    extractionId = newId();
    handle.db
      .insert(jobExtractions)
      .values({
        id: extractionId,
        jobId,
        scrapeAttemptId: attemptId,
        version: 1,
        schemaVersion: "job-extraction-v1",
        adapter: "generic",
        extractedJson: JSON.stringify({
          schemaVersion: "job-extraction-v1",
          fields: { title: "Product Manager" },
          provenance: { title: "generic:h1" },
          contentHash: "b".repeat(64),
        }),
        confidence: 0.8,
        missingFieldsJson: JSON.stringify([]),
      })
      .run();
    handle.db
      .update(jobs)
      .set({ activeExtractionId: extractionId })
      .where(eq(jobs.id, jobId))
      .run();
  }
  return { jobId, extractionId };
}

function jobState(handle: DatabaseHandle, jobId: string) {
  return handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

function requestRow(handle: DatabaseHandle, requestId: string) {
  return handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.id, requestId))
    .get();
}

function itemRow(handle: DatabaseHandle, itemId: string) {
  return handle.db.select().from(workItems).where(eq(workItems.id, itemId)).get();
}

describe("requestGeneration", () => {
  it("returns unknown-job for a missing job", () => {
    withDatabase((t) => {
      const result = requestGeneration(
        t.handle,
        { jobId: newId(), observedRowVersion: 1, actor: "human" },
        PROVIDER,
      );
      expect(result).toMatchObject({ ok: false, error: "unknown-job" });
    });
  });

  it("conflicts on a stale observed row version and writes nothing", () => {
    withDatabase((t) => {
      seedProfile(t.handle);
      const { jobId } = seedReadyJob(t.handle);
      const result = requestGeneration(
        t.handle,
        { jobId, observedRowVersion: 99, actor: "human" },
        PROVIDER,
      );
      expect(result).toMatchObject({ ok: false, error: "conflict" });
      expect(
        t.handle.db.select().from(generationRequests).where(eq(generationRequests.jobId, jobId)).all(),
      ).toHaveLength(0);
      expect(
        t.handle.db.select().from(workItems).where(eq(workItems.jobId, jobId)).all(),
      ).toHaveLength(0);
    });
  });

  it("pref lights extraction, JD content, profile, and provider before writing", () => {
    withDatabase((t) => {
      const noProfile = seedReadyJob(t.handle);
      expect(
        requestGeneration(
          t.handle,
          { jobId: noProfile.jobId, observedRowVersion: 1, actor: "human" },
          PROVIDER,
        ),
      ).toMatchObject({ ok: false, error: "profile-not-ready" });

      expect(
        requestGeneration(
          t.handle,
          { jobId: noProfile.jobId, observedRowVersion: 1, actor: "human", profileId: "ghost" },
          PROVIDER,
        ),
      ).toMatchObject({ ok: false, error: "profile-not-found" });

      seedProfile(t.handle);
      const noExtraction = seedReadyJob(t.handle, { withExtraction: false });
      expect(
        requestGeneration(
          t.handle,
          { jobId: noExtraction.jobId, observedRowVersion: 1, actor: "human" },
          PROVIDER,
        ),
      ).toMatchObject({ ok: false, error: "extraction-missing" });

      const blankJd = seedReadyJob(t.handle, { descriptionText: "   " });
      expect(
        requestGeneration(
          t.handle,
          { jobId: blankJd.jobId, observedRowVersion: 1, actor: "human" },
          PROVIDER,
        ),
      ).toMatchObject({ ok: false, error: "empty-jd" });

      // Nothing was written by any preflight failure.
      expect(t.handle.db.select().from(generationRequests).all()).toHaveLength(0);
      expect(
        t.handle.db.select().from(workItems).where(eq(workItems.kind, "TAILOR")).all(),
      ).toHaveLength(0);
    });
  });

  it("marks the job BLOCKED when no provider is configured", () => {
    withDatabase((t) => {
      seedProfile(t.handle);
      const { jobId } = seedReadyJob(t.handle);
      const result = requestGeneration(
        t.handle,
        { jobId, observedRowVersion: 1, actor: "human" },
        NO_PROVIDER,
      );
      expect(result).toMatchObject({ ok: false, error: "provider-unavailable" });
      expect(jobState(t.handle, jobId)).toMatchObject({
        tailoringState: "BLOCKED",
        tailoringReasonCode: "PROVIDER_UNAVAILABLE",
      });
      // Retry from BLOCKED once the provider exists.
      const retry = requestGeneration(
        t.handle,
        { jobId, observedRowVersion: 2, actor: "human" },
        PROVIDER,
      );
      expect(retry).toMatchObject({ ok: true, requestKind: "INITIAL" });
    });
  });

  it("records an INITIAL request with frozen bindings and queues v2 work", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const requestId = newId();
      const result = requestGeneration(
        t.handle,
        {
          jobId: seed.jobId,
          observedRowVersion: 1,
          actor: "human",
          selectedKeywords: ["Product Strategy", "roadmap prioritization"],
          directives: "Lead with platform wins.",
          requestId,
        },
        PROVIDER,
      );
      expect(result).toMatchObject({
        ok: true,
        requestId,
        requestKind: "INITIAL",
        deduped: false,
        requeued: false,
        newRowVersion: 2,
      });
      if (!result.ok) {
        return;
      }
      const row = requestRow(t.handle, requestId);
      expect(row).toMatchObject({
        jobId: seed.jobId,
        extractionId: seed.extractionId,
        profileId: seed.profileId,
        profileVersionId: seed.profileVersionId,
        parentVersionId: null,
        requestKind: "INITIAL",
        directivesText: "Lead with platform wins.",
        revisionNote: null,
        status: "QUEUED",
        workItemId: result.workItemId,
      });
      // Keywords are canonicalized (deduped, sorted); steering froze.
      expect(JSON.parse(String(row?.selectedKeywordsJson))).toEqual([
        "Product Strategy",
        "roadmap prioritization",
      ]);
      expect(String(row?.steeringSnapshotJson)).toContain(seed.profileVersionId);
      expect(row?.payloadHash).toMatch(/^[0-9a-f]{64}$/);

      const item = itemRow(t.handle, result.workItemId);
      expect(item).toMatchObject({ kind: "TAILOR", state: "QUEUED", jobId: seed.jobId });
      const payload = JSON.parse(String(item?.payloadJson)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        schemaVersion: "tailor-queue/v2",
        generationRequestId: requestId,
        extractionId: seed.extractionId,
        profileVersionId: seed.profileVersionId,
        payloadHash: row?.payloadHash,
      });
      expect(jobState(t.handle, seed.jobId)).toMatchObject({
        tailoringState: "PENDING",
        rowVersion: 2,
      });
    });
  });

  it("dedupes a double submit by request identity", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const requestId = newId();
      const first = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: 1, actor: "human", requestId },
        PROVIDER,
      );
      expect(first).toMatchObject({ ok: true, deduped: false });
      if (!first.ok) {
        return;
      }
      const second = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: 2, actor: "human", requestId },
        PROVIDER,
      );
      expect(second).toEqual({ ...first, deduped: true });
      expect(
        t.handle.db.select().from(generationRequests).where(eq(generationRequests.jobId, seed.jobId)).all(),
      ).toHaveLength(1);
      expect(
        t.handle.db.select().from(workItems).where(eq(workItems.jobId, seed.jobId)).all(),
      ).toHaveLength(1);
    });
  });

  it("fails a fresh operation ID while a run is live instead of attaching", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const first = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: 1, actor: "human" },
        PROVIDER,
      );
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      // WO-1.3-E: no silent attach — the caller replays the live
      // run's own operation ID or waits for it.
      const second = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: 2, actor: "human" },
        PROVIDER,
      );
      expect(second).toMatchObject({ ok: false, error: "generation-busy" });
      expect(
        t.handle.db.select().from(generationRequests).where(eq(generationRequests.jobId, seed.jobId)).all(),
      ).toHaveLength(1);
    });
  });

  it("requires the active parent once a version exists", () => {
    withDatabase((t) => {
      // No profile: kind derivation rejects before preflight runs.
      const chain = seedResumeChain(t);
      // The chain job carries a real version; rest it in a decided
      // state so the command reaches kind derivation.
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "APPROVED", activeResumeVersionId: chain.resumeVersionId })
        .where(eq(jobs.id, chain.jobId))
        .run();
      const job = jobState(t.handle, chain.jobId);
      const missing = requestGeneration(
        t.handle,
        { jobId: chain.jobId, observedRowVersion: job?.rowVersion ?? 1, actor: "human" },
        PROVIDER,
      );
      expect(missing).toMatchObject({ ok: false, error: "parent-mismatch" });
      const wrong = requestGeneration(
        t.handle,
        {
          jobId: chain.jobId,
          observedRowVersion: job?.rowVersion ?? 1,
          actor: "human",
          parentVersionId: newId(),
        },
        PROVIDER,
      );
      expect(wrong).toMatchObject({ ok: false, error: "parent-mismatch" });
    });
  });

  it("starts a brand-new run after failure and leaves the failed item alone", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const first = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: 1, actor: "human", requestId: newId() },
        PROVIDER,
      );
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      // Simulate the worker's terminal outcome + exhausted budget.
      t.handle.db
        .update(workItems)
        .set({ state: "FAILED", attemptCount: 3, maxAttempts: 3 })
        .where(eq(workItems.id, first.workItemId))
        .run();
      t.handle.db
        .update(generationRequests)
        .set({ status: "FAILED", errorCode: "TIMEOUT", finishedAt: T0 })
        .where(eq(generationRequests.id, first.requestId))
        .run();
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "FAILED", tailoringReasonCode: "TIMEOUT" })
        .where(eq(jobs.id, seed.jobId))
        .run();
      const job = jobState(t.handle, seed.jobId);
      const retry = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: job?.rowVersion ?? 1, actor: "human" },
        PROVIDER,
      );
      expect(retry).toMatchObject({ ok: true, requeued: false });
      if (!retry.ok) {
        return;
      }
      // New identity, new rows; the failed item keeps its history.
      expect(retry.requestId).not.toBe(first.requestId);
      expect(retry.workItemId).not.toBe(first.workItemId);
      expect(requestRow(t.handle, retry.requestId)).toMatchObject({
        requestKind: "INITIAL",
        status: "QUEUED",
        workItemId: retry.workItemId,
      });
      expect(itemRow(t.handle, first.workItemId)).toMatchObject({
        state: "FAILED",
        attemptCount: 3,
        maxAttempts: 3,
      });
      expect(jobState(t.handle, seed.jobId)).toMatchObject({ tailoringState: "PENDING" });
    });
  });

  it("replays the failed run as-is on same-identity resubmission without requeueing", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const requestId = newId();
      const first = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: 1, actor: "human", requestId },
        PROVIDER,
      );
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      t.handle.db
        .update(workItems)
        .set({ state: "FAILED", attemptCount: 3, maxAttempts: 3 })
        .where(eq(workItems.id, first.workItemId))
        .run();
      t.handle.db
        .update(generationRequests)
        .set({ status: "FAILED", errorCode: "TIMEOUT", finishedAt: T0 })
        .where(eq(generationRequests.id, first.requestId))
        .run();
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "FAILED", tailoringReasonCode: "TIMEOUT" })
        .where(eq(jobs.id, seed.jobId))
        .run();
      const job = jobState(t.handle, seed.jobId);
      const retry = requestGeneration(
        t.handle,
        { jobId: seed.jobId, observedRowVersion: job?.rowVersion ?? 1, actor: "human", requestId },
        PROVIDER,
      );
      // WO-1.3-E: identical resubmits replay as-is with zero writes —
      // even when FAILED. Recovery is explicit retry (see below).
      expect(retry).toMatchObject({ ok: true, deduped: true, requeued: false });
      if (!retry.ok) {
        return;
      }
      expect(retry.requestId).toBe(first.requestId);
      expect(retry.workItemId).toBe(first.workItemId);
      expect(requestRow(t.handle, requestId)).toMatchObject({ status: "FAILED" });
      expect(itemRow(t.handle, first.workItemId)).toMatchObject({
        state: "FAILED",
        attemptCount: 3,
        maxAttempts: 3,
      });
      expect(jobState(t.handle, seed.jobId)).toMatchObject({ tailoringState: "FAILED" });
    });
  });

  it("rejects forged (non-JD) keyword selections before writing anything (E3)", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const requestId = newId();
      const result = requestGeneration(
        t.handle,
        {
          jobId: seed.jobId,
          observedRowVersion: 1,
          actor: "human",
          selectedKeywords: ["roadmap prioritization", "Kubernetes", "C2 clearance"],
          requestId,
        },
        PROVIDER,
      );
      expect(result).toMatchObject({
        ok: false,
        error: "forged-selection",
      });
      if (result.ok) {
        return;
      }
      expect(result.detail).toContain("C2 clearance");
      expect(result.action).toContain("suggestions");
      expect(requestRow(t.handle, requestId)).toBeUndefined();
      expect(jobState(t.handle, seed.jobId)).toMatchObject({
        tailoringState: "READY",
        rowVersion: 1,
      });
    });
  });

  it("accepts honest JD-substring selections case-insensitively (E3)", () => {
    withDatabase((t) => {
      const profile = seedProfile(t.handle);
      const seed = { ...seedReadyJob(t.handle), ...profile };
      const result = requestGeneration(
        t.handle,
        {
          jobId: seed.jobId,
          observedRowVersion: 1,
          actor: "human",
          selectedKeywords: ["PRODUCT STRATEGY", "Roadmap Prioritization"],
        },
        PROVIDER,
      );
      expect(result).toMatchObject({ ok: true, requestKind: "INITIAL" });
    });
  });
});
