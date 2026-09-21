// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  generationRequests,
  jobs,
  newId,
  resumeReviews,
  resumeVersions,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { claimNextWorkItem, completeWorkItem } from "../../../src/queue/leases";
import { getOrCreateCandidateSnapshot } from "../../../src/server/candidates";
import { approveResume, requestRevision } from "../../../src/server/review";
import { requestGeneration } from "../../../src/server/tailoring";
import { createTailorHandler } from "../../../src/tailoring/handler";
import { TestProvider } from "../../../src/tailoring/testProvider";
import {
  E2E_JD_TEXT,
  e2eProposal,
  handlerContext,
  importTestProfile,
  seedJob,
  stubRenderPdf,
} from "./support";

/**
 * D revision loop: an explicit INITIAL run attaches v1, the human
 * requests revision (REVISION_REQUESTED review + follow-up REVISION run
 * atomically), the worker attaches a v2 child even when the provider
 * returns identical content, and the human approves v2 into TAILORED.
 * Uses the scripted provider and the stub PDF renderer.
 */

const tempDirs: string[] = [];
const testDbs: TestDatabase[] = [];
const PROVIDER = { providerAvailable: () => true };

afterEach(() => {
  while (testDbs.length > 0) {
    testDbs.pop()?.cleanup();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function setup(): { t: TestDatabase; artifactsDir: string } {
  const t = createTestDatabase("tailor-revision-");
  testDbs.push(t);
  const artifactsDir = mkdtempSync(join(tmpdir(), "tailor-revision-artifacts-"));
  tempDirs.push(artifactsDir);
  return { t, artifactsDir };
}

function startRun(
  t: TestDatabase,
  input: { jobId: string; observedRowVersion: number; parentVersionId?: string; revisionNote?: string },
): { requestId: string; workItemId: string; newRowVersion: number } {
  const result = requestGeneration(
    t.handle,
    { ...input, actor: "human" },
    PROVIDER,
  );
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`run start failed: ${result.error} ${result.detail}`);
  }
  return { requestId: result.requestId, workItemId: result.workItemId, newRowVersion: result.newRowVersion };
}

async function runTailor(t: TestDatabase, artifactsDir: string, workItemId: string) {
  const claimed = claimNextWorkItem(t.handle, {
    workerId: "test-worker",
    kinds: ["TAILOR"],
    leaseDurationMs: 60_000,
    now: new Date().toISOString(),
  });
  expect(claimed?.id).toBe(workItemId);
  const payload = JSON.parse(String(claimed?.payloadJson)) as {
    generationRequestId: string;
    jdSnapshotId: string;
    profileVersionId: string;
  };
  const candidate = getOrCreateCandidateSnapshot(t.handle, {
    profileVersionId: payload.profileVersionId,
  });
  if (!candidate.ok) {
    throw new Error("candidate snapshot resolution failed in setup");
  }
  const handler = createTailorHandler({
    artifactsDir,
    provider: new TestProvider({
      proposals: {
        [payload.jdSnapshotId]: e2eProposal(payload.jdSnapshotId, candidate.snapshotId),
      },
    }),
    renderPdf: async (html) => stubRenderPdf(html),
  });
  const outcome = await handler(handlerContext(t, workItemId));
  // Mirror the worker loop: a published run completes its item, so
  // the one-live-TAILOR index sees no dangling lease.
  if (outcome.result === "SUCCEEDED" && claimed !== null) {
    const completed = completeWorkItem(t.handle, {
      workItemId,
      leaseToken: claimed.leaseToken,
      result: "SUCCEEDED",
    });
    if (!completed.ok) {
      throw new Error(`completion failed in setup: ${completed.error}`);
    }
  }
  return outcome;
}

function readJob(t: TestDatabase, jobId: string) {
  return t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

describe("revision loop", () => {
  it("requests revision, attaches a child version, and approves it", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const first = startRun(t, { jobId, observedRowVersion: 1 });
    const attached = await runTailor(t, artifactsDir, first.workItemId);
    expect(attached.result).toBe("SUCCEEDED");

    const v1 = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).all();
    expect(v1).toHaveLength(1);
    const v1Id = v1[0]?.id as string;
    const v1ContentHash = v1[0]?.contentHash as string;
    const beforeRevision = readJob(t, jobId);
    expect(beforeRevision?.tailoringState).toBe("AWAITING_REVIEW");
    expect(beforeRevision?.activeResumeVersionId).toBe(v1Id);

    const revised = requestRevision(
      t.handle,
      {
        jobId,
        resumeVersionId: v1Id,
        observedRowVersion: beforeRevision?.rowVersion as number,
        actor: "human",
        note: "Second bullet overstates the caching work.",
      },
      PROVIDER,
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    // The follow-up is a REVISION request bound to v1 + the note.
    const request = t.handle.db
      .select()
      .from(generationRequests)
      .where(eq(generationRequests.id, revised.requestId))
      .get();
    expect(request).toMatchObject({
      requestKind: "REVISION",
      parentVersionId: v1Id,
      revisionNote: "Second bullet overstates the caching work.",
      status: "QUEUED",
      workItemId: revised.workItemId,
    });
    const followUp = t.handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, revised.workItemId))
      .get();
    expect(followUp?.kind).toBe("TAILOR");
    expect(followUp?.state).toBe("QUEUED");
    const payload = JSON.parse(String(followUp?.payloadJson)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schemaVersion: "tailor-queue/v2",
      generationRequestId: revised.requestId,
      parentVersionId: v1Id,
    });
    const frozen = t.handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, v1Id))
      .get();
    expect(frozen?.reviewState).toBe("REVISION_REQUESTED");
    const revisionReviews = t.handle.db
      .select()
      .from(resumeReviews)
      .where(eq(resumeReviews.resumeVersionId, v1Id))
      .all();
    expect(revisionReviews).toHaveLength(1);
    expect(revisionReviews[0]).toMatchObject({
      action: "REVISION_REQUESTED",
      actor: "human",
      note: "Second bullet overstates the caching work.",
    });

    // The scripted provider returns the identical proposal, so the
    // follow-up run produces identical bytes — which must still mint a
    // new child version, never converge onto the terminal v1.
    const rerun = await runTailor(t, artifactsDir, revised.workItemId);
    expect(rerun.result).toBe("SUCCEEDED");
    const versions = t.handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.jobId, jobId))
      .all();
    expect(versions).toHaveLength(2);
    const v2 = versions.find((row) => row.id !== v1Id);
    expect(v2).toMatchObject({
      version: 2,
      parentVersionId: v1Id,
      reviewState: "AWAITING_REVIEW",
      contentHash: v1ContentHash,
      generationRequestId: revised.requestId,
    });
    const awaitingChild = readJob(t, jobId);
    expect(awaitingChild?.tailoringState).toBe("AWAITING_REVIEW");
    expect(awaitingChild?.activeResumeVersionId).toBe(v2?.id);

    const approved = approveResume(
      t.handle,
      {
        jobId,
        resumeVersionId: v2?.id as string,
        observedRowVersion: awaitingChild?.rowVersion as number,
        actor: "human",
        note: "Caching bullet now matches the evidence.",
      },
      { artifactsDir },
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved).toMatchObject({ approvalCase: "move" });
    expect(typeof approved.eventId).toBe("string");
    expect(approved.newRowVersion).toBe((awaitingChild?.rowVersion as number) + 1);
    const tailored = readJob(t, jobId);
    expect(tailored?.status).toBe("TAILORED");
    expect(tailored?.tailoringState).toBe("APPROVED");
    expect(tailored?.selectedResumeVersionId).toBe(v2?.id);
    const v2Row = t.handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, v2?.id as string))
      .get();
    expect(v2Row?.reviewState).toBe("APPROVED");
  });

  it("rejects revision for unknown, non-active, and unnoted versions", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const first = startRun(t, { jobId, observedRowVersion: 1 });
    expect((await runTailor(t, artifactsDir, first.workItemId)).result).toBe("SUCCEEDED");
    const v1 = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).get();
    const job = readJob(t, jobId);
    const rowVersion = job?.rowVersion as number;

    const unknown = requestRevision(
      t.handle,
      {
        jobId,
        resumeVersionId: newId(),
        observedRowVersion: rowVersion,
        actor: "human",
        note: "Note.",
      },
      PROVIDER,
    );
    expect(unknown).toMatchObject({ ok: false, error: "unknown-version" });

    // A version that exists but is not active cannot be revised.
    t.handle.db
      .update(jobs)
      .set({ activeResumeVersionId: null })
      .where(eq(jobs.id, jobId))
      .run();
    const stale = requestRevision(
      t.handle,
      {
        jobId,
        resumeVersionId: v1?.id as string,
        observedRowVersion: rowVersion,
        actor: "human",
        note: "Note.",
      },
      PROVIDER,
    );
    expect(stale).toMatchObject({ ok: false, error: "stale-version" });
    t.handle.db
      .update(jobs)
      .set({ activeResumeVersionId: v1?.id as string })
      .where(eq(jobs.id, jobId))
      .run();

    expect(() =>
      requestRevision(
        t.handle,
        {
          jobId,
          resumeVersionId: v1?.id as string,
          observedRowVersion: rowVersion,
          actor: "human",
          note: "",
        },
        PROVIDER,
      ),
    ).toThrow();
  });

  it("rejects a second revision of the same version without re-enqueueing", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const first = startRun(t, { jobId, observedRowVersion: 1 });
    expect((await runTailor(t, artifactsDir, first.workItemId)).result).toBe("SUCCEEDED");
    const v1 = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).get();
    const job = readJob(t, jobId);
    const revised = requestRevision(
      t.handle,
      {
        jobId,
        resumeVersionId: v1?.id as string,
        observedRowVersion: job?.rowVersion as number,
        actor: "human",
        note: "First note.",
      },
      PROVIDER,
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const again = requestRevision(
      t.handle,
      {
        jobId,
        resumeVersionId: v1?.id as string,
        observedRowVersion: revised.newRowVersion,
        actor: "human",
        note: "Second note.",
      },
      PROVIDER,
    );
    expect(again).toMatchObject({ ok: false, error: "forbidden" });
    const followUps = t.handle.db.select().from(workItems).all();
    // The original run plus exactly one revision run.
    expect(followUps).toHaveLength(2);
    const reviews = t.handle.db
      .select()
      .from(resumeReviews)
      .where(eq(resumeReviews.resumeVersionId, v1?.id as string))
      .all();
    expect(reviews).toHaveLength(1);
  });
});
