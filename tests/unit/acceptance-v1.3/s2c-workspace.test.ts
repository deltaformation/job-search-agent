// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import {
  newId,
  openDatabase,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { insertPlan, markPreparationSucceeded, readPlan, readStep2GenerationInputs } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import {
  STEP2_SCHEMA_VERSIONS,
  type Step2DraftOperationV1,
  type Step2DraftV1,
  type WorkspacePutV2,
} from "../../../src/domain/step2";
import { buildWorkspaceETag } from "../../../src/domain/tailoringWorkspace";
import { activateProfileVersion, importCandidate } from "../../../src/server/candidates";
import { submitGeneration } from "../../../src/server/generations";
import { getWorkspaceView, saveWorkspaceV2 } from "../../../src/server/tailoringWorkspace";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import { planHashFor } from "../../../src/tailoring/step2policy";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import {
  stubRecommendationsProvider,
  v13Focus,
  v13Recommendations,
  type V13Basics,
} from "../db/v13world";
import {
  getRequest,
  mutationHeaders,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import {
  acceptV1Plan,
  claimS2b,
  finishS2bAttempt,
  pmEvidenceFor,
  proposalForS2b,
  s2bSnapshotIds,
  S2B_JD,
  S2B_KEYED_ENV,
  S2B_T0,
  scheduleS2b,
  seedS2bJob,
  seedV1Accepted,
  withS2bDatabase,
} from "./s2b-world";

/**
 * WO-1.3-S2-C workspace v2 legs (S2C4 persistence): PUT accepts the
 * contract's `tailoring-workspace/v2` body beside v1, CAS-guards it
 * under the same ETag scheme, rejects stale-plan writes while
 * preserving the stored draft, and reports op errors as 422
 * INVALID_SELECTION with `draft.*` field paths. v1 and v2 replace
 * the stored bytes wholesale — never merge.
 */

function putRequest(path: string, body: unknown, ifMatch: string | null): Request {
  const headers: Record<string, string> = {
    ...mutationHeaders(),
    "content-type": "application/json",
  };
  if (ifMatch !== null) {
    headers["if-match"] = ifMatch;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

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

interface AcceptedWorld {
  basics: V13Basics;
  world: CrossProfileWorld;
  preparationId: string;
  planId: string;
  planHash: string;
  suggestionId: string;
  roleId: string;
}

function v2Body(basics: V13Basics, overrides: Partial<WorkspacePutV2> = {}): WorkspacePutV2 {
  return {
    schemaVersion: STEP2_SCHEMA_VERSIONS.workspace,
    extractionId: basics.extractionId,
    profileId: basics.profileId,
    profileVersionId: basics.profileVersionId,
    requestKind: "INITIAL",
    parentVersionId: null,
    revisionNote: null,
    planId: null,
    planHash: null,
    recommendationHash: null,
    draft: null,
    ...overrides,
  };
}

function v2Draft(
  accepted: { planId: string; planHash: string },
  operations: Step2DraftOperationV1[],
  summaryText = "",
  summarySource: Step2DraftV1["summarySource"] = "edited",
): Step2DraftV1 {
  return {
    schemaVersion: STEP2_SCHEMA_VERSIONS.draft,
    planId: accepted.planId,
    planHash: accepted.planHash,
    summaryText,
    summarySource,
    operations,
  };
}

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  return body["error"] as Record<string, unknown>;
}

describe("S2C workspace v2 routes", () => {
  let isolated: IsolatedRoot;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-s2c-workspace-");
    savedEnv = {};
    keyedEnv(savedEnv);
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function withDb<T>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    return Promise.resolve()
      .then(() => fn(handle))
      .finally(() => handle.close());
  }

  /** Seed a world, run a real PREPARE cycle, return the accepted plan. */
  function seedAccepted(): Promise<AcceptedWorld> {
    return withDb(async (handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      // Direct v1 seed: the real handler emits v2 plans now, and
      // W-v2 saves bind v1 plans, so the preserved v1 path is
      // seeded with the pure v1 builder (no provider round-trip).
      const seed = seedV1Accepted(handle, world);
      const usable = seed.plan.suggestions.find((suggestion) => suggestion.usable);
      if (usable === undefined) {
        throw new Error("S2-C setup produced no usable suggestion");
      }
      return {
        basics: seed.basics,
        world,
        preparationId: seed.preparationId,
        planId: seed.planRowId,
        planHash: seed.planHash,
        suggestionId: usable.suggestionId,
        roleId: usable.roleId,
      };
    });
  }

  it("PUT v2 creates the empty editor; GET returns the stored v2 schema", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const created = await workspacePUT(
      putRequest(path, v2Body(accepted.basics), buildWorkspaceETag(accepted.basics.jobId, 0)),
      routeParams(accepted.basics.jobId),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe(buildWorkspaceETag(accepted.basics.jobId, 1));
    const createdBody = await readJson(created);
    const createdWorkspace = (createdBody["workspace"] ?? {}) as Record<string, unknown>;
    const createdDraft = (createdWorkspace["draft"] ?? {}) as Record<string, unknown>;
    expect(createdDraft["schemaVersion"]).toBe("tailoring-workspace/v2");
    expect(createdDraft["draft"]).toBeNull();

    const read = await workspaceGET(
      getRequest(path),
      routeParams(accepted.basics.jobId),
    );
    expect(read.status).toBe(200);
    const readBody = await readJson(read);
    const workspace = (readBody["workspace"] ?? {}) as Record<string, unknown>;
    const draft = (workspace["draft"] ?? {}) as Record<string, unknown>;
    expect(draft["schemaVersion"]).toBe("tailoring-workspace/v2");
    expect(workspace["revision"]).toBe(1);
  });

  it("PUT v2 saves plan-bound draft ops; GET round-trips order and text", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const opId1 = "11111111-1111-4111-8111-111111111111";
    const opId2 = "22222222-2222-4222-8222-222222222222";
    const draft = v2Draft(accepted, [
      { op: "add", operationId: opId1, suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: null },
      { op: "exclude", operationId: opId2, targetFactId: "pm-fact-pricing" },
    ]);
    const saved = await workspacePUT(
      putRequest(
        path,
        v2Body(accepted.basics, { planId: accepted.planId, planHash: accepted.planHash, draft }),
        buildWorkspaceETag(accepted.basics.jobId, 0),
      ),
      routeParams(accepted.basics.jobId),
    );
    expect(saved.status).toBe(201);
    const read = await workspaceGET(getRequest(path), routeParams(accepted.basics.jobId));
    const workspace = ((await readJson(read))["workspace"] ?? {}) as Record<string, unknown>;
    const stored = ((workspace["draft"] ?? {}) as Record<string, unknown>)["draft"] as {
      operations: Array<{ op: string; operationId: string }>;
    };
    expect(stored.operations.map((op) => op.operationId)).toEqual([opId1, opId2]);
  });

  it("stale plan writes are rejected; the stored draft is preserved", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const first = v2Draft(accepted, [
      { op: "add", operationId: "33333333-3333-4333-8333-333333333333", suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: null },
    ]);
    const saved = await workspacePUT(
      putRequest(
        path,
        v2Body(accepted.basics, { planId: accepted.planId, planHash: accepted.planHash, draft: first }),
        buildWorkspaceETag(accepted.basics.jobId, 0),
      ),
      routeParams(accepted.basics.jobId),
    );
    expect(saved.status).toBe(201);

    // A second preparation cycle supersedes the accepted plan.
    const secondPlanId = await withDb((handle) => {
      const previous = readPlan(handle, accepted.planId);
      if (previous === null) {
        throw new Error("S2-C setup lost the first plan");
      }
      const planJson = JSON.parse(previous.planJson) as Record<string, unknown>;
      const nextId = "44444444-4444-4444-8444-444444444444";
      const next = { ...planJson, planId: nextId, rationale: "Second S2-C cycle." };
      const nextHash = planHashFor(next as Parameters<typeof planHashFor>[0]);
      insertPlan(handle, {
        id: nextId,
        preparationId: previous.preparationId,
        planJson: canonicalJson(next),
        planHash: nextHash,
        providerId: previous.providerId,
        model: previous.model,
        promptVersion: "prepare-prompt/v1",
        proposalSchemaVersion: "preparation-proposal/v1",
        claimsPolicyVersion: "step2-claims/1",
        inputHash: previous.inputHash,
        proposalHash: previous.proposalHash,
        attemptId: previous.attemptId,
        validationJson: previous.validationJson,
        supersedesPlanId: previous.id,
        now: S2B_T0,
      });
      markPreparationSucceeded(handle, { preparationId: accepted.preparationId, planId: nextId, now: S2B_T0 });
      return nextId;
    });

    const stale = await workspacePUT(
      putRequest(
        path,
        v2Body(accepted.basics, { planId: accepted.planId, planHash: accepted.planHash, draft: first }),
        buildWorkspaceETag(accepted.basics.jobId, 1),
      ),
      routeParams(accepted.basics.jobId),
    );
    expect(stale.status).toBe(409);
    expect(errorOf(await readJson(stale))["code"]).toBe("PLAN_STALE");

    const read = await workspaceGET(getRequest(path), routeParams(accepted.basics.jobId));
    const workspace = ((await readJson(read))["workspace"] ?? {}) as Record<string, unknown>;
    expect(workspace["revision"]).toBe(1);
    const stored = ((workspace["draft"] ?? {}) as Record<string, unknown>)["draft"] as { planId: string };
    expect(stored.planId).toBe(accepted.planId);

    // Rebinding to the accepted plan recovers the save.
    const rebound = v2Draft({ ...accepted, planId: secondPlanId, planHash: "0".repeat(64) }, first.operations);
    const storedSecond = await withDb((handle) => readPlan(handle, secondPlanId));
    if (storedSecond === null) {
      throw new Error("S2-C setup lost the second plan");
    }
    rebound.planHash = storedSecond.planHash;
    const recovered = await workspacePUT(
      putRequest(
        path,
        v2Body(accepted.basics, { planId: secondPlanId, planHash: storedSecond.planHash, draft: rebound }),
        buildWorkspaceETag(accepted.basics.jobId, 1),
      ),
      routeParams(accepted.basics.jobId),
    );
    expect(recovered.status).toBe(200);
  });

  it("unknown suggestion ops fail 422 with a draft field path", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const draft = v2Draft(accepted, [
      { op: "add", operationId: "55555555-5555-4555-8555-555555555555", suggestionId: "sug-999", roleId: accepted.roleId, editedText: null },
    ]);
    const response = await workspacePUT(
      putRequest(
        path,
        v2Body(accepted.basics, { planId: accepted.planId, planHash: accepted.planHash, draft }),
        buildWorkspaceETag(accepted.basics.jobId, 0),
      ),
      routeParams(accepted.basics.jobId),
    );
    expect(response.status).toBe(422);
    const error = errorOf(await readJson(response));
    expect(error["code"]).toBe("INVALID_SELECTION");
    expect(error["field"]).toBe("draft.operations[0].suggestionId");
  });

  it("v1 and v2 saves replace the stored bytes wholesale", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const v1Body = {
      schemaVersion: "tailoring-workspace/v1",
      extractionId: null,
      profileId: null,
      profileVersionId: null,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      recommendationHash: null,
      focus: v13Focus(),
    };
    const first = await workspacePUT(
      putRequest(path, v1Body, buildWorkspaceETag(accepted.basics.jobId, 0)),
      routeParams(accepted.basics.jobId),
    );
    expect(first.status).toBe(201);
    const readV1 = await workspaceGET(getRequest(path), routeParams(accepted.basics.jobId));
    const draftV1 = (((await readJson(readV1))["workspace"] ?? {}) as Record<string, unknown>)["draft"] as Record<string, unknown>;
    expect(draftV1["schemaVersion"]).toBe("tailoring-workspace/v1");

    const second = await workspacePUT(
      putRequest(path, v2Body(accepted.basics), buildWorkspaceETag(accepted.basics.jobId, 1)),
      routeParams(accepted.basics.jobId),
    );
    expect(second.status).toBe(200);
    const readV2 = await workspaceGET(getRequest(path), routeParams(accepted.basics.jobId));
    const draftV2 = (((await readJson(readV2))["workspace"] ?? {}) as Record<string, unknown>)["draft"] as Record<string, unknown>;
    expect(draftV2["schemaVersion"]).toBe("tailoring-workspace/v2");

    const third = await workspacePUT(
      putRequest(path, v1Body, buildWorkspaceETag(accepted.basics.jobId, 2)),
      routeParams(accepted.basics.jobId),
    );
    expect(third.status).toBe(200);
    const readV1Again = await workspaceGET(getRequest(path), routeParams(accepted.basics.jobId));
    const draftV1Again = (((await readJson(readV1Again))["workspace"] ?? {}) as Record<string, unknown>)["draft"] as Record<string, unknown>;
    expect(draftV1Again["schemaVersion"]).toBe("tailoring-workspace/v1");
  });

  it("unknown workspace schema versions are rejected before any write", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const response = await workspacePUT(
      putRequest(
        path,
        { ...v2Body(accepted.basics), schemaVersion: "tailoring-workspace/v9" },
        buildWorkspaceETag(accepted.basics.jobId, 0),
      ),
      routeParams(accepted.basics.jobId),
    );
    expect(response.status).toBe(400);
    expect(errorOf(await readJson(response))["code"]).toBe("INVALID_REQUEST");
    const read = await workspaceGET(getRequest(path), routeParams(accepted.basics.jobId));
    expect(((await readJson(read))["workspace"] ?? null)).toBeNull();
  });

  it("v2 saves honor the revision CAS", async () => {
    const accepted = await seedAccepted();
    const path = `/api/jobs/${accepted.basics.jobId}/tailoring/workspace`;
    const created = await workspacePUT(
      putRequest(path, v2Body(accepted.basics), buildWorkspaceETag(accepted.basics.jobId, 0)),
      routeParams(accepted.basics.jobId),
    );
    expect(created.status).toBe(201);
    const conflicted = await workspacePUT(
      putRequest(path, v2Body(accepted.basics), buildWorkspaceETag(accepted.basics.jobId, 0)),
      routeParams(accepted.basics.jobId),
    );
    expect(conflicted.status).toBe(412);
    const error = errorOf(await readJson(conflicted));
    expect(error["code"]).toBe("WORKSPACE_CONFLICT");
    expect(error["currentWorkspaceRevision"]).toBe(1);
  });
});

