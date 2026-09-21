// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { POST as approvePOST } from "../../../app/api/jobs/[id]/resume/approve/route";
import { POST as declinePOST } from "../../../app/api/jobs/[id]/resume/decline/route";
import {
  applications,
  generationRequests,
  jobs,
  newId,
  openDatabase,
  resumeArtifacts,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  jobExtractions,
  step2Plans,
  step2Preparations,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { getTailoringJob } from "../../../src/db/tailoring";
import { buildWorkflowReview } from "../../../src/server/workflowReview";
import { getResumeReviewView, requestRevision } from "../../../src/server/review";
import {
  getWorkspaceView,
  saveWorkspaceV3,
} from "../../../src/server/tailoringWorkspace";
import { stubRecommendationsProvider } from "../db/v13world";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  V13_T0,
  withV13Database,
  type V13Basics,
  type V13Run,
} from "../db/v13world";
import {
  postRequest,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import { seedGEditedPlan } from "./g-world";

/**
 * WO-1.3-G acceptance: G9 (cancel-safe views, approve/replay/integrity
 * matrix), G10 (post-NEW application retention), G11 (decline notes,
 * revision atomicity + child lineage, v2 editor round-trip), G12
 * (older-version eligibility, stale inputs, decided-version refusal,
 * byte preservation). Route legs run against an isolated data root.
 */

let isolated: IsolatedRoot | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  isolated?.restoreEnv();
  isolated?.cleanup();
  isolated = null;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function settleRun(handle: DatabaseHandle, run: V13Run): void {
  handle.db
    .update(generationRequests)
    .set({ status: "SUCCEEDED", updatedAt: V13_T0 })
    .where(eq(generationRequests.id, run.requestId))
    .run();
  handle.db
    .update(workItems)
    .set({ state: "SUCCEEDED", leaseToken: null })
    .where(eq(workItems.id, run.workItemId))
    .run();
}

function readyJob(handle: DatabaseHandle, jobId: string, activeVersionId: string): void {
  handle.db
    .update(jobs)
    .set({ tailoringState: "AWAITING_REVIEW", activeResumeVersionId: activeVersionId })
    .where(eq(jobs.id, jobId))
    .run();
}

function stageArtifacts(
  handle: DatabaseHandle,
  artifactsDir: string,
  versionId: string,
  tag: string,
): Record<string, string> {
  const digests: Record<string, string> = {};
  const kinds = [
    ["MARKDOWN", "resume.md", "text/markdown", `# Resume ${tag}\n`],
    ["DOCX", "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `docx-bytes-${tag}`],
    ["PDF", "resume.pdf", "application/pdf", `%PDF-1.4 ${tag}\n`],
  ] as const;
  for (const [kind, file, mediaType, body] of kinds) {
    const relativePath = `versions/${versionId}/${file}`;
    mkdirSync(join(artifactsDir, `versions/${versionId}`), { recursive: true });
    writeFileSync(join(artifactsDir, relativePath), body, "utf8");
    const bytes = readFileSync(join(artifactsDir, relativePath));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    handle.db
      .insert(resumeArtifacts)
      .values({
        id: newId(),
        resumeVersionId: versionId,
        kind,
        relativePath,
        mediaType,
        byteSize: bytes.byteLength,
        sha256,
      })
      .run();
    digests[kind] = sha256;
  }
  return digests;
}

interface DecisionWorld {
  basics: V13Basics;
  run: V13Run;
  versionId: string;
  contentJson: string;
}

function seedDecisionWorld(): DecisionWorld {
  isolated = setupIsolatedRoot("g-decisions-");
  const artifactsDir = join(isolated.root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
  try {
    const world = seedCrossProfileWorld({ handle } as TestDatabase);
    const basics = seedV13Basics(handle, world);
    const run = seedV13RunningRun(handle, basics);
    seedV13RequestInputs(handle, basics, run);
    const version = seedV13Version(handle, basics, run);
    settleRun(handle, run);
    readyJob(handle, basics.jobId, version.versionId);
    stageArtifacts(handle, artifactsDir, version.versionId, "v1");
    const row = handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, version.versionId))
      .get();
    return { basics, run, versionId: version.versionId, contentJson: row?.contentJson ?? "" };
  } finally {
    handle.close();
  }
}

function openIsolated(): DatabaseHandle {
  return openDatabase({ path: join((isolated as IsolatedRoot).root, "job-tracker.sqlite") });
}



function counts(handle: DatabaseHandle, jobId: string) {
  const job = getTailoringJob(handle, jobId);
  const reviews = handle.db.select().from(resumeReviews).all();
  const work = handle.db.select().from(workItems).all();
  return { rowVersion: job?.rowVersion ?? -1, reviews: reviews.length, work: work.length };
}

describe("G9 decision matrix", () => {
  it("reads and cancelled dialogs write nothing", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      const before = counts(t.handle, basics.jobId);
      // Review reads (what a dialog open/cancel performs): all GETs.
      const view = getResumeReviewView(t.handle, version.versionId);
      expect(view).not.toBeNull();
      const versionRow = t.handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, version.versionId))
        .get();
      const job = getTailoringJob(t.handle, basics.jobId);
      if (versionRow !== undefined && job !== null) {
        buildWorkflowReview(t.handle, { version: versionRow, job, gapKeys: [] });
      }
      expect(counts(t.handle, basics.jobId)).toEqual(before);
    });
  });

  it("approves once; a replayed approval conflicts with no second review", async () => {
    const w = seedDecisionWorld();
    const body = { resumeVersionId: w.versionId, observedRowVersion: 1 };
    const first = await approvePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, body),
      routeParams(w.basics.jobId),
    );
    expect(first.status).toBe(200);
    const replay = await approvePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, body),
      routeParams(w.basics.jobId),
    );
    expect(replay.status).toBe(409);
    const handle = openIsolated();
    try {
      const reviews = handle.db.select().from(resumeReviews).all();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        resumeVersionId: w.versionId,
        action: "APPROVED",
        actor: "human",
      });
      expect(getTailoringJob(handle, w.basics.jobId)?.status).toBe("TAILORED");
    } finally {
      handle.close();
    }
  });

  it("artifact mismatch fails 500 with no pointer or state change", async () => {
    const w = seedDecisionWorld();
    const root = (isolated as IsolatedRoot).root;
    const handle = openIsolated();
    try {
      const pdf = handle.db
        .select()
        .from(resumeArtifacts)
        .where(eq(resumeArtifacts.resumeVersionId, w.versionId))
        .all()
        .find((row) => row.kind === "PDF");
      const absolute = join(root, "artifacts", pdf?.relativePath as string);
      writeFileSync(absolute, Buffer.from("tampered-bytes", "utf8"));
    } finally {
      handle.close();
    }
    const response = await approvePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, {
        resumeVersionId: w.versionId,
        observedRowVersion: 1,
      }),
      routeParams(w.basics.jobId),
    );
    expect(response.status).toBe(500);
    expect(await readJson(response)).toMatchObject({ error: "artifact-mismatch" });
    const check = openIsolated();
    try {
      expect(getTailoringJob(check, w.basics.jobId)).toMatchObject({
        status: "NEW",
        rowVersion: 1,
        selectedResumeVersionId: null,
      });
      const version = check.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, w.versionId))
        .get();
      expect(version?.reviewState).toBe("AWAITING_REVIEW");
      expect(check.db.select().from(resumeReviews).all()).toHaveLength(0);
    } finally {
      check.close();
    }
  });
});

