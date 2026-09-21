// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as keywordSupport } from "../../../app/api/jobs/[id]/keyword-support/route";
import {
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  scrapeAttempts,
  type DatabaseHandle,
} from "../../../src/db";
import { createProfile } from "../../../src/db/candidates";
import {
  activateProfileVersion,
  importCandidate,
} from "../../../src/server/candidates";
import {
  getRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * Pre-generation keyword support route (WO-1.2-E, E4/E5): ranked JD
 * suggestions with excerpts plus per-profile support evaluated locally
 * against APPROVED facts — against an isolated root.
 */

const T0 = "2026-09-11T12:00:00.000Z";
const PM_JD = readFileSync(
  join(process.cwd(), "tests", "fixtures", "v1.2", "jd", "pm-rich.txt"),
  "utf8",
);

describe("GET /api/jobs/[id]/keyword-support", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-keyword-support-test-");
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

  function seedProfile(
    handle: DatabaseHandle,
    name: string,
    displayName: string,
    fixture: string,
    isDefault: boolean,
  ): string {
    const profile = createProfile(handle, { name, displayName, isDefault });
    const document = JSON.parse(
      readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", fixture), "utf8"),
    ) as unknown;
    const imported = importCandidate(handle, { document, actor: "human", profileId: profile.id });
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
    return profile.id;
  }

  function seedJob(
    handle: DatabaseHandle,
    descriptionText: string | null,
    withExtraction: boolean,
  ): string {
    const jobId = newId();
    handle.db
      .insert(jobs)
      .values({ id: jobId, status: "NEW", rank: 0, rowVersion: 1, descriptionText })
      .run();
    if (withExtraction) {
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
    }
    return jobId;
  }

  function supportFor(body: Record<string, unknown>, keyword: string): Record<string, unknown> {
    const suggestions = body["suggestions"] as Array<Record<string, unknown>>;
    const entry = suggestions.find((item) => item["keyword"] === keyword);
    if (entry === undefined) {
      throw new Error(`missing suggestion '${keyword}' in ${JSON.stringify(suggestions.map((s) => s["keyword"]))}`);
    }
    return entry["support"] as Record<string, unknown>;
  }

  it("returns 404 for unknown jobs", async () => {
    const jobId = newId();
    const response = await keywordSupport(
      getRequest(`/api/jobs/${jobId}/keyword-support`),
      routeParams(jobId),
    );
    expect(response.status).toBe(404);
  });

  it("reports no extracted description honestly with zero suggestions", async () => {
    const jobId = withDb((handle) => seedJob(handle, null, false));
    const response = await keywordSupport(
      getRequest(`/api/jobs/${jobId}/keyword-support`),
      routeParams(jobId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ evaluated: false, suggestions: [] });
    expect(String(body["reason"])).toContain("no extracted description");
  });

  it("evaluates support per profile with excerpts and fact evidence", async () => {
    const seeded = withDb((handle) => ({
      jobId: seedJob(handle, PM_JD, true),
      pmId: seedProfile(handle, "pm", "Product Manager", "pm-profile.json", true),
      spmId: seedProfile(handle, "spm", "Senior Product Manager", "spm-profile.json", false),
    }));
    const pmResponse = await keywordSupport(
      getRequest(`/api/jobs/${seeded.jobId}/keyword-support`),
      routeParams(seeded.jobId),
    );
    expect(pmResponse.status).toBe(200);
    const pmBody = await readJson(pmResponse);
    expect(pmBody).toMatchObject({
      evaluated: true,
      reason: null,
      profileId: seeded.pmId,
      policyVersion: "keyword-support/v1",
    });
    const suggestions = pmBody["suggestions"] as Array<Record<string, unknown>>;
    expect(suggestions.length).toBeGreaterThanOrEqual(5);
    for (const entry of suggestions) {
      expect(typeof entry["excerpt"]).toBe("string");
      expect((entry["excerpt"] as string).length).toBeGreaterThan(0);
      expect(typeof entry["offset"]).toBe("number");
      expect(["supported", "uncertain", "gap"]).toContain(
        (entry["support"] as Record<string, unknown>)["status"],
      );
    }
    // PM backs go-to-market; the excerpt is source-grounded.
    expect(supportFor(pmBody, "go-to-market")).toMatchObject({
      status: "supported",
      factIds: ["pm-fact-gtm"],
    });
    expect(supportFor(pmBody, "customer discovery")).toMatchObject({ status: "supported" });

    // Switching profiles re-evaluates: SPM lacks go-to-market evidence.
    const spmResponse = await keywordSupport(
      getRequest(`/api/jobs/${seeded.jobId}/keyword-support?profileId=${seeded.spmId}`),
      routeParams(seeded.jobId),
    );
    expect(spmResponse.status).toBe(200);
    const spmBody = await readJson(spmResponse);
    expect(spmBody).toMatchObject({ evaluated: true, profileId: seeded.spmId });
    expect(supportFor(spmBody, "go-to-market")).toMatchObject({ status: "gap", factIds: [] });
    expect(supportFor(spmBody, "roadmap prioritization")).toMatchObject({ status: "uncertain" });
  });

  it("reports unknown support without an active master version", async () => {
    const seeded = withDb((handle) => {
      const jobId = seedJob(handle, PM_JD, true);
      const profile = createProfile(handle, { name: "bare", displayName: "Bare", isDefault: true });
      return { jobId, profileId: profile.id };
    });
    const response = await keywordSupport(
      getRequest(`/api/jobs/${seeded.jobId}/keyword-support`),
      routeParams(seeded.jobId),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ evaluated: false, profileId: seeded.profileId });
    expect(String(body["reason"])).toContain("no active master version");
    const suggestions = body["suggestions"] as Array<Record<string, unknown>>;
    expect(suggestions.length).toBeGreaterThanOrEqual(5);
    for (const entry of suggestions) {
      expect(entry["support"]).toBeNull();
    }
  });

  it("rejects unknown profile ids", async () => {
    const jobId = withDb((handle) => seedJob(handle, PM_JD, true));
    const response = await keywordSupport(
      getRequest(`/api/jobs/${jobId}/keyword-support?profileId=nope`),
      routeParams(jobId),
    );
    expect(response.status).toBe(400);
  });
});