interface ServiceAccepted {
  basics: V13Basics;
  world: CrossProfileWorld;
  planId: string;
  planHash: string;
  suggestionId: string;
  roleId: string;
}

/** Seed a world and run a real PREPARE cycle inside a service database. */
async function seedServiceAccepted(
  t: TestDatabase,
  world: CrossProfileWorld,
  now?: string,
): Promise<ServiceAccepted> {
  // Direct v1 seed (see seedAccepted): the handler emits v2
  // now, so the preserved W-v2-over-v1 path is seeded directly.
  const seed = seedV1Accepted(t.handle, world, S2B_JD, now ?? S2B_T0);
  const usable = seed.plan.suggestions.find((suggestion) => suggestion.usable);
  if (usable === undefined) {
    throw new Error("S2-C setup produced no usable suggestion");
  }
  return {
    basics: seed.basics,
    world,
    planId: seed.planRowId,
    planHash: seed.planHash,
    suggestionId: usable.suggestionId,
    roleId: usable.roleId,
  };
}

function saveV2(
  handle: DatabaseHandle,
  accepted: ServiceAccepted,
  body: WorkspacePutV2,
  observedRevision: number,
): ReturnType<typeof saveWorkspaceV2> {
  return saveWorkspaceV2(handle, accepted.basics.jobId, observedRevision, body, {
    recommendations: stubRecommendationsProvider(null),
    now: () => S2B_T0,
  });
}