describe("G10 application retention", () => {
  for (const status of ["APPLIED", "INTERVIEWED"] as const) {
    it(`approval on ${status} retains status, application version, and applied_at`, async () => {
      const w = seedDecisionWorld();
      const appliedAt = "2026-09-17T09:00:00.000Z";
      const setup = openIsolated();
      try {
        setup.db.update(jobs).set({ status }).where(eq(jobs.id, w.basics.jobId)).run();
        setup.db
          .insert(applications)
          .values({
            id: newId(),
            jobId: w.basics.jobId,
            recordedBy: "human",
            appliedAt,
            confirmationNumber: "CONF-1",
            resumeVersionId: w.versionId,
          })
          .run();
      } finally {
        setup.close();
      }
      const response = await approvePOST(
        postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, {
          resumeVersionId: w.versionId,
          observedRowVersion: 1,
        }),
        routeParams(w.basics.jobId),
      );
      expect(response.status).toBe(200);
      const check = openIsolated();
      try {
        const job = getTailoringJob(check, w.basics.jobId);
        expect(job?.status).toBe(status);
        expect(job?.selectedResumeVersionId).toBe(w.versionId);
        const application = check.db.select().from(applications).all()[0];
        expect(application).toMatchObject({
          resumeVersionId: w.versionId,
          appliedAt,
          confirmationNumber: "CONF-1",
        });
      } finally {
        check.close();
      }
    });
  }
});

