// @vitest-environment node
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as retry } from "../../../app/api/jobs/[id]/tailor/retry/route";
import {
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  scrapeAttempts,
  type DatabaseHandle,
} from "../../../src/db";
import { requestTailoring } from "../../../src/tailoring/enqueue";
import {
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * Tailoring retry route tests: enqueue-on-first-retry, FAILED requeue,
 * and the extraction/unknown-job guards, against an isolated data root.
 */

describe("POST /api/jobs/[id]/tailor/retry", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-tailor-retry-test-");
  });

  afterEach(() => {
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function withDb<T>(fn: (handle: DatabaseHandle) => T): T {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      return fn(handle);
    } finally {
      handle.close();
    }
  }

  function seedJobWithExtraction(descriptionText: string | null = "Build TypeScript APIs."): {
    jobId: string;
    extractionId: string;
  } {
    return withDb((handle) => {
      const jobId = newId();
      handle.db
        .insert(jobs)
        .values({ id: jobId, status: "NEW", rank: 0, rowVersion: 1, descriptionText })
        .run();
      const attemptId = newId();
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId,
          canonicalUrl: "https://example.com/jobs/1",
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
            fields: {},
            provenance: {},
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
    });
  }

  it("returns 404 for unknown jobs", async () => {
    const jobId = newId();
    const response = await retry(postRequest(`/api/jobs/${jobId}/tailor/retry`, {}), routeParams(jobId));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: "job not found" });
  });

  it("refuses jobs without extracted text", async () => {
    const { jobId } = seedJobWithExtraction(null);
    const response = await retry(postRequest(`/api/jobs/${jobId}/tailor/retry`, {}), routeParams(jobId));
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: "extraction incomplete" });
  });

  it("enqueues a first run, then no-ops while queued", async () => {
    const { jobId } = seedJobWithExtraction();
    const first = await retry(postRequest(`/api/jobs/${jobId}/tailor/retry`, {}), routeParams(jobId));
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody["action"]).toBe("enqueued");
    expect(typeof firstBody["workItemId"]).toBe("string");
    const second = await retry(postRequest(`/api/jobs/${jobId}/tailor/retry`, {}), routeParams(jobId));
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({
      workItemId: firstBody["workItemId"],
      action: "already_queued",
    });
  });

  it("requeues a FAILED item", async () => {
    const { jobId, extractionId } = seedJobWithExtraction();
    const itemId = withDb((handle) => {
      const enqueued = requestTailoring(handle, { jobId, extractionId });
      handle.sqlite.prepare("UPDATE work_items SET state = 'FAILED' WHERE id = ?").run(enqueued.workItemId);
      return enqueued.workItemId;
    });
    const response = await retry(postRequest(`/api/jobs/${jobId}/tailor/retry`, {}), routeParams(jobId));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ workItemId: itemId, action: "requeued" });
    withDb((handle) => {
      const state = handle.sqlite
        .prepare("SELECT state FROM work_items WHERE id = ?")
        .get(itemId) as { state: string };
      expect(state.state).toBe("QUEUED");
    });
  });
});