describe("S2C workspace v2 semantics", () => {
  it("collapses repeated adds and excludes, preserving survivor order", async () => {
    await withS2bDatabase(async (t, world) => {
      const accepted = await seedServiceAccepted(t, world);
      const first = newId();
      const second = newId();
      const saved = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
            { op: "add", operationId: first, suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: null },
            { op: "add", operationId: second, suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: "late duplicate" },
            { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
          ]),
        }),
        0,
      );
      if (!saved.ok) {
        throw new Error(`S2-C collapse save failed: ${saved.failure.error} ${saved.failure.detail}`);
      }
      const draft = saved.value.workspace;
      if (draft === null || draft.draft.schemaVersion !== "tailoring-workspace/v2") {
        throw new Error("S2-C collapse save returned no v2 draft");
      }
      const operations = draft.draft.draft?.operations ?? [];
      expect(operations.map((op) => op.operationId)).toEqual([
        operations[0]?.operationId,
        first,
      ]);
      expect(operations.map((op) => op.op)).toEqual(["exclude", "add"]);
    });
  });

  it("unusable suggestions cannot enter a draft", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const snapshots = s2bSnapshotIds(t.handle, basics, S2B_JD);
      const proposal = proposalForS2b({
        jdText: canonicalText(S2B_JD),
        jdSnapshotId: snapshots.jdSnapshotId,
        candidateSnapshotId: snapshots.candidateSnapshotId,
        quotes: [
          { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
        ],
        suggestions: [
          { roleId: "emp-harbor", text: "Supported Harbor work.", factIds: ["pm-fact-discovery"] },
          { roleId: "emp-harbor", text: "Evidence-free filler.", factIds: ["no-such-fact"] },
        ],
      });
      const scheduled = scheduleS2b(t.handle, basics, { profileId: world.pmProfileId });
      const claimed = claimS2b(t.handle);
      // Direct v1 accept over the custom proposal: the handler
      // rejects v1 proposals now, so the evidence-free suggestion
      // case is seeded with the pure v1 builder.
      const evidence = pmEvidenceFor(t.handle, world);
      const v1 = acceptV1Plan(t.handle, {
        basics,
        preparationId: scheduled.preparationId,
        attemptId: claimed.attemptId,
        profileVersionId: world.pmVersionId,
        payload: evidence.payload,
        proposal,
        jdText: S2B_JD,
        now: S2B_T0,
      });
      finishS2bAttempt(t.handle, {
        ...claimed,
        outcome: { result: "SUCCEEDED", terminal: true, outputHash: v1.planHash },
      });
      const stored = readPlan(t.handle, v1.planRowId);
      if (stored === null) {
        throw new Error("S2-C setup produced no accepted plan");
      }
      const accepted: ServiceAccepted = {
        basics,
        world,
        planId: stored.id,
        planHash: stored.planHash,
        suggestionId: "sug-001",
        roleId: "emp-harbor",
      };
      const rejected = saveV2(
        t.handle,
        accepted,
        v2Body(basics, {
          planId: stored.id,
          planHash: stored.planHash,
          draft: v2Draft(accepted, [
            { op: "add", operationId: newId(), suggestionId: "sug-002", roleId: "emp-harbor", editedText: null },
          ]),
        }),
        0,
      );
      if (rejected.ok) {
        throw new Error("S2-C accepted an unusable suggestion");
      }
      expect(rejected.failure.error).toBe("invalid-selection");
      expect(rejected.failure.field).toBe("draft.operations[0].suggestionId");
      expect(rejected.failure.detail).toContain("NO_EVIDENCE");
    });
  });

  it("foreign roles and unknown facts are refused with field paths", async () => {
    await withS2bDatabase(async (t, world) => {
      const accepted = await seedServiceAccepted(t, world);
      const foreignRole = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "add", operationId: newId(), suggestionId: accepted.suggestionId, roleId: "emp-elsewhere", editedText: null },
          ]),
        }),
        0,
      );
      if (foreignRole.ok) {
        throw new Error("S2-C accepted a foreign role");
      }
      expect(foreignRole.failure.error).toBe("invalid-selection");
      expect(foreignRole.failure.field).toBe("draft.operations[0].roleId");

      const unknownFact = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "exclude", operationId: newId(), targetFactId: "no-such-fact" },
          ]),
        }),
        0,
      );
      if (unknownFact.ok) {
        throw new Error("S2-C accepted an unknown fact");
      }
      expect(unknownFact.failure.error).toBe("invalid-selection");
      expect(unknownFact.failure.field).toBe("draft.operations[0].targetFactId");
    });
  });

  it("suggestion edits require an added instance", async () => {
    await withS2bDatabase(async (t, world) => {
      const accepted = await seedServiceAccepted(t, world);
      const lonely = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "edit", operationId: newId(), target: { kind: "suggestion", suggestionId: accepted.suggestionId }, text: "Orphan edit." },
          ]),
        }),
        0,
      );
      if (lonely.ok) {
        throw new Error("S2-C accepted an edit without an added instance");
      }
      expect(lonely.failure.error).toBe("invalid-selection");
      expect(lonely.failure.field).toBe("draft.operations[0].target.suggestionId");

      const paired = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "add", operationId: newId(), suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: null },
            { op: "edit", operationId: newId(), target: { kind: "suggestion", suggestionId: accepted.suggestionId }, text: "Paired edit." },
          ]),
        }),
        0,
      );
      expect(paired.ok).toBe(true);
    });
  });

  it("draft/header plan binding mismatches are refused", async () => {
    await withS2bDatabase(async (t, world) => {
      const accepted = await seedServiceAccepted(t, world);
      const draft = v2Draft(accepted, []);
      draft.planId = newId();
      const mismatched = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, { planId: accepted.planId, planHash: accepted.planHash, draft }),
        0,
      );
      if (mismatched.ok) {
        throw new Error("S2-C accepted a draft/header binding mismatch");
      }
      expect(mismatched.failure.error).toBe("invalid-selection");
      expect(mismatched.failure.field).toBe("draft.planId");
    });
  });

  it("captured non-active versions stay saveable; evidence drift does not", async () => {
    await withS2bDatabase(async (t, world) => {
      const accepted = await seedServiceAccepted(t, world);
      const document = JSON.parse(
        readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
      ) as unknown;
      const imported = importCandidate(t.handle, {
        document,
        actor: "human",
        profileId: world.pmProfileId,
      });
      if (!imported.ok) {
        throw new Error(`S2-C second import failed: ${imported.error}`);
      }
      const activated = activateProfileVersion(t.handle, {
        versionId: imported.versionId,
        actor: "human",
      });
      if (!activated.ok) {
        throw new Error(`S2-C activation failed: ${activated.error}`);
      }
      // The captured version is no longer active, yet the v2 save binds it.
      const saved = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "add", operationId: newId(), suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: null },
          ]),
        }),
        0,
      );
      expect(saved.ok).toBe(true);
    });
  });

  it("v2 saves touch only the workspace row; master and plan bytes are unchanged", async () => {
    await withS2bDatabase(async (t, world) => {
      const accepted = await seedServiceAccepted(t, world);
      const counts = (): Record<string, number> => {
        const row = t.handle.sqlite
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM candidate_profile_versions) AS versions,
              (SELECT COUNT(*) FROM candidate_facts) AS facts,
              (SELECT COUNT(*) FROM step2_plans) AS plans,
              (SELECT COUNT(*) FROM step2_preparations) AS preparations,
              (SELECT COUNT(*) FROM step2_draft_validations) AS validations`,
          )
          .get() as Record<string, number>;
        return row;
      };
      const before = counts();
      const saved = saveV2(
        t.handle,
        accepted,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          draft: v2Draft(accepted, [
            { op: "add", operationId: newId(), suggestionId: accepted.suggestionId, roleId: accepted.roleId, editedText: null },
            { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
          ], "Edited summary."),
        }),
        0,
      );
      expect(saved.ok).toBe(true);
      expect(counts()).toEqual(before);
    });
  });

  it("recommendation hashes verify when present; v2 submission routes to the edited-plan freeze", async () => {
    await withS2bDatabase(async (t, world) => {
      // Future clock: profile versions seed at real-now, so the plan
      // must be accepted after them for the S2-D chronology rule.
      const now = new Date(Date.now() + 3_600_000).toISOString();
      const accepted = await seedServiceAccepted(t, world, now);
      const recs = v13Recommendations(accepted.basics);
      const provider = stubRecommendationsProvider(recs);
      const hashed = saveWorkspaceV2(
        t.handle,
        accepted.basics.jobId,
        0,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          recommendationHash: hashRecommendation(recs),
          draft: v2Draft(accepted, []),
        }),
        { recommendations: provider, now: () => S2B_T0 },
      );
      if (!hashed.ok) {
        throw new Error(`S2-C hashed save failed: ${hashed.failure.error} ${hashed.failure.detail}`);
      }
      expect(provider.calls).toBe(1);
      const view = getWorkspaceView(t.handle, accepted.basics.jobId);
      if (!view.ok || view.value.workspace === null) {
        throw new Error("S2-C hashed save is not readable");
      }
      expect(view.value.workspace.recommendations).not.toBeNull();

      const wrong = saveWorkspaceV2(
        t.handle,
        accepted.basics.jobId,
        1,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          recommendationHash: "0".repeat(64),
          draft: v2Draft(accepted, []),
        }),
        { recommendations: provider, now: () => S2B_T0 },
      );
      if (wrong.ok) {
        throw new Error("S2-C accepted a wrong recommendation hash");
      }
      expect(wrong.failure.error).toBe("input-stale");

      // S2-D evolution: v2 rows no longer fail closed. Save a
      // generatable draft (one add, unlinked master bullets excluded,
      // plan summary kept), then submit through the G-v2 edited-plan
      // freeze path. The submit clock runs past real-now because the
      // world seeds profile versions at real-now.
      const planRow = readPlan(t.handle, accepted.planId);
      if (planRow === null) {
        throw new Error("S2-D setup lost the accepted plan");
      }
      const keepMasterSummary = (
        JSON.parse(planRow.planJson) as {
          positioning: { keepMasterSummary: string };
        }
      ).positioning.keepMasterSummary;
      const generatable = saveWorkspaceV2(
        t.handle,
        accepted.basics.jobId,
        1,
        v2Body(accepted.basics, {
          planId: accepted.planId,
          planHash: accepted.planHash,
          recommendationHash: hashRecommendation(recs),
          draft: v2Draft(
            accepted,
            [
              {
                op: "add",
                operationId: newId(),
                suggestionId: accepted.suggestionId,
                roleId: accepted.roleId,
                editedText: null,
              },
              { op: "exclude", operationId: newId(), targetFactId: "pm-fact-discovery" },
              { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
              { op: "exclude", operationId: newId(), targetFactId: "pm-fact-cadence" },
            ],
            keepMasterSummary,
            "master",
          ),
        }),
        { recommendations: provider, now: () => S2B_T0 },
      );
      if (!generatable.ok) {
        throw new Error(
          `S2-D generatable save failed: ${generatable.failure.error} ${generatable.failure.detail}`,
        );
      }
      const live = getTailoringJob(t.handle, accepted.basics.jobId);
      if (live === null) {
        throw new Error("S2-D submit lost the job row");
      }
      const requestId = newId();
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: accepted.basics.jobId,
          requestId,
          workspaceRevision: generatable.value.revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now,
        },
        { env: { ...S2B_KEYED_ENV } },
      );
      if (!submitted.ok) {
        throw new Error(
          `S2-D v2 submission failed: ${submitted.failure.error} ${submitted.failure.detail}`,
        );
      }
      expect(submitted.status).toBe("QUEUED");
      expect(submitted.replayed).toBe(false);
      const frozen = readStep2GenerationInputs(t.handle, requestId);
      if (frozen === null) {
        throw new Error("S2-D v2 submission froze no edited-plan inputs");
      }
      expect(frozen.planId).toBe(accepted.planId);
      expect(frozen.planHash).toBe(accepted.planHash);
    });
  });
});
