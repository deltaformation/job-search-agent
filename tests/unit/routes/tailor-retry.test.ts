// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as retry } from "../../../app/api/jobs/[id]/tailor/retry/route";
import {
  generationRequests,
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  scrapeAttempts,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { createProfile } from "../../../src/db/candidates";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import {
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * Explicit generation route tests: the Start command pref lights,
 * records the request, and queues v2 work; preflight failures are
 * 422 with an action, conflicts are 409 — against an isolated root.
 */

const T0 = "2026-09-11T12:00:00.000Z";

describe("POST /api/jobs/[id]/tailor/retry", () => {
  let isolated: IsolatedRoot;
  let previousProvider: string | undefined;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-tailor-retry-test-");
    previousProvider = process.env["TAILOR_PROVIDER_ARGV"];
    process.env["TAILOR_PROVIDER_ARGV"] = JSON.stringify(["tailor-provider"]);
  });

  afterEach(() => {
    if (previousProvider === undefined) {
      delete process.env["TAILOR_PROVIDER_ARGV"];
    } else {
      process.env["TAILOR_PROVIDER_ARGV"] = previousProvider;
    }
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

  function seedProfile(handle: DatabaseHandle): { profileId: string; profileVersionId: string } {
    const profile = createProfile(handle, { name: "pm", displayName: "Product Manager" });
    const document = JSON.parse(
      readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
    ) as unknown;
    const imported = importCandidate(handle, { document, actor: "human", profileId: profile.id });
    if (!imported.ok) {
      throw new Error(`seed failed: ${JSON.stringify(imported)}`);
    }
    const activated = activateProfileVersion(handle, { versionId: imported.versionId, actor: "human" });
    if (!activated.ok) {
      throw new Error(`seed failed: ${JSON.stringify(activated)}`);
    }
    return { profileId: profile.id, profileVersionId: imported.versionId };
  }

  function seedJobWithExtraction(
    descriptionText: string | null = "Build TypeScript APIs with Kubernetes and Go.",
    withProfile = true,
  ): { jobId: string; extractionId: string; profileId: string } {
    return withDb((handle) => {
      const jobId = newId();
      handle.db
        .insert(jobs)
        .values({
          id: jobId,
          status: "NEW",
          rank: 0,
          rowVersion: 1,
          descriptionText,
          tailoringState: "READY",
        })
        .run();
      const attemptId = newId();
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId,
          canonicalUrl: "https://example.com/jobs/1",
          adapter: "generic",
          startedAt: T0,
          finishedAt: T0,
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
      const profileId = withProfile ? seedProfile(handle).profileId : "";
      return { jobId, extractionId, profileId };
    });
  }

  function requestFor(handle: DatabaseHandle, requestId: string) {
    return handle.db
      .select()
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId))
      .get();
  }

  it("returns 404 for unknown jobs", async () => {
    const jobId = newId();
    const response = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, { observedRowVersion: 1 }),
      routeParams(jobId),
    );
    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: "job not found" });
  });

  it("maps preflight failures to 422 with an action", async () => {
    // No profile exists yet anywhere in this database.
    const noProfile = seedJobWithExtraction(undefined, false);
    const profileMissing = await retry(
      postRequest(`/api/jobs/${noProfile.jobId}/tailor/retry`, { observedRowVersion: 1 }),
      routeParams(noProfile.jobId),
    );
    expect(profileMissing.status).toBe(422);
    expect(await readJson(profileMissing)).toMatchObject({ error: "profile-not-ready" });

    const blank = seedJobWithExtraction("   ");
    const emptyJd = await retry(
      postRequest(`/api/jobs/${blank.jobId}/tailor/retry`, { observedRowVersion: 1 }),
      routeParams(blank.jobId),
    );
    expect(emptyJd.status).toBe(422);
    expect(await readJson(emptyJd)).toMatchObject({ error: "empty-jd", action: expect.any(String) });
  });

  it("starts an INITIAL run, replays identical resubmits, and 409s changed or concurrent ones", async () => {
    const { jobId } = seedJobWithExtraction();
    const requestId = newId();
    const first = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, {
        observedRowVersion: 1,
        requestId,
        selectedKeywords: ["Kubernetes", "Go"],
        directives: "Emphasize scale.",
      }),
      routeParams(jobId),
    );
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody).toMatchObject({
      requestId,
      requestKind: "INITIAL",
      deduped: false,
      requeued: false,
      newRowVersion: 2,
    });
    expect(typeof firstBody["workItemId"]).toBe("string");
    withDb((handle) => {
      const row = requestFor(handle, requestId);
      expect(row).toMatchObject({
        status: "QUEUED",
        directivesText: "Emphasize scale.",
        workItemId: firstBody["workItemId"],
      });
      expect(JSON.parse(String(row?.selectedKeywordsJson))).toEqual(["Go", "Kubernetes"]);
      const item = handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, String(firstBody["workItemId"])))
        .get();
      expect(JSON.parse(String(item?.payloadJson))).toMatchObject({
        schemaVersion: "tailor-queue/v2",
        generationRequestId: requestId,
      });
    });
    // Same identity, same bytes: deduped replay of the live run.
    const second = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, {
        observedRowVersion: 2,
        requestId,
        selectedKeywords: ["Go", "Kubernetes"],
        directives: "Emphasize scale.",
      }),
      routeParams(jobId),
    );
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({
      requestId,
      workItemId: firstBody["workItemId"],
      deduped: true,
    });
    // Same identity, changed bytes: 409, never the original run.
    const changed = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, {
        observedRowVersion: 2,
        requestId,
        directives: "Changed guidance.",
      }),
      routeParams(jobId),
    );
    expect(changed.status).toBe(409);
    expect(await readJson(changed)).toMatchObject({ error: "idempotency-mismatch" });
    // Fresh identity while live: 409, never a fork.
    const third = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, { observedRowVersion: 2 }),
      routeParams(jobId),
    );
    expect(third.status).toBe(409);
    expect(await readJson(third)).toMatchObject({ error: "generation-busy" });
  });

  it("conflicts on a stale observed row version", async () => {
    const { jobId } = seedJobWithExtraction();
    const response = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, { observedRowVersion: 99 }),
      routeParams(jobId),
    );
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ error: "conflict" });
  });

  it("returns 400 for unknown profiles and invalid guidance", async () => {
    const { jobId } = seedJobWithExtraction();
    const unknown = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, {
        observedRowVersion: 1,
        profileId: "no-such-profile",
      }),
      routeParams(jobId),
    );
    expect(unknown.status).toBe(400);
    expect(await readJson(unknown)).toMatchObject({ error: "profile-not-found" });
    const invalid = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, {
        observedRowVersion: 1,
        selectedKeywords: Array.from({ length: 21 }, (_, index) => `k${index}`),
      }),
      routeParams(jobId),
    );
    expect(invalid.status).toBe(400);
  });

  it("rejects forged keyword selections with 422 (E3)", async () => {
    const { jobId } = seedJobWithExtraction(
      "Own product strategy and roadmap prioritization.",
    );
    const response = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, {
        observedRowVersion: 1,
        selectedKeywords: ["roadmap prioritization", "Kubernetes"],
      }),
      routeParams(jobId),
    );
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ error: "forged-selection" });
  });

  it("marks the job BLOCKED when no provider is configured", async () => {
    const { jobId } = seedJobWithExtraction();
    delete process.env["TAILOR_PROVIDER_ARGV"];
    const response = await retry(
      postRequest(`/api/jobs/${jobId}/tailor/retry`, { observedRowVersion: 1 }),
      routeParams(jobId),
    );
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ error: "provider-unavailable" });
    withDb((handle) => {
      const job = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      expect(job?.tailoringState).toBe("BLOCKED");
    });
  });
});
