// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { jobExtractions, jobs, scrapeAttempts } from "../../../src/db/schema";
import { workItems } from "../../../src/db/schema/queue";
import { retryTailoring } from "../../../src/server/tailoring";
import { requestTailoring } from "../../../src/tailoring/enqueue";

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-retry-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function seedJob(
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
      title: "Engineer",
      company: "Acme",
      descriptionText: overrides.descriptionText ?? "Build TypeScript APIs with Postgres.",
      createdAt: "2026-09-11T12:00:00.000Z",
      updatedAt: "2026-09-11T12:00:00.000Z",
    })
    .run();
  if (overrides.withExtraction === false) {
    return { jobId, extractionId: "" };
  }
  const attemptId = newId();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/9",
      adapter: "generic",
      startedAt: "2026-09-11T12:00:00.000Z",
      finishedAt: "2026-09-11T12:00:05.000Z",
      outcome: "SUCCEEDED",
      workerId: "worker-a",
    })
    .run();
  const extractionId = newId();
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
        fields: { title: "Engineer" },
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
  return { jobId, extractionId };
}

function setItemState(handle: DatabaseHandle, itemId: string, state: string): void {
  handle.db
    .update(workItems)
    .set({
      state,
      leaseToken: state === "RUNNING" ? "lease-test" : null,
      updatedAt: "2026-09-11T12:05:00.000Z",
    })
    .where(eq(workItems.id, itemId))
    .run();
}

describe("retryTailoring", () => {
  it("returns 404 for an unknown job", () => {
    withDatabase((t) => {
      expect(retryTailoring(t.handle, newId())).toEqual({
        ok: false,
        status: 404,
        error: "job not found",
        message: expect.stringContaining("unknown job"),
      });
    });
  });

  it("refuses jobs without extracted description text", () => {
    withDatabase((t) => {
      const blank = seedJob(t.handle, { descriptionText: "   " });
      expect(retryTailoring(t.handle, blank.jobId)).toMatchObject({
        ok: false,
        status: 400,
        error: "extraction incomplete",
      });
      const missing = seedJob(t.handle, { withExtraction: false });
      expect(retryTailoring(t.handle, missing.jobId)).toMatchObject({
        ok: false,
        status: 400,
      });
    });
  });

  it("enqueues a first run when tailoring never started", () => {
    withDatabase((t) => {
      const { jobId } = seedJob(t.handle);
      const result = retryTailoring(t.handle, jobId);
      expect(result).toMatchObject({ ok: true, action: "enqueued" });
      // Idempotent: a second call no-ops instead of duplicating work.
      const again = retryTailoring(t.handle, jobId);
      expect(again).toMatchObject({ ok: true, action: "already_queued" });
      expect((again as { workItemId: string }).workItemId).toBe(
        (result as { workItemId: string }).workItemId,
      );
    });
  });

  it("requeues a FAILED item and leaves the job state to the worker", () => {
    withDatabase((t) => {
      const { jobId, extractionId } = seedJob(t.handle);
      const enqueued = requestTailoring(t.handle, { jobId, extractionId });
      setItemState(t.handle, enqueued.workItemId, "FAILED");
      // Simulate the worker's terminal job marker: the retry must not clear it.
      t.handle.db
        .update(jobs)
        .set({ tailoringState: "FAILED", tailoringReasonCode: "PROVIDER_UNAVAILABLE" })
        .where(eq(jobs.id, jobId))
        .run();
      const result = retryTailoring(t.handle, jobId);
      expect(result).toEqual({ ok: true, workItemId: enqueued.workItemId, action: "requeued" });
      const item = t.handle.db
        .select({ state: workItems.state, attemptCount: workItems.attemptCount })
        .from(workItems)
        .where(eq(workItems.id, enqueued.workItemId))
        .get();
      expect(item).toEqual({ state: "QUEUED", attemptCount: 0 });
      const job = t.handle.db
        .select({ tailoringState: jobs.tailoringState })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .get();
      // Only the leased worker claim may move the job out of FAILED.
      expect(job?.tailoringState).toBe("FAILED");
    });
  });

  it("no-ops for running and succeeded items", () => {
    withDatabase((t) => {
      const { jobId, extractionId } = seedJob(t.handle);
      const enqueued = requestTailoring(t.handle, { jobId, extractionId });
      setItemState(t.handle, enqueued.workItemId, "RUNNING");
      expect(retryTailoring(t.handle, jobId)).toEqual({
        ok: true,
        workItemId: enqueued.workItemId,
        action: "already_running",
      });
      setItemState(t.handle, enqueued.workItemId, "SUCCEEDED");
      expect(retryTailoring(t.handle, jobId)).toEqual({
        ok: true,
        workItemId: enqueued.workItemId,
        action: "already_succeeded",
      });
    });
  });

  it("refuses cancelled items with a conflict", () => {
    withDatabase((t) => {
      const { jobId, extractionId } = seedJob(t.handle);
      const enqueued = requestTailoring(t.handle, { jobId, extractionId });
      setItemState(t.handle, enqueued.workItemId, "CANCELLED");
      expect(retryTailoring(t.handle, jobId)).toMatchObject({ ok: false, status: 409 });
    });
  });
});
