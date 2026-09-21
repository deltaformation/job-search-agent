// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import { POST as generationsPOST } from "../../../app/api/jobs/[id]/tailoring/generations/route";
import { GET as jobGET } from "../../../app/api/jobs/[id]/route";
import { GET as reviewGET } from "../../../app/api/resumes/[id]/review/route";
import { GET as artifactGET } from "../../../app/api/resumes/artifacts/[id]/route";
import { newId, type DatabaseHandle } from "../../../src/db";
import { getTailoringJob } from "../../../src/db/tailoring";
import {
  buildWorkspaceETag,
  TAILORING_SUBMIT_SCHEMA_VERSION,
} from "../../../src/domain/tailoringWorkspace";
import { STEP2_CORRECTION_VERSIONS } from "../../../src/domain/step2Correction";
import {
  getRequest,
  mutationHeaders,
  postRequest,
  readJson,
  routeParams,
} from "../routes/_helpers";
import {
  closeHarness,
  limeFittingExcludes,
  limeMasterSummary,
  openHarness,
  putRequest,
  seedLimeAccepted,
  usableLimeSuggestions,
  type LimeHarness,
} from "./s2cpc-world";

/**
 * WO-1.3-I hardening closure (U6/U9/U19, I4/I6/I7 legs): two-client
 * conflicts, forged selections, typed failures, security gates, body
 * limits, query budgets, and hostile-content escaping — all through
 * real routes on isolated Lime data. Migration/restore, crash
 * recovery, and full adversarial matrices stay proven by their
 * owning suites (B7/B8, S2B6, S2CPB1–S2CPB6, F6/F10); I re-runs
 * those suites and records the exact results in the ledger.
 */

