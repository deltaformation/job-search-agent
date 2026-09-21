// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { POST as generationsPOST } from "../../../app/api/jobs/[id]/tailoring/generations/route";
import {
  generationRequests,
  newId,
  openDatabase,
  tailoringWorkspaces,
  type DatabaseHandle,
} from "../../../src/db";
import {
  GenerationReply,
  TailoringErrorBody,
  TAILORING_SUBMIT_SCHEMA_VERSION,
} from "../../../src/domain/tailoringWorkspace";
import {
  getRecommendations,
  workspaceRecommendationsProvider,
} from "../../../src/server/recommendations";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  v13ExtractionJson,
  type V13Basics,
} from "../db/v13world";
import {
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "./_helpers";

/**
 * E6/E7/E9 route leg: POST generations maps G results to
 * 202/200/400/403/404/409/422/503 with strict reply bodies. The
 * route enqueues only — submissions succeed with no provider
 * command configured, proving execution stays out of web routes.
 */

const JD = "TypeScript APIs with Redis caching and go-to-market launches. Jira boards.";

describe("POST generations route", () => {
  let isolated: IsolatedRoot;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-e-routes-");
    process.env["ACTIVE_AI_PROVIDER"] = "openrouter";
    process.env["OPENROUTER_API_KEY"] = "test-key";
    delete process.env["TAILOR_PROVIDER_ARGV"];
  });

  afterEach(() => {
    delete process.env["ACTIVE_AI_PROVIDER"];
    delete process.env["OPENROUTER_API_KEY"];
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

  function seedDraft(): { basics: V13Basics; world: CrossProfileWorld } {
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
      const recs = getRecommendations(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        profileVersionId: basics.profileVersionId,
      });
      if (!recs.ok) throw new Error("recommendations seed failed");
      const saved = saveWorkspace(
        handle,
        basics.jobId,
        0,
        {
          schemaVersion: "tailoring-workspace/v1",
          extractionId: basics.extractionId,
          profileId: basics.profileId,
          profileVersionId: basics.profileVersionId,
          requestKind: "INITIAL",
          parentVersionId: null,
          revisionNote: null,
          recommendationHash: hashRecommendation(recs.recommendations),
          focus: recs.recommendations.preset,
        },
        { now: () => "2026-09-16T12:00:00.000Z", recommendations: workspaceRecommendationsProvider },
      );
      if (!saved.ok) throw new Error(`workspace seed failed: ${saved.failure.error}`);
      return { basics, world };
    });
  }

  function submitBody(requestId: string, overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
      requestId,
      workspaceRevision: 1,
      observedRowVersion: 1,
      ...overrides,
    };
  }

  it("202s a new run with a strict reply and no-store (E6)", async () => {
    const { basics } = seedDraft();
    const requestId = newId();
    // No provider command is configured: the route enqueues without
    // executing anything.
    expect(process.env["TAILOR_PROVIDER_ARGV"]).toBeUndefined();
    const response = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody(requestId)),
      routeParams(basics.jobId),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = GenerationReply.parse(await readJson(response));
    expect(body).toMatchObject({
      requestId,
      status: "QUEUED",
      replayed: false,
      jobRowVersion: 2,
      workspaceRevision: 2,
    });
    withDb((handle) => {
      expect(
        handle.db.select().from(generationRequests).where(eq(generationRequests.id, requestId)).get(),
      ).toMatchObject({ requestKind: "INITIAL", status: "QUEUED" });
    });
  });

  it("200s byte-identical replays and 409s changed bytes (E9)", async () => {
    const { basics } = seedDraft();
    const requestId = newId();
    const first = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody(requestId)),
      routeParams(basics.jobId),
    );
    expect(first.status).toBe(202);
    const replay = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody(requestId)),
      routeParams(basics.jobId),
    );
    expect(replay.status).toBe(200);
    expect(GenerationReply.parse(await readJson(replay))).toMatchObject({
      requestId,
      replayed: true,
      jobRowVersion: 2,
      workspaceRevision: 2,
    });
    const mismatch = await generationsPOST(
      postRequest(
        `/api/jobs/${basics.jobId}/tailoring/generations`,
        submitBody(requestId, { observedRowVersion: 2 }),
      ),
      routeParams(basics.jobId),
    );
    expect(mismatch.status).toBe(409);
    expect(TailoringErrorBody.parse(await readJson(mismatch)).error.code).toBe(
      "IDEMPOTENCY_MISMATCH",
    );
  });

  it("400s malformed path and body, 403s cross-origin mutations", async () => {
    const { basics } = seedDraft();
    const badPath = await generationsPOST(
      postRequest("/api/jobs/not-a-uuid/tailoring/generations", submitBody(newId())),
      routeParams("not-a-uuid"),
    );
    expect(badPath.status).toBe(400);
    const badBody = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, {
        schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
        requestId: "nope",
      }),
      routeParams(basics.jobId),
    );
    expect(badBody.status).toBe(400);
    expect(TailoringErrorBody.parse(await readJson(badBody)).error.code).toBe("INVALID_REQUEST");
    const crossOrigin = await generationsPOST(
      new Request(`http://127.0.0.1:3000/api/jobs/${basics.jobId}/tailoring/generations`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://evil.example:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(submitBody(newId())),
      }),
      routeParams(basics.jobId),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("404s unknown jobs", async () => {
    seedDraft();
    const missing = newId();
    const response = await generationsPOST(
      postRequest(`/api/jobs/${missing}/tailoring/generations`, submitBody(newId())),
      routeParams(missing),
    );
    expect(response.status).toBe(404);
    expect(TailoringErrorBody.parse(await readJson(response)).error.code).toBe("NOT_FOUND");
  });

  it("409s conflicts, staleness, and busy with current counters (E7)", async () => {
    const { basics } = seedDraft();
    const path = `/api/jobs/${basics.jobId}/tailoring/generations`;
    const staleDraft = await generationsPOST(
      postRequest(path, submitBody(newId(), { workspaceRevision: 99 })),
      routeParams(basics.jobId),
    );
    expect(staleDraft.status).toBe(409);
    expect(TailoringErrorBody.parse(await readJson(staleDraft)).error).toMatchObject({
      code: "WORKSPACE_CONFLICT",
      currentWorkspaceRevision: 1,
    });
    const staleJob = await generationsPOST(
      postRequest(path, submitBody(newId(), { observedRowVersion: 99 })),
      routeParams(basics.jobId),
    );
    expect(staleJob.status).toBe(409);
    expect(TailoringErrorBody.parse(await readJson(staleJob)).error).toMatchObject({
      code: "JOB_CONFLICT",
      currentRowVersion: 1,
    });
    const first = await generationsPOST(
      postRequest(path, submitBody(newId())),
      routeParams(basics.jobId),
    );
    expect(first.status).toBe(202);
    const busy = await generationsPOST(
      postRequest(path, submitBody(newId(), { workspaceRevision: 2, observedRowVersion: 2 })),
      routeParams(basics.jobId),
    );
    expect(busy.status).toBe(409);
    expect(TailoringErrorBody.parse(await readJson(busy)).error.code).toBe("GENERATION_BUSY");
  });

  it("422s unreadiness and 503s corrupt storage (E7)", async () => {
    const { basics } = seedDraft();
    const path = `/api/jobs/${basics.jobId}/tailoring/generations`;
    delete process.env["OPENROUTER_API_KEY"];
    try {
      const keyless = await generationsPOST(
        postRequest(path, submitBody(newId())),
        routeParams(basics.jobId),
      );
      expect(keyless.status).toBe(422);
      expect(TailoringErrorBody.parse(await readJson(keyless)).error.code).toBe("PROVIDER_NOT_READY");
    } finally {
      process.env["OPENROUTER_API_KEY"] = "test-key";
    }
    // Corrupt the stored focus behind a valid W save: schema-valid
    // JSON that fails FocusV1 must fail closed, never submit.
    withDb((handle) => {
      handle.db
        .update(tailoringWorkspaces)
        .set({ focusJson: "{}", revision: sql`revision + 1` })
        .where(eq(tailoringWorkspaces.jobId, basics.jobId))
        .run();
    });
    const corrupt = await generationsPOST(
      postRequest(path, submitBody(newId(), { workspaceRevision: 2 })),
      routeParams(basics.jobId),
    );
    expect(corrupt.status).toBe(503);
    expect(TailoringErrorBody.parse(await readJson(corrupt)).error.code).toBe("STORAGE_UNAVAILABLE");
  });
});
