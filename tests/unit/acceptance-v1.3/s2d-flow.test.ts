// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST as generationsPOST } from "../../../app/api/jobs/[id]/tailoring/generations/route";
import {
  GET as workspaceGET,
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import {
  newId,
  openDatabase,
  resolveMigrationsDir,
  tailoringRequestInputs,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { readStep2GenerationInputs } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import {
  STEP2_SCHEMA_VERSIONS,
  type Step2DraftV1,
  type WorkspacePutV2,
} from "../../../src/domain/step2";
import {
  GenerationReply,
  TailoringErrorBody,
  TAILORING_SUBMIT_SCHEMA_VERSION,
  buildWorkspaceETag,
} from "../../../src/domain/tailoringWorkspace";
import { ensureDataRoot, resolveDataRoot } from "../../../src/security/data-root";
import {
  createBackupArchive,
  DATABASE_MEMBER,
  parseAndVerifyArchive,
  verifyStagedDatabase,
} from "../../../src/server/backup";
import { submitGeneration } from "../../../src/server/generations";
import { claimFRun, fHandler, makeArtifactsDir, q6 } from "./f-world";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import type { V13Basics } from "../db/v13world";
import {
  getRequest,
  mutationHeaders,
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import { s2bQ1, S2B_JD } from "./s2b-world";
import {
  finishS2dAttempt,
  readS2dArtifactTexts,
  runS2dTailor,
  s2dDraft,
  s2dSaveDraft,
  s2dSubmit,
  s2dTailorProposal,
  s2dTailorProvider,
  seedS2dAccepted,
  versionForRequest,
  withS2dDatabase,
  S2D_KEYED_ENV,
  type S2dAccepted,
} from "./s2d-world";

/**
 * WO-1.3-S2-D end-to-end flow (S2D4): the isolated route-driven
 * intake→prepare→edit→save→reload→generate path through real
 * HTTP handlers and the supervised worker, with HTTP status
 * proofs for the new gate codes, origin/ownership refusals,
 * lease/CAS/crash recovery, and backup retention of the frozen
 * generation inputs.
 */

const OP_ADD = "11111111-1111-4111-8111-111111111111";
const OP_X1 = "22222222-2222-4222-8222-222222222222";
const OP_X2 = "33333333-3333-4333-8333-333333333333";
const OP_X3 = "44444444-4444-4334-8444-444444444444";

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

function fittingOps(accepted: S2dAccepted): Step2DraftV1["operations"] {
  return [
    {
      op: "add",
      operationId: OP_ADD,
      suggestionId: accepted.usableSuggestion.suggestionId,
      roleId: accepted.usableSuggestion.roleId,
      editedText: null,
    },
    { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
    { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
    { op: "exclude", operationId: OP_X3, targetFactId: "pm-fact-cadence" },
  ];
}

describe("S2D4 route-driven edited-plan flow", () => {
  let isolated: IsolatedRoot;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    isolated = setupIsolatedRoot("job-tracker-v13-s2d-flow-");
    savedEnv = {};
    for (const [key, value] of Object.entries(S2D_KEYED_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    delete process.env["TAILOR_PROVIDER_ARGV"];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    isolated.restoreEnv();
    isolated.cleanup();
  });

  function withDb<T>(fn: (handle: DatabaseHandle) => T | Promise<T>): Promise<T> {
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    return Promise.resolve()
      .then(() => fn(handle))
      .finally(() => handle.close());
  }

  function seedAccepted(): Promise<{ accepted: S2dAccepted; world: CrossProfileWorld }> {
    return withDb(async (handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      // Real clock: the HTTP handlers under test stamp real-now,
      // so the seeded chronology must be real-now too.
      const accepted = await seedS2dAccepted(handle, world, S2B_JD, new Date().toISOString());
      return { accepted, world };
    });
  }

  function submitBody(requestId: string, workspaceRevision: number, observedRowVersion: number) {
    return {
      schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
      requestId,
      workspaceRevision,
      observedRowVersion,
    };
  }

  it("saves, reloads, submits, and executes an edited plan end to end", async () => {
    const { accepted } = await seedAccepted();
    const jobId = accepted.basics.jobId;
    const workspacePath = `/api/jobs/${jobId}/tailoring/workspace`;
    const draft = s2dDraft(
      accepted,
      fittingOps(accepted),
      accepted.plan.positioning.keepMasterSummary,
      "master",
    );
    const saved = await workspacePUT(
      putRequest(
        workspacePath,
        v2Body(accepted.basics, { planId: accepted.planRowId, planHash: accepted.planHash, draft }),
        buildWorkspaceETag(jobId, 0),
      ),
      routeParams(jobId),
    );
    expect(saved.status).toBe(201);

    const reloaded = await workspaceGET(getRequest(workspacePath), routeParams(jobId));
    expect(reloaded.status).toBe(200);
    const workspace = ((await readJson(reloaded))["workspace"] ?? {}) as Record<string, unknown>;
    expect(workspace["revision"]).toBe(1);
    const stored = ((workspace["draft"] ?? {}) as Record<string, unknown>)["draft"] as {
      summaryText: string;
      operations: Array<{ operationId: string }>;
    };
    expect(stored.summaryText).toBe(accepted.plan.positioning.keepMasterSummary);
    expect(stored.operations.map((op) => op.operationId)).toEqual([OP_ADD, OP_X1, OP_X2, OP_X3]);

    const rowVersion =
      (await withDb((handle) => getTailoringJob(handle, jobId)?.rowVersion)) ?? 0;
    const requestId = newId();
    const submitted = await generationsPOST(
      postRequest(
        `/api/jobs/${jobId}/tailoring/generations`,
        submitBody(requestId, 1, rowVersion),
      ),
      routeParams(jobId),
    );
    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("cache-control")).toBe("no-store");
    const reply = GenerationReply.parse(await readJson(submitted));
    expect(reply).toMatchObject({ requestId, status: "QUEUED", replayed: false });

    // The supervised worker executes the frozen bytes: claim, run,
    // and complete through the real lease/handler primitives.
    await withDb(async (handle) => {
      const request = getGenerationRequest(handle, requestId);
      const inputs = handle.db
        .select()
        .from(tailoringRequestInputs)
        .where(eq(tailoringRequestInputs.requestId, requestId))
        .get();
      if (request === null || inputs === undefined || request.workItemId === null) {
        throw new Error("S2-D flow lost the request rows");
      }
      const submitted = {
        requestId,
        workItemId: request.workItemId,
        jdSnapshotId: request.jdSnapshotId,
        candidateSnapshotId: inputs.candidateSnapshotId,
      };
      const proposal = s2dTailorProposal(handle, accepted, submitted);
      const artifactsDir = makeArtifactsDir();
      const { claim, outcome } = await runS2dTailor(
        handle,
        submitted,
        s2dTailorProvider(submitted, proposal, () => accepted.now),
        artifactsDir,
        { now: accepted.now },
      );
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(handle, claim, outcome, accepted.now);
      const version = versionForRequest(handle, requestId);
      const texts = await readS2dArtifactTexts(handle, artifactsDir, version.id);
      expect(texts.markdown).toContain(accepted.plan.positioning.keepMasterSummary);
      expect(texts.markdown).toContain(accepted.usableSuggestion.text);
    });
  });

  it("maps gate failures to strict 422/409 bodies with no-store", async () => {
    const { accepted } = await seedAccepted();
    const jobId = accepted.basics.jobId;
    const workspacePath = `/api/jobs/${jobId}/tailoring/workspace`;
    const bad = s2dDraft(
      accepted,
      [
        {
          op: "add",
          operationId: OP_ADD,
          suggestionId: accepted.usableSuggestion.suggestionId,
          roleId: accepted.usableSuggestion.roleId,
          editedText: `${accepted.usableSuggestion.text} Grew revenue 900% overnight.`,
        },
        { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
        { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
        { op: "exclude", operationId: OP_X3, targetFactId: "pm-fact-cadence" },
      ],
      accepted.plan.positioning.keepMasterSummary,
      "master",
    );
    const saved = await workspacePUT(
      putRequest(
        workspacePath,
        v2Body(accepted.basics, { planId: accepted.planRowId, planHash: accepted.planHash, draft: bad }),
        buildWorkspaceETag(jobId, 0),
      ),
      routeParams(jobId),
    );
    expect(saved.status).toBe(201);
    const q1Before = await withDb((handle) => s2bQ1(handle));
    const rowVersion =
      (await withDb((handle) => getTailoringJob(handle, jobId)?.rowVersion)) ?? 0;
    const blocked = await generationsPOST(
      postRequest(
        `/api/jobs/${jobId}/tailoring/generations`,
        submitBody(newId(), 1, rowVersion),
      ),
      routeParams(jobId),
    );
    expect(blocked.status).toBe(422);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    const body = TailoringErrorBody.parse(await readJson(blocked));
    expect(body.error.code).toBe("UNRESOLVED_EVIDENCE");
    expect(body.error.message).toContain("NEW_METRIC");
    await withDb((handle) => {
      expect(s2bQ1(handle)).toEqual(q1Before);
    });
  });

  it("403s cross-origin mutations and 404s unknown jobs", async () => {
    const { accepted } = await seedAccepted();
    const jobId = accepted.basics.jobId;
    const crossOrigin = await generationsPOST(
      new Request(`http://127.0.0.1:3000/api/jobs/${jobId}/tailoring/generations`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://evil.example:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify(submitBody(newId(), 1, 1)),
      }),
      routeParams(jobId),
    );
    expect(crossOrigin.status).toBe(403);
    const missing = newId();
    const unknown = await generationsPOST(
      postRequest(`/api/jobs/${missing}/tailoring/generations`, submitBody(newId(), 1, 1)),
      routeParams(missing),
    );
    expect(unknown.status).toBe(404);
  });

  it("refuses a plan that belongs to another job", async () => {
    const { first, second } = await withDb(async (handle) => {
      const world = seedCrossProfileWorld({
        handle,
        dir: isolated.root,
        dbPath: join(isolated.root, "job-tracker.sqlite"),
        cleanup: () => {},
      });
      const now = new Date().toISOString();
      return {
        first: await seedS2dAccepted(handle, world, S2B_JD, now),
        second: await seedS2dAccepted(handle, world, S2B_JD, now),
      };
    });
    const jobId = first.basics.jobId;
    const foreignPlanId = second.planRowId;
    const foreignPlanHash = second.planHash;
    const refused = await workspacePUT(
      putRequest(
        `/api/jobs/${jobId}/tailoring/workspace`,
        v2Body(first.basics, { planId: foreignPlanId, planHash: foreignPlanHash }),
        buildWorkspaceETag(jobId, 0),
      ),
      routeParams(jobId),
    );
    expect(refused.status).toBe(422);
    const body = TailoringErrorBody.parse(await readJson(refused));
    expect(body.error.code).toBe("INVALID_SELECTION");
    expect(body.error.field).toBe("planId");
  });
});

describe("S2D4 recovery, conflicts, and backup", () => {
  it("an expired lease fails the edited run with zero versions", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { revision } = s2dSaveDraft(
        handle,
        accepted,
        s2dDraft(
          accepted,
          fittingOps(accepted),
          accepted.plan.positioning.keepMasterSummary,
          "master",
        ),
        0,
      );
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
      const proposal = s2dTailorProposal(handle, accepted, submitted);
      const { context } = claimFRun(handle, submitted.workItemId, { now: accepted.now });
      handle.db
        .update(workItems)
        .set({ leaseExpiresAt: "2026-09-16T11:00:00.000Z" })
        .where(eq(workItems.id, submitted.workItemId))
        .run();
      const outcome = await fHandler({
        artifactsDir: makeArtifactsDir(),
        provider: s2dTailorProvider(submitted, proposal, () => accepted.now),
        clock: () => accepted.now,
      })(context);
      expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LEASE_LOST" });
      expect(q6(handle, submitted.requestId)).toEqual({ analyses: 0, versions: 0 });
    });
  });

  it("a crash after analysis resumes cached with edited content intact", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { revision } = s2dSaveDraft(
        handle,
        accepted,
        s2dDraft(
          accepted,
          fittingOps(accepted),
          accepted.plan.positioning.keepMasterSummary,
          "master",
        ),
        0,
      );
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
      const proposal = s2dTailorProposal(handle, accepted, submitted);
      const artifactsDir = makeArtifactsDir();
      const first = claimFRun(handle, submitted.workItemId, { now: accepted.now });
      const failed = await fHandler({
        artifactsDir,
        provider: s2dTailorProvider(submitted, proposal, () => accepted.now),
        clock: () => accepted.now,
        renderPdf: async () => {
          throw new Error("simulated renderer crash");
        },
      })(first.context);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "RENDER_FAILED" });
      finishS2dAttempt(handle, first, failed, accepted.now);
      expect(q6(handle, submitted.requestId)).toEqual({ analyses: 1, versions: 0 });

      const later = new Date(new Date(accepted.now).getTime() + 600_000).toISOString();
      const second = claimFRun(handle, submitted.workItemId, { now: later });
      const recoveryProvider = s2dTailorProvider(submitted, proposal, () => later);
      const outcome = await fHandler({
        artifactsDir,
        provider: recoveryProvider,
        clock: () => later,
      })(second.context);
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      expect(recoveryProvider.receivedInputs).toHaveLength(0);
      finishS2dAttempt(handle, second, outcome, later);
      expect(q6(handle, submitted.requestId)).toEqual({ analyses: 1, versions: 1 });
      const version = versionForRequest(handle, submitted.requestId);
      const texts = await readS2dArtifactTexts(handle, artifactsDir, version.id);
      expect(texts.markdown).toContain(accepted.plan.positioning.keepMasterSummary);
      expect(texts.markdown).toContain(accepted.usableSuggestion.text);
    });
  });

  it("stale CAS observations fail closed without writes", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { revision } = s2dSaveDraft(
        handle,
        accepted,
        s2dDraft(
          accepted,
          fittingOps(accepted),
          accepted.plan.positioning.keepMasterSummary,
          "master",
        ),
        0,
      );
      const live = getTailoringJob(handle, accepted.basics.jobId);
      if (live === null) {
        throw new Error("S2-D setup lost the job");
      }
      const q1Before = s2bQ1(handle);
      const staleRevision = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision + 5,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(staleRevision).toMatchObject({
        ok: false,
        failure: { error: "workspace-conflict" },
      });
      const staleRow = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion + 5,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(staleRow).toMatchObject({ ok: false, failure: { error: "job-conflict" } });
      expect(s2bQ1(handle)).toEqual(q1Before);
    });
  });

  it("a backup archive retains the frozen generation inputs", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { revision } = s2dSaveDraft(
        handle,
        accepted,
        s2dDraft(
          accepted,
          fittingOps(accepted),
          accepted.plan.positioning.keepMasterSummary,
          "master",
        ),
        0,
      );
      const submitted = s2dSubmit(handle, accepted, { workspaceRevision: revision, now: accepted.now });
      const frozen = readStep2GenerationInputs(handle, submitted.requestId);
      expect(frozen).not.toBeNull();

      const root = mkdtempSync(join(osTmpdir(), "job-tracker-s2d-backup-"));
      try {
        const paths = resolveDataRoot({ APP_DATA_ROOT: root });
        ensureDataRoot(paths);
        const candidateDir = join(root, "candidate");
        mkdirSync(candidateDir, { recursive: true });
        writeFileSync(join(candidateDir, "master-resume.json"), '{"v":1}');
        const archive = await createBackupArchive({
          handle,
          paths,
          candidateDir,
          stagingDir: join(root, "staging"),
          kind: "manual",
          now: new Date(accepted.now),
        });
        const verified = parseAndVerifyArchive(archive.bytes);
        const stagedPath = join(root, "staged.sqlite");
        writeFileSync(stagedPath, verified.members.get(DATABASE_MEMBER) as Buffer);
        verifyStagedDatabase(() => openDatabase({ path: stagedPath }), resolveMigrationsDir());
        const staged = openDatabase({ path: stagedPath });
        try {
          const kept = readStep2GenerationInputs(staged, submitted.requestId);
          expect(kept?.planHash).toBe(frozen?.planHash);
          expect(kept?.draftHash).toBe(frozen?.draftHash);
          expect(kept?.validationId).toBe(frozen?.validationId);
          expect(kept?.editedInputsJson).toBe(frozen?.editedInputsJson);
          expect(kept?.policyVersionsJson).toBe(frozen?.policyVersionsJson);
        } finally {
          staged.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
