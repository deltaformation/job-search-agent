// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  jobs,
  newId,
  resumeReviews,
  resumeVersions,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { resolveCurrentSnapshots } from "../../../src/server/candidates";
import { approveResume, requestRevision } from "../../../src/server/review";
import {
  requestRevisionRun,
  requestTailoring,
  tailorIdempotencyKey,
  tailorRevisionIdempotencyKey,
} from "../../../src/tailoring/enqueue";
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
 * R4-F revision loop: a real TAILOR run attaches v1, the human requests
 * revision (new review + follow-up run atomically), the worker attaches a
 * v2 child even when the provider returns identical content, and the
 * human approves v2 into TAILORED. Uses the scripted provider and the
 * stub PDF renderer; only the review boundary is new here.
 */

const tempDirs: string[] = [];
const testDbs: TestDatabase[] = [];

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

async function runTailor(t: TestDatabase, artifactsDir: string, jobId: string, workItemId: string) {
  const snapshots = resolveCurrentSnapshots(t.handle, jobId);
  if (!snapshots.ok) {
    throw new Error("snapshot resolution failed in setup");
  }
  const handler = createTailorHandler({
    artifactsDir,
    provider: new TestProvider({
      proposals: {
        [snapshots.jdSnapshotId]: e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId),
      },
    }),
    renderPdf: async (html) => stubRenderPdf(html),
  });
  return handler(handlerContext(t, workItemId));
}

function readJob(t: TestDatabase, jobId: string) {
  return t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

describe("revision loop", () => {
  it("requests revision, attaches a child version, and approves it", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const first = requestTailoring(t.handle, { jobId, extractionId });
    expect(first.deduped).toBe(false);
    const attached = await runTailor(t, artifactsDir, jobId, first.workItemId);
    expect(attached.result).toBe("SUCCEEDED");

    const v1 = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).all();
    expect(v1).toHaveLength(1);
    const v1Id = v1[0]?.id as string;
    const v1ContentHash = v1[0]?.contentHash as string;
    const beforeRevision = readJob(t, jobId);
    expect(beforeRevision?.tailoringState).toBe("AWAITING_REVIEW");
    expect(beforeRevision?.activeResumeVersionId).toBe(v1Id);

    const revised = requestRevision(t.handle, {
      jobId,
      resumeVersionId: v1Id,
      observedRowVersion: beforeRevision?.rowVersion as number,
      actor: "human",
      note: "Second bullet overstates the caching work.",
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.deduped).toBe(false);
    const followUp = t.handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, revised.workItemId))
      .get();
    expect(followUp?.kind).toBe("TAILOR");
    expect(followUp?.state).toBe("QUEUED");
    expect(followUp?.idempotencyKey).toBe(tailorRevisionIdempotencyKey(jobId, v1Id));
    expect(followUp?.idempotencyKey).not.toBe(tailorIdempotencyKey(jobId, extractionId));
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
    const rerun = await runTailor(t, artifactsDir, jobId, revised.workItemId);
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
    expect(approved.newRowVersion).toBe((awaitingChild?.rowVersion as number) + 1);
    const tailored = readJob(t, jobId);
    expect(tailored?.status).toBe("TAILORED");
    expect(tailored?.tailoringState).toBe("APPROVED");
    const v2Row = t.handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, v2?.id as string))
      .get();
    expect(v2Row?.reviewState).toBe("APPROVED");
  });

  it("dedupes revision enqueue by job and parent version", () => {
    const { t } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const parentVersionId = newId();
    const first = requestRevisionRun(t.handle, { jobId, extractionId, parentVersionId });
    const second = requestRevisionRun(t.handle, { jobId, extractionId, parentVersionId });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.workItemId).toBe(first.workItemId);
    // A different parent is a different revision round: no dedupe.
    const third = requestRevisionRun(t.handle, { jobId, extractionId, parentVersionId: newId() });
    expect(third.deduped).toBe(false);
  });

  it("rejects a second revision of the same version without re-enqueueing", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const first = requestTailoring(t.handle, { jobId, extractionId });
    expect((await runTailor(t, artifactsDir, jobId, first.workItemId)).result).toBe("SUCCEEDED");
    const v1 = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).get();
    const job = readJob(t, jobId);
    const revised = requestRevision(t.handle, {
      jobId,
      resumeVersionId: v1?.id as string,
      observedRowVersion: job?.rowVersion as number,
      actor: "human",
      note: "First note.",
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const again = requestRevision(t.handle, {
      jobId,
      resumeVersionId: v1?.id as string,
      observedRowVersion: revised.newRowVersion,
      actor: "human",
      note: "Second note.",
    });
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
