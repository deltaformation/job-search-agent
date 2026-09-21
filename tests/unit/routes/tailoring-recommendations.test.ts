// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { GET as recommendationsGET } from "../../../app/api/jobs/[id]/tailoring/recommendations/route";
import { GET as masterVersionGET } from "../../../app/api/settings/profiles/[id]/versions/[versionId]/route";
import { eq } from "drizzle-orm";
import {
  jobExtractions,
  jobs,
  newId,
  openDatabase,
  scrapeAttempts,
  type DatabaseHandle,
} from "../../../src/db";
import {
  RecommendationsReply,
  TailoringErrorBody,
} from "../../../src/domain/tailoringWorkspace";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import { seedV13Basics, v13ExtractionJson, V13_T0, type V13Basics } from "../db/v13world";
import {
  getRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * D1–D5 route leg: the recommendations GET envelope, query
 * validation, ownership/freshness/readiness statuses, hash honesty,
 * and the exact-ID master preview D1 pins. Read-only throughout:
 * no queue item, workspace, or review is created (ΔQ1=0, ΔQ9=0).
 */

const JD = "TypeScript APIs with Redis caching and go-to-market launches. Jira boards.";

describe("recommendations and master preview routes", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-d-routes-");
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

  function seedBasics(): { basics: V13Basics; world: CrossProfileWorld } {
    return withDb((handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      const basics = seedV13Basics(handle, world, {
        jdText: JD,
        extractedJson: v13ExtractionJson(JD),
      });
      return { basics, world };
    });
  }

  function recPath(basics: V13Basics): string {
    return (
      `/api/jobs/${basics.jobId}/tailoring/recommendations` +
      `?extractionId=${basics.extractionId}&profileVersionId=${basics.profileVersionId}`
    );
  }

  function q1q9(handle: DatabaseHandle, jobId: string): Record<string, number> {
    return handle.sqlite
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
          (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
          (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions,
          (SELECT COUNT(*) FROM tailoring_workspaces WHERE job_id = ?) AS workspaces`,
      )
      .get(jobId, jobId, jobId, jobId) as Record<string, number>;
  }

  it("returns RecommendationsReply with an honest hash and no-store", async () => {
    const { basics } = seedBasics();
    const response = await recommendationsGET(
      getRequest(recPath(basics)),
      routeParams(basics.jobId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = RecommendationsReply.parse(await readJson(response));
    expect(body.recommendations.extractionId).toBe(basics.extractionId);
    expect(body.recommendations.profileVersionId).toBe(basics.profileVersionId);
    expect(body.recommendationHash).toBe(hashRecommendation(body.recommendations));
    expect(body.recommendations.phrases.length).toBeGreaterThan(0);
    // Repeated reads replay identical bytes with no provider
    // configured at all: strip every key var to prove the endpoint
    // never consults provider setup (D4 spy count 0).
    const savedEnv = {
      ACTIVE_AI_PROVIDER: process.env["ACTIVE_AI_PROVIDER"],
      OPENROUTER_API_KEY: process.env["OPENROUTER_API_KEY"],
      GEMINI_API_KEY: process.env["GEMINI_API_KEY"],
      META_API_KEY: process.env["META_API_KEY"],
    };
    delete process.env["ACTIVE_AI_PROVIDER"];
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["META_API_KEY"];
    let again: Response;
    try {
      again = await recommendationsGET(getRequest(recPath(basics)), routeParams(basics.jobId));
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    const againBody = RecommendationsReply.parse(await readJson(again));
    expect(againBody.recommendationHash).toBe(body.recommendationHash);
    expect(againBody.recommendations).toEqual(body.recommendations);
    withDb((handle) => {
      expect(q1q9(handle, basics.jobId)).toEqual({
        requests: 0,
        work: 0,
        versions: 0,
        workspaces: 0,
      });
    });
  });

  it("400s malformed path and query IDs", async () => {
    const { basics } = seedBasics();
    const badPath = await recommendationsGET(
      getRequest(`/api/jobs/not-a-uuid/tailoring/recommendations?extractionId=${basics.extractionId}&profileVersionId=${basics.profileVersionId}`),
      routeParams("not-a-uuid"),
    );
    expect(badPath.status).toBe(400);
    const missingParam = await recommendationsGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=${basics.extractionId}`),
      routeParams(basics.jobId),
    );
    expect(missingParam.status).toBe(400);
    expect(TailoringErrorBody.parse(await readJson(missingParam)).error.code).toBe(
      "INVALID_REQUEST",
    );
    const malformedParam = await recommendationsGET(
      getRequest(
        `/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=nope&profileVersionId=${basics.profileVersionId}`,
      ),
      routeParams(basics.jobId),
    );
    expect(malformedParam.status).toBe(400);
  });

  it("404s unknown jobs and foreign bindings", async () => {
    const { basics } = seedBasics();
    const missing = newId();
    const unknownJob = await recommendationsGET(
      getRequest(
        `/api/jobs/${missing}/tailoring/recommendations?extractionId=${basics.extractionId}&profileVersionId=${basics.profileVersionId}`,
      ),
      routeParams(missing),
    );
    expect(unknownJob.status).toBe(404);
    const foreign = await recommendationsGET(
      getRequest(
        `/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=${basics.extractionId}&profileVersionId=${newId()}`,
      ),
      routeParams(basics.jobId),
    );
    expect(foreign.status).toBe(404);
    expect(TailoringErrorBody.parse(await readJson(foreign)).error.code).toBe("NOT_FOUND");
  });

  it("rebuilds recommendations when the profile binding changes (D5 recompute)", async () => {
    const { basics, world } = seedBasics();
    // SPM's version is active for its own profile, so the build
    // succeeds — with a different profile hash than the PM binding.
    const spm = await recommendationsGET(
      getRequest(
        `/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=${basics.extractionId}&profileVersionId=${world.spmVersionId}`,
      ),
      routeParams(basics.jobId),
    );
    expect(spm.status).toBe(200);
    const spmBody = RecommendationsReply.parse(await readJson(spm));
    expect(spmBody.recommendations.profileVersionId).toBe(world.spmVersionId);
    const fresh = await recommendationsGET(
      getRequest(recPath(basics)),
      routeParams(basics.jobId),
    );
    const freshBody = RecommendationsReply.parse(await readJson(fresh));
    expect(spmBody.recommendationHash).not.toBe(freshBody.recommendationHash);
  });

  it("409s owned but no-longer-active extractions", async () => {
    const { basics } = seedBasics();
    const secondId = withDb((handle) => {
      const attemptId = newId();
      handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId: basics.jobId,
          canonicalUrl: "https://example.com/jobs/second",
          startedAt: V13_T0,
          finishedAt: V13_T0,
          outcome: "SUCCEEDED",
        })
        .run();
      const id = newId();
      handle.db
        .insert(jobExtractions)
        .values({
          id,
          jobId: basics.jobId,
          scrapeAttemptId: attemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: v13ExtractionJson("Kubernetes operators and Helm charts."),
        })
        .run();
      handle.db.update(jobs).set({ activeExtractionId: id }).where(eq(jobs.id, basics.jobId)).run();
      return id;
    });
    const stale = await recommendationsGET(
      getRequest(
        `/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=${basics.extractionId}&profileVersionId=${basics.profileVersionId}`,
      ),
      routeParams(basics.jobId),
    );
    expect(stale.status).toBe(409);
    expect(TailoringErrorBody.parse(await readJson(stale)).error.code).toBe("INPUT_STALE");
    const current = await recommendationsGET(
      getRequest(
        `/api/jobs/${basics.jobId}/tailoring/recommendations?extractionId=${secondId}&profileVersionId=${basics.profileVersionId}`,
      ),
      routeParams(basics.jobId),
    );
    expect(current.status).toBe(200);
  });

  it("422s active bindings without JD text and 503s corrupt storage", async () => {
    // Both jobs share one seeded world; each world seed is expensive.
    const both = withDb((handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      const noJd = seedV13Basics(handle, world, {
        jdText: "placeholder",
        extractedJson: v13ExtractionJson(null),
      });
      const corrupt = seedV13Basics(handle, world);
      return { noJd, corrupt };
    });
    const notReady = await recommendationsGET(
      getRequest(
        `/api/jobs/${both.noJd.jobId}/tailoring/recommendations?extractionId=${both.noJd.extractionId}&profileVersionId=${both.noJd.profileVersionId}`,
      ),
      routeParams(both.noJd.jobId),
    );
    expect(notReady.status).toBe(422);
    expect(TailoringErrorBody.parse(await readJson(notReady)).error.code).toBe("JD_NOT_READY");
    const broken = await recommendationsGET(
      getRequest(
        `/api/jobs/${both.corrupt.jobId}/tailoring/recommendations?extractionId=${both.corrupt.extractionId}&profileVersionId=${both.corrupt.profileVersionId}`,
      ),
      routeParams(both.corrupt.jobId),
    );
    expect(broken.status).toBe(503);
    expect(TailoringErrorBody.parse(await readJson(broken)).error.code).toBe("STORAGE_UNAVAILABLE");
  });

  it("resolves master previews by exact profile/version and 404s foreign IDs (D1)", async () => {
    const { world } = seedBasics();
    const params = (id: string, versionId: string) => ({
      params: Promise.resolve({ id, versionId }),
    });
    const exact = await masterVersionGET(
      getRequest(`/api/settings/profiles/${world.pmProfileId}/versions/${world.pmVersionId}`),
      params(world.pmProfileId, world.pmVersionId),
    );
    expect(exact.status).toBe(200);
    const body = (await readJson(exact)) as {
      profile?: { id?: string };
      version?: { id?: string };
      payload?: { identity?: { fullName?: string } };
    };
    expect(body.profile?.id).toBe(world.pmProfileId);
    expect(body.version?.id).toBe(world.pmVersionId);
    expect(body.payload?.identity?.fullName).toBeTruthy();
    // The SPM version under the PM profile path is foreign: 404.
    const foreign = await masterVersionGET(
      getRequest(`/api/settings/profiles/${world.pmProfileId}/versions/${world.spmVersionId}`),
      params(world.pmProfileId, world.spmVersionId),
    );
    expect(foreign.status).toBe(404);
    const missing = await masterVersionGET(
      getRequest(`/api/settings/profiles/${world.pmProfileId}/versions/${newId()}`),
      params(world.pmProfileId, newId()),
    );
    expect(missing.status).toBe(404);
  });
});
