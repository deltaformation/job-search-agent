// @vitest-environment node
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as planGET } from "../../../app/api/jobs/[id]/tailoring/plan/route";
import { POST as validatePOST } from "../../../app/api/jobs/[id]/tailoring/draft/validate/route";
import {
  GET as preparationGET,
  POST as preparationPOST,
} from "../../../app/api/jobs/[id]/tailoring/preparation/route";
import { POST as retryPOST } from "../../../app/api/jobs/[id]/tailoring/preparation/retry/route";
import {
  newId,
  openDatabase,
  type DatabaseHandle,
} from "../../../src/db";
import { saveWorkspaceCAS } from "../../../src/db/tailoringWorkspace";
import { getOrCreateJdSnapshot } from "../../../src/server/candidates";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import { seedV13Basics, v13ExtractionJson, type V13Basics } from "../db/v13world";
import {
  getRequest,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import {
  claimS2b,
  finishS2bAttempt,
  runS2bAttempt,
  s2bProposalKit,
  seedV1Accepted,
  S2B_JD,
  S2B_KEYED_ENV,
} from "./s2b-world";

/**
 * WO-1.3-S2-B HTTP legs: the preparation/plan/validate routes map
 * the P/PR service outcomes to the §4 status table (202/200,
 * 404/409/422), show the chosen profile on explicit schedules,
 * and refuse malformed callers before touching the database.
 */

const KEY_NAME = "OPENROUTER_API_KEY";

function keyedEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(S2B_KEYED_ENV)) {
    if (!(key in previous)) {
      previous[key] = process.env[key];
    }
    process.env[key] = value;
  }
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("S2B HTTP status mapping", () => {
  let isolated: IsolatedRoot;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-s2b-routes-");
    savedEnv = {};
    keyedEnv(savedEnv);
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    isolated.restoreEnv();
    isolated.cleanup();
  });

  async function withDb<T>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    try {
      return await fn(handle);
    } finally {
      handle.close();
    }
  }

  function seedJob(): Promise<{ basics: V13Basics; world: CrossProfileWorld }> {
    return withDb((handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      return {
        basics: seedV13Basics(handle, world, {
          jdText: S2B_JD,
          extractedJson: v13ExtractionJson(S2B_JD),
        }),
        world,
      };
    });
  }

  function prepareBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "step2-prepare/v1",
      operationId: newId(),
      observedRowVersion: 1,
      profileId: null,
      ...overrides,
    };
  }

  it("POST preparation maps 202/200/409/404/422 and shows the chosen profile", async () => {
    const { basics, world } = await seedJob();
    const path = `/api/jobs/${basics.jobId}/tailoring/preparation`;
    // Legacy job without a profile: 422 names the missing binding.
    const missing = await preparationPOST(postRequest(path, prepareBody()), routeParams(basics.jobId));
    expect(missing.status).toBe(422);
    expect(((await readJson(missing))["error"] as Record<string, unknown>)["code"]).toBe(
      "PROFILE_NOT_READY",
    );
    // Unknown profile: 404.
    const unknown = await preparationPOST(
      postRequest(path, prepareBody({ profileId: newId() })),
      routeParams(basics.jobId),
    );
    expect(unknown.status).toBe(404);
    // Explicit schedule: 202 and the reply shows the chosen binding.
    const operationId = newId();
    const scheduled = await preparationPOST(
      postRequest(path, prepareBody({ operationId, profileId: world.pmProfileId })),
      routeParams(basics.jobId),
    );
    expect(scheduled.status).toBe(202);
    const scheduledBody = await readJson(scheduled);
    expect(scheduledBody).toMatchObject({
      ok: true,
      state: "QUEUED",
      replayed: false,
      profileId: world.pmProfileId,
      profileVersionId: world.pmVersionId,
    });
    expect(typeof scheduledBody["preparationId"]).toBe("string");
    // Identical replay: 200 with the same preparation id.
    const replayed = await preparationPOST(
      postRequest(path, prepareBody({ operationId, profileId: world.pmProfileId })),
      routeParams(basics.jobId),
    );
    expect(replayed.status).toBe(200);
    expect(await readJson(replayed)).toMatchObject({
      ok: true,
      preparationId: scheduledBody["preparationId"],
      replayed: true,
      profileId: world.pmProfileId,
      profileVersionId: world.pmVersionId,
    });
    // Same id, changed bytes: 409 mismatch.
    const mismatched = await preparationPOST(
      postRequest(path, prepareBody({ operationId, profileId: world.spmProfileId })),
      routeParams(basics.jobId),
    );
    expect(mismatched.status).toBe(409);
    expect(((await readJson(mismatched))["error"] as Record<string, unknown>)["code"]).toBe(
      "IDEMPOTENCY_MISMATCH",
    );
    // Live run: 409 busy. Stale version on an idle job: covered by
    // the service matrix (the route passes the code through).
    const busy = await preparationPOST(
      postRequest(path, prepareBody({ observedRowVersion: 2, profileId: world.pmProfileId })),
      routeParams(basics.jobId),
    );
    expect(busy.status).toBe(409);
    expect(((await readJson(busy))["error"] as Record<string, unknown>)["code"]).toBe(
      "PREPARATION_BUSY",
    );
    // Unknown job: 404 without touching the database.
    const ghost = await preparationPOST(
      postRequest(path, prepareBody({ profileId: world.pmProfileId })),
      routeParams(newId()),
    );
    expect(ghost.status).toBe(404);
  });

  it("POST preparation without a provider key is 422 and writes nothing", async () => {
    const { basics, world } = await seedJob();
    delete process.env[KEY_NAME];
    try {
      const path = `/api/jobs/${basics.jobId}/tailoring/preparation`;
      const response = await preparationPOST(
        postRequest(path, prepareBody({ profileId: world.pmProfileId })),
        routeParams(basics.jobId),
      );
      expect(response.status).toBe(422);
      expect(((await readJson(response))["error"] as Record<string, unknown>)["code"]).toBe(
        "PROVIDER_NOT_READY",
      );
      const version = await withDb(
        (handle) =>
          handle.sqlite.prepare("SELECT row_version AS v FROM jobs WHERE id = ?").get(basics.jobId) as {
            v: number;
          },
      );
      expect(version.v).toBe(1);
    } finally {
      process.env[KEY_NAME] = S2B_KEYED_ENV[KEY_NAME] as string;
    }
  });

  it("POST preparation rejects malformed callers before the database", async () => {
    const { basics } = await seedJob();
    const path = `/api/jobs/${basics.jobId}/tailoring/preparation`;
    const badShape = await preparationPOST(
      postRequest(path, { schemaVersion: "step2-prepare/v1" }),
      routeParams(basics.jobId),
    );
    expect(badShape.status).toBe(400);
    const badId = await preparationPOST(postRequest(path, prepareBody()), routeParams("not-a-uuid"));
    expect(badId.status).toBe(400);
    const forged = new Request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "evil.example" },
      body: JSON.stringify(prepareBody()),
    });
    expect((await preparationPOST(forged, routeParams(basics.jobId))).status).toBe(403);
  });

  it("retry maps 404/422/200/202 across the attempt lifecycle", async () => {
    const { basics, world } = await seedJob();
    const path = `/api/jobs/${basics.jobId}/tailoring/preparation/retry`;
    const retryBody = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: "step2-prepare-retry/v1",
      observedAttemptId: newId(),
      observedRowVersion: 1,
      ...overrides,
    });
    // No preparation at all: 422, and unknown jobs 404.
    expect((await retryPOST(postRequest(path, retryBody()), routeParams(basics.jobId))).status).toBe(422);
    expect((await retryPOST(postRequest(path, retryBody()), routeParams(newId()))).status).toBe(404);

    // Schedule through the real route, then drive the worker path
    // on the isolated database.
    const scheduled = await preparationPOST(
      postRequest(
        `/api/jobs/${basics.jobId}/tailoring/preparation`,
        prepareBody({ operationId: newId(), profileId: world.pmProfileId }),
      ),
      routeParams(basics.jobId),
    );
    expect(scheduled.status).toBe(202);
    const claimed = await withDb((handle) => claimS2b(handle));
    // Live run replays 200.
    const live = await retryPOST(
      postRequest(path, retryBody({ observedAttemptId: claimed.attemptId, observedRowVersion: 2 })),
      routeParams(basics.jobId),
    );
    expect(live.status).toBe(200);
    expect(await readJson(live)).toMatchObject({ ok: true, replayed: true });
    // Unknown attempt on the owned job: 404.
    const ghostAttempt = await retryPOST(
      postRequest(path, retryBody({ observedAttemptId: newId(), observedRowVersion: 2 })),
      routeParams(basics.jobId),
    );
    expect(ghostAttempt.status).toBe(404);
    // Terminal AUTH failure requeues through the route: 202.
    await withDb(async (handle) => {
      const jd = getOrCreateJdSnapshot(handle, {
        jobId: basics.jobId,
        extractionId: basics.extractionId,
        jdText: S2B_JD,
      });
      if (!jd.ok) {
        throw new Error("S2-B JD snapshot failed");
      }
      const provider = new TestPrepareProvider({
        proposals: {},
        failures: { [jd.snapshotId]: { reason: "AUTHENTICATION" } },
      });
      const outcome = await runS2bAttempt(handle, claimed, provider);
      finishS2bAttempt(handle, { ...claimed, outcome });
    });
    const requeued = await retryPOST(
      postRequest(path, retryBody({ observedAttemptId: claimed.attemptId, observedRowVersion: 2 })),
      routeParams(basics.jobId),
    );
    expect(requeued.status).toBe(202);
    expect(await readJson(requeued)).toMatchObject({ ok: true, replayed: false });
  });

  it("GET preparation and GET plan serve status, plans, and staleness", async () => {
    const { basics, world } = await seedJob();
    const statusPath = `/api/jobs/${basics.jobId}/tailoring/preparation`;
    const absent = await preparationGET(getRequest(statusPath), routeParams(basics.jobId));
    expect(absent.status).toBe(200);
    expect(await readJson(absent)).toMatchObject({ ok: true, preparation: { state: "ABSENT" } });
    expect((await preparationGET(getRequest(statusPath), routeParams(newId()))).status).toBe(404);

    const planPath = `/api/jobs/${basics.jobId}/tailoring/plan`;
    const noPlan = await planGET(getRequest(planPath), routeParams(basics.jobId));
    expect(noPlan.status).toBe(404);

    // Run to an accepted plan, then read it back over HTTP.
    const kit = await withDb((handle) => s2bProposalKit(handle, basics, world));
    const scheduleResponse = await preparationPOST(
      postRequest(statusPath, prepareBody({ profileId: world.pmProfileId })),
      routeParams(basics.jobId),
    );
    expect(scheduleResponse.status).toBe(202);
    await withDb(async (handle) => {
      const claimed = claimS2b(handle);
      const provider = new TestPrepareProvider({
        proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
      });
      const outcome = await runS2bAttempt(handle, claimed, provider);
      finishS2bAttempt(handle, { ...claimed, outcome });
    });
    const status = await preparationGET(getRequest(statusPath), routeParams(basics.jobId));
    expect(status.status).toBe(200);
    const statusBody = await readJson(status);
    expect(statusBody).toMatchObject({ ok: true, preparation: { state: "SUCCEEDED" } });
    const acceptedPlanId = (
      (statusBody["preparation"] as Record<string, unknown>)["acceptedPlanId"] as string
    );
    const plan = await planGET(getRequest(planPath), routeParams(basics.jobId));
    expect(plan.status).toBe(200);
    const planBody = await readJson(plan);
    expect((planBody["plan"] as Record<string, unknown>)["planId"]).toBe(acceptedPlanId);
    const named = await planGET(getRequest(`${planPath}?planId=${acceptedPlanId}`), routeParams(basics.jobId));
    expect(named.status).toBe(200);
    expect((await planGET(getRequest(`${planPath}?planId=not-a-uuid`), routeParams(basics.jobId))).status).toBe(400);
    expect((await planGET(getRequest(planPath), routeParams(newId()))).status).toBe(404);
  });

  it("POST draft/validate maps verdicts, conflicts, and missing plans", async () => {
    const { basics, world } = await seedJob();
    const path = `/api/jobs/${basics.jobId}/tailoring/draft/validate`;
    const body = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: "step2-validate-draft/v1",
      workspaceRevision: 1,
      summaryText: "Product manager.",
      operations: [],
      ...overrides,
    });
    // Nothing accepted yet: 404 plan.
    expect((await validatePOST(postRequest(path, body()), routeParams(basics.jobId))).status).toBe(404);
    expect((await validatePOST(postRequest(path, body()), routeParams(newId()))).status).toBe(404);

    // Accept a v1 plan directly and save a workspace, then validate
    // over HTTP. Direct seeding proves the preserved v1 validate
    // path (the handler produces v2 plans after the cutover).
    await withDb(async (handle) => {
      seedV1Accepted(handle, world, S2B_JD, new Date().toISOString(), basics);
      const saved = saveWorkspaceCAS(handle, {
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
        now: new Date().toISOString(),
      });
      if (!saved.ok) {
        throw new Error("S2-B workspace save failed");
      }
    });
    const validated = await validatePOST(postRequest(path, body()), routeParams(basics.jobId));
    expect(validated.status).toBe(200);
    const validatedBody = await readJson(validated);
    expect(validatedBody["ok"]).toBe(true);
    expect(typeof validatedBody["validationId"]).toBe("string");
    const conflicted = await validatePOST(
      postRequest(path, body({ workspaceRevision: 7 })),
      routeParams(basics.jobId),
    );
    expect(conflicted.status).toBe(409);
    expect(((await readJson(conflicted))["error"] as Record<string, unknown>)["code"]).toBe(
      "WORKSPACE_CONFLICT",
    );
  });
});