describe("G11 decline and revision", () => {
  it("rejects empty decline notes with 400", async () => {
    const w = seedDecisionWorld();
    for (const note of ["", "   "]) {
      const response = await declinePOST(
        postRequest(`/api/jobs/${w.basics.jobId}/resume/decline`, {
          resumeVersionId: w.versionId,
          observedRowVersion: 1,
          note,
        }),
        routeParams(w.basics.jobId),
      );
      expect(response.status).toBe(400);
    }
    const check = openIsolated();
    try {
      expect(check.db.select().from(resumeReviews).all()).toHaveLength(0);
    } finally {
      check.close();
    }
  });

  it("valid decline records one review and queues no work", async () => {
    const w = seedDecisionWorld();
    const beforeHandle = openIsolated();
    const before = counts(beforeHandle, w.basics.jobId);
    beforeHandle.close();
    const response = await declinePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/decline`, {
        resumeVersionId: w.versionId,
        observedRowVersion: 1,
        note: "Second bullet overstates the caching work.",
      }),
      routeParams(w.basics.jobId),
    );
    expect(response.status).toBe(200);
    const check = openIsolated();
    try {
      const reviews = check.db.select().from(resumeReviews).all();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        action: "DECLINED",
        actor: "human",
        note: "Second bullet overstates the caching work.",
      });
      const after = counts(check, w.basics.jobId);
      expect(after.work).toBe(before.work);
      expect(after.rowVersion).toBe(before.rowVersion + 1);
      expect(getTailoringJob(check, w.basics.jobId)).toMatchObject({
        status: "NEW",
        tailoringState: "DECLINED",
        selectedResumeVersionId: null,
      });
    } finally {
      check.close();
    }
  });

  it("failed revision submit writes nothing; success binds the exact child", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      readyJob(t.handle, basics.jobId, version.versionId);
      const dir = mkdtempSync(join(tmpdir(), "g-revise-"));
      tempDirs.push(dir);
      stageArtifacts(t.handle, dir, version.versionId, "rev");
      // The seeded run is still live: preflight fails, nothing lands.
      const busy = requestRevision(
        t.handle,
        {
          jobId: basics.jobId,
          resumeVersionId: version.versionId,
          observedRowVersion: 1,
          actor: "human",
          profileId: basics.profileId,
          note: "Tighten the summary.",
        },
        { providerAvailable: () => true },
      );
      expect(busy).toMatchObject({ ok: false, error: "conflict" });
      expect(t.handle.db.select().from(resumeReviews).all()).toHaveLength(0);
      expect(
        t.handle.db
          .select()
          .from(resumeVersions)
          .where(eq(resumeVersions.id, version.versionId))
          .get()?.reviewState,
      ).toBe("AWAITING_REVIEW");

      settleRun(t.handle, run);
      const revised = requestRevision(
        t.handle,
        {
          jobId: basics.jobId,
          resumeVersionId: version.versionId,
          observedRowVersion: 1,
          actor: "human",
          profileId: basics.profileId,
          note: "Tighten the summary.",
        },
        { providerAvailable: () => true },
      );
      expect(revised.ok).toBe(true);
      if (!revised.ok) {
        throw new Error("G revision did not queue");
      }
      const child = getGenerationRequest(t.handle, revised.requestId);
      expect(child?.parentVersionId).toBe(version.versionId);
      expect(child?.revisionNote).toBe("Tighten the summary.");
      expect(child?.requestKind).toBe("REVISION");
    });
  });

  it("v2 REVISION reopens the editor on the same plan with operations preserved", () => {
    withV13Database((t, world) => {
      const g = seedGEditedPlan(t.handle, world);
      // The frozen plan is the preparation's accepted plan.
      t.handle.db
        .update(step2Preparations)
        .set({ acceptedPlanId: g.planRowId })
        .where(eq(step2Preparations.id, g.preparationId))
        .run();
      const deps = {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null),
      };
      const saved = saveWorkspaceV3(
        t.handle,
        g.basics.jobId,
        0,
        {
          schemaVersion: "tailoring-workspace/v3",
          extractionId: g.basics.extractionId,
          profileId: g.basics.profileId,
          profileVersionId: g.basics.profileVersionId,
          requestKind: "REVISION",
          parentVersionId: g.version.versionId,
          revisionNote: "Tighten the summary.",
          planId: g.planRowId,
          planHash: g.planHash,
          recommendationHash: null,
          draft: {
            schemaVersion: "step2-draft/v2",
            planId: g.planRowId,
            planHash: g.planHash,
            summaryText: g.summaryText,
            summaryOrigin: "master",
            operations: g.operations,
          },
        },
        deps,
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) {
        throw new Error(`G revision save failed: ${saved.failure.error} ${saved.failure.detail}`);
      }
      const view = getWorkspaceView(t.handle, g.basics.jobId);
      expect(view.ok).toBe(true);
      if (!view.ok || view.value.workspace === null) {
        throw new Error("G revision workspace did not persist");
      }
      const workspace = view.value.workspace as unknown as {
        draft: {
          requestKind: string;
          parentVersionId: string;
          revisionNote: string;
          draft: { summaryText: string; operations: Array<{ operationId: string }> } | null;
        };
      };
      // Same plan, same operations — never a blank draft.
      expect(workspace.draft.requestKind).toBe("REVISION");
      expect(workspace.draft.parentVersionId).toBe(g.version.versionId);
      expect(workspace.draft.revisionNote).toBe("Tighten the summary.");
      expect(workspace.draft.draft?.summaryText).toBe(g.summaryText);
      expect(workspace.draft.draft?.operations.map((op) => op.operationId)).toEqual(
        g.operations.map((op) => op.operationId),
      );
    });
  });

  it("drifted plans rebind instead of reusing the stale draft", () => {
    withV13Database((t, world) => {
      const g = seedGEditedPlan(t.handle, world);
      const deps = {
        now: () => V13_T0,
        recommendations: stubRecommendationsProvider(null),
      };
      const revisionBody = (
        planId: string,
        planHash: string,
        draft: {
          schemaVersion: "step2-draft/v2";
          planId: string;
          planHash: string;
          summaryText: string;
          summaryOrigin: "master";
          operations: typeof g.operations;
        } | null,
      ) =>
        ({
          schemaVersion: "tailoring-workspace/v3",
          extractionId: g.basics.extractionId,
          profileId: g.basics.profileId,
          profileVersionId: g.basics.profileVersionId,
          requestKind: "REVISION",
          parentVersionId: g.version.versionId,
          revisionNote: "Note.",
          planId,
          planHash,
          recommendationHash: null,
          draft,
        }) as const;
      // A newer accepted plan supersedes the version's plan.
      const newerPlanId = newId();
      const newer = { ...g.plan, planId: newerPlanId, rationale: "Superseding plan." };
      const newerHash = sha256HexUtf8(JSON.stringify(newer));
      t.handle.db
        .insert(step2Plans)
        .values({
          id: newerPlanId,
          preparationId: g.preparationId,
          planSeq: 2,
          planJson: JSON.stringify(newer),
          planHash: newerHash,
          providerId: "test",
          model: null,
          promptVersion: "prepare-prompt/v2",
          proposalSchemaVersion: "preparation-proposal/v2",
          claimsPolicyVersion: "step2-claims/2",
          inputHash: "0".repeat(64),
          proposalHash: "1".repeat(64),
          attemptId: g.run.attemptId,
          validationJson: "{}",
        })
        .run();
      t.handle.db
        .update(step2Preparations)
        .set({ acceptedPlanId: newerPlanId })
        .where(eq(step2Preparations.id, g.preparationId))
        .run();
      // The version's own plan is now stale: same-plan reuse refuses.
      const stale = saveWorkspaceV3(
        t.handle,
        g.basics.jobId,
        0,
        revisionBody(g.planRowId, g.planHash, {
          schemaVersion: "step2-draft/v2",
          planId: g.planRowId,
          planHash: g.planHash,
          summaryText: g.summaryText,
          summaryOrigin: "master",
          operations: g.operations,
        }),
        deps,
      );
      expect(stale.ok).toBe(false);
      if (stale.ok) {
        throw new Error("stale plan unexpectedly saved");
      }
      expect(stale.failure.error).toBe("plan-stale");
      // Rebind recovery: the accepted plan with a cleared draft saves.
      const rebound = saveWorkspaceV3(
        t.handle,
        g.basics.jobId,
        0,
        revisionBody(newerPlanId, newerHash, null),
        deps,
      );
      expect(rebound.ok).toBe(true);
    });
  });
});

describe("G12 older versions and staleness", () => {
  it("an eligible older version approves with bytes and pointer preserved", async () => {
    isolated = setupIsolatedRoot("g-older-");
    const artifactsDir = join(isolated.root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
    let jobId = "";
    let v1 = "";
    let v2 = "";
    let v1Json = "";
    try {
      const world = seedCrossProfileWorld({ handle } as TestDatabase);
      const basics = seedV13Basics(handle, world);
      jobId = basics.jobId;
      const run1 = seedV13RunningRun(handle, basics);
      seedV13RequestInputs(handle, basics, run1);
      const first = seedV13Version(handle, basics, run1, { version: 1 });
      settleRun(handle, run1);
      const run2 = seedV13RunningRun(handle, basics);
      seedV13RequestInputs(handle, basics, run2);
      const second = seedV13Version(handle, basics, run2, { version: 2 });
      v1 = first.versionId;
      v2 = second.versionId;
      settleRun(handle, run2);
      readyJob(handle, basics.jobId, v2);
      stageArtifacts(handle, artifactsDir, v1, "older");
      stageArtifacts(handle, artifactsDir, v2, "latest");
      v1Json =
        handle.db.select().from(resumeVersions).where(eq(resumeVersions.id, v1)).get()
          ?.contentJson ?? "";
    } finally {
      handle.close();
    }
    const response = await approvePOST(
      postRequest(`/api/jobs/${jobId}/resume/approve`, {
        resumeVersionId: v1,
        observedRowVersion: 1,
      }),
      routeParams(jobId),
    );
    expect(response.status).toBe(200);
    const check = openIsolated();
    try {
      const job = getTailoringJob(check, jobId);
      expect(job?.status).toBe("TAILORED");
      expect(job?.selectedResumeVersionId).toBe(v1);
      // The active pointer still follows the latest publication.
      expect(job?.activeResumeVersionId).toBe(v2);
      const old = check.db.select().from(resumeVersions).where(eq(resumeVersions.id, v1)).get();
      expect(old?.reviewState).toBe("APPROVED");
      expect(old?.contentJson).toBe(v1Json);
    } finally {
      check.close();
    }
  });

  it("stale frozen inputs refuse with 409", async () => {
    const w = seedDecisionWorld();
    const setup = openIsolated();
    try {
      // The job description moved under the frozen extraction.
      const attemptId = newId();
      setup.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId: w.basics.jobId,
          canonicalUrl: `https://example.com/jobs/${w.basics.jobId}/2`,
          startedAt: V13_T0,
          finishedAt: V13_T0,
          outcome: "SUCCEEDED",
        })
        .run();
      const extractionId = newId();
      setup.db
        .insert(jobExtractions)
        .values({
          id: extractionId,
          jobId: w.basics.jobId,
          scrapeAttemptId: attemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: "{}",
        })
        .run();
      setup.db
        .update(jobs)
        .set({ activeExtractionId: extractionId })
        .where(eq(jobs.id, w.basics.jobId))
        .run();
    } finally {
      setup.close();
    }
    const response = await approvePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, {
        resumeVersionId: w.versionId,
        observedRowVersion: 1,
      }),
      routeParams(w.basics.jobId),
    );
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ error: "stale-version" });
  });

  it("decided versions refuse further decisions with 400", async () => {
    const w = seedDecisionWorld();
    const approved = await approvePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, {
        resumeVersionId: w.versionId,
        observedRowVersion: 1,
      }),
      routeParams(w.basics.jobId),
    );
    expect(approved.status).toBe(200);
    const again = await approvePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/approve`, {
        resumeVersionId: w.versionId,
        observedRowVersion: 2,
      }),
      routeParams(w.basics.jobId),
    );
    expect(again.status).toBe(400);
    const declined = await declinePOST(
      postRequest(`/api/jobs/${w.basics.jobId}/resume/decline`, {
        resumeVersionId: w.versionId,
        observedRowVersion: 2,
        note: "Changed my mind.",
      }),
      routeParams(w.basics.jobId),
    );
    expect(declined.status).toBe(400);
    const check = openIsolated();
    try {
      expect(check.db.select().from(resumeReviews).all()).toHaveLength(1);
    } finally {
      check.close();
    }
  });
});