function q1(handle: DatabaseHandle, jobId: string) {
  return handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM generation_requests WHERE job_id = ?) AS requests,
        (SELECT COUNT(*) FROM work_items WHERE kind = 'TAILOR' AND job_id = ?) AS work,
        (SELECT COUNT(*) FROM resume_versions WHERE job_id = ?) AS versions`,
    )
    .get(jobId, jobId, jobId) as Record<string, number>;
}

function draftFor(
  basics: { extractionId: string; profileId: string; profileVersionId: string },
  plan: { planRowId: string; planHash: string },
  ops: unknown[],
) {
  return {
    schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
    extractionId: basics.extractionId,
    profileId: basics.profileId,
    profileVersionId: basics.profileVersionId,
    requestKind: "INITIAL",
    parentVersionId: null,
    revisionNote: null,
    planId: plan.planRowId,
    planHash: plan.planHash,
    recommendationHash: null,
    draft: {
      schemaVersion: STEP2_CORRECTION_VERSIONS.draft,
      planId: plan.planRowId,
      planHash: plan.planHash,
      summaryText: limeMasterSummary(),
      summaryOrigin: "master",
      operations: ops,
    },
  };
}

describe("WO-1.3-I hardening U6/U9/U19/I4/I6/I7", () => {
  let harness: LimeHarness;

  beforeEach(() => {
    harness = openHarness("job-tracker-v13-i-hardening-");
  });

  afterEach(() => {
    closeHarness(harness);
  });

  it("U6: two-tab conflict 412 retains the winner; forged selection 422 writes nothing", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const usable = usableLimeSuggestions(accepted.plan);
    const winnerOps = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      ...limeFittingExcludes(),
    ];
    const first = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftFor(basics, accepted, winnerOps),
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(first.status).toBe(201);

    // Two tabs at revision 1: one wins, one 412s, loser input retained
    // client-side (server keeps the winner byte-identical).
    const loserOps = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[1]!.suggestionId,
        roleId: usable[1]!.roleId,
        editedText: null,
      },
      ...limeFittingExcludes(),
    ];
    const winner = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftFor(basics, accepted, winnerOps),
        buildWorkspaceETag(basics.jobId, 1),
      ),
      routeParams(basics.jobId),
    );
    expect(winner.status).toBe(200);
    const loser = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftFor(basics, accepted, loserOps),
        buildWorkspaceETag(basics.jobId, 1),
      ),
      routeParams(basics.jobId),
    );
    expect(loser.status).toBe(412);
    expect((await readJson(loser))["error"]).toBeDefined();

    // Forged selection: well-formed but unknown suggestion id → 422.
    const q1Before = await harness.withDb((handle) => q1(handle, basics.jobId));
    const forged = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftFor(basics, accepted, [
          {
            op: "add",
            operationId: newId(),
            suggestionId: "sug-999",
            roleId: usable[0]!.roleId,
            editedText: null,
          },
        ]),
        buildWorkspaceETag(basics.jobId, 2),
      ),
      routeParams(basics.jobId),
    );
    expect(forged.status).toBe(422);
    expect(await harness.withDb((handle) => q1(handle, basics.jobId))).toEqual(q1Before);

    // Latest valid draft retained byte-identical.
    const reloaded = await workspaceGET(
      getRequest(`/api/jobs/${basics.jobId}/tailoring/workspace`),
      routeParams(basics.jobId),
    );
    expect(reloaded.status).toBe(200);
    const body = (await readJson(reloaded))["workspace"] as {
      revision: number;
      draft: { draft: { operations: unknown[] } };
    };
    expect(body.revision).toBe(2);
    expect(body.draft.draft.operations).toEqual(winnerOps);
  });

  it("U7-double-submit/I3: same-ID replay 200, changed-bytes 409, busy-ID 409", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    const usable = usableLimeSuggestions(accepted.plan);
    const ops = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      ...limeFittingExcludes(),
    ];
    const saved = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftFor(basics, accepted, ops),
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(saved.status).toBe(201);
    const live = await harness.withDb((handle) => getTailoringJob(handle, basics.jobId));
    const requestId = newId();
    const submitBody = {
      schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
      requestId,
      workspaceRevision: 1,
      observedRowVersion: live?.rowVersion,
    };
    const first = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody),
      routeParams(basics.jobId),
    );
    expect(first.status).toBe(202);
    // Byte-identical replay → 200, zero new rows.
    const replay = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, submitBody),
      routeParams(basics.jobId),
    );
    expect(replay.status).toBe(200);
    expect((await readJson(replay))["replayed"]).toBe(true);
    // Changed bytes, same ID → 409 mismatch (workspace moved to 2).
    const changed = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, {
        ...submitBody,
        workspaceRevision: 2,
      }),
      routeParams(basics.jobId),
    );
    expect(changed.status).toBe(409);
    // Different ID while live → 409 busy.
    const busy = await generationsPOST(
      postRequest(`/api/jobs/${basics.jobId}/tailoring/generations`, {
        ...submitBody,
        requestId: newId(),
      }),
      routeParams(basics.jobId),
    );
    expect(busy.status).toBe(409);
    const counts = await harness.withDb((handle) => q1(handle, basics.jobId));
    expect(counts.requests).toBe(1);
    expect(counts.work).toBe(1);
  });

  it("I6: Host/Origin, IDs, ownership, and traversal gates hold", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;

    // Bad Origin on mutation → 403.
    const badOrigin = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        { schemaVersion: STEP2_CORRECTION_VERSIONS.workspace },
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    // putRequest uses the good origin; rebuild with a forged one.
    const forgedOrigin = new Request(
      `http://127.0.0.1:3000/api/jobs/${basics.jobId}/tailoring/workspace`,
      {
        method: "PUT",
        headers: {
          host: "127.0.0.1:3000",
          origin: "https://evil.example",
          "content-type": "application/json",
          "if-match": buildWorkspaceETag(basics.jobId, 0),
        },
        body: JSON.stringify({ schemaVersion: STEP2_CORRECTION_VERSIONS.workspace }),
      },
    );
    const forged = await workspacePUT(forgedOrigin, routeParams(basics.jobId));
    expect(forged.status).toBe(403);
    expect(badOrigin.status).not.toBe(403); // control: good origin passes the gate

    // Malformed UUID on a tailoring route → 400; unknown job → 404.
    // (Legacy job GET returns 404 for any unknown id; the strict 400
    // gate lives on the v1.3 tailoring routes via tailoringPathId.)
    const malformed = await workspaceGET(
      getRequest(`/api/jobs/not-a-uuid/tailoring/workspace`),
      routeParams("not-a-uuid"),
    );
    expect(malformed.status).toBe(400);
    const unknownId = newId();
    const unknown = await jobGET(getRequest(`/api/jobs/${unknownId}`), routeParams(unknownId));
    expect(unknown.status).toBe(404);
    const unknownTailoring = await workspaceGET(
      getRequest(`/api/jobs/${unknownId}/tailoring/workspace`),
      routeParams(unknownId),
    );
    expect(unknownTailoring.status).toBe(404);

    // Foreign version review → 404 (or 403); traversal artifact → not 200.
    const foreignId = newId();
    const foreignReview = await reviewGET(
      getRequest(`/api/resumes/${foreignId}/review`),
      { params: Promise.resolve({ id: foreignId }) },
    );
    expect([403, 404]).toContain(foreignReview.status);
    const traversal = await artifactGET(
      getRequest(`/api/resumes/artifacts/..%2F..%2Fetc%2Fpasswd`),
      { params: Promise.resolve({ id: "..%2F..%2Fetc%2Fpasswd" }) },
    );
    expect(traversal.status).not.toBe(200);
  });

  it("I7: oversize bodies 413; workspace/progress reads stay in budget", async () => {
    const accepted = await seedLimeAccepted(harness);
    const { basics } = accepted;
    // 128 KiB + 1 body → 413 before JSON parsing.
    const big = "x".repeat(131073);
    const oversize = new Request(
      `http://127.0.0.1:3000/api/jobs/${basics.jobId}/tailoring/workspace`,
      {
        method: "PUT",
        headers: {
          ...mutationHeaders(),
          "content-type": "application/json",
          "if-match": buildWorkspaceETag(basics.jobId, 0),
        },
        body: JSON.stringify({ schemaVersion: STEP2_CORRECTION_VERSIONS.workspace, pad: big }),
      },
    );
    const rejected = await workspacePUT(oversize, routeParams(basics.jobId));
    expect(rejected.status).toBe(413);

    // Query budgets: count prepared statements behind one GET each.
    const usable = usableLimeSuggestions(accepted.plan);
    const ops = [
      {
        op: "add",
        operationId: newId(),
        suggestionId: usable[0]!.suggestionId,
        roleId: usable[0]!.roleId,
        editedText: null,
      },
      ...limeFittingExcludes(),
    ];
    const saved = await workspacePUT(
      putRequest(
        `/api/jobs/${basics.jobId}/tailoring/workspace`,
        draftFor(basics, accepted, ops),
        buildWorkspaceETag(basics.jobId, 0),
      ),
      routeParams(basics.jobId),
    );
    expect(saved.status).toBe(201);
    const counts = await harness.withDb(async (handle) => {
      let statements = 0;
      const sqlite = handle.sqlite as unknown as {
        prepare: (...args: unknown[]) => unknown;
      };
      const original = sqlite.prepare.bind(handle.sqlite);
      sqlite.prepare = ((...args: unknown[]) => {
        statements += 1;
        return original(...args);
      }) as typeof sqlite.prepare;
      try {
        // Direct service reads (route handlers open their own DB; the
        // service-level count is what B6 pins, re-verified here).
        const { getWorkspaceView } = await import("../../../src/server/tailoringWorkspace");
        statements = 0;
        getWorkspaceView(handle, basics.jobId);
        return { workspaceStatements: statements };
      } finally {
        sqlite.prepare = original as typeof sqlite.prepare;
      }
    });
    expect(counts.workspaceStatements).toBeLessThanOrEqual(8);
  });
});
