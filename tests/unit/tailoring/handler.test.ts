// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  jobAnalyses,
  jobs,
  newId,
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeVersions,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { eq } from "drizzle-orm";
import { resolveCurrentSnapshots } from "../../../src/server/candidates";
import { ResumeContentV1 } from "../../../src/tailoring/contract";
import { requestTailoring } from "../../../src/tailoring/enqueue";
import { createTailorHandler } from "../../../src/tailoring/handler";
import { TestProvider } from "../../../src/tailoring/testProvider";
import {
  E2E_JD_TEXT,
  addExtraction,
  e2eProposal,
  handlerContext,
  importTestProfile,
  seedJob,
  stubRenderPdf,
} from "./support";

/**
 * TAILOR handler integration: seeded database plus isolated artifact
 * directory, scripted provider, stub PDF renderer. Asserts outcomes,
 * state transitions, persisted rows, and bytes on disk.
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
  const t = createTestDatabase("tailor-handler-");
  testDbs.push(t);
  const artifactsDir = mkdtempSync(join(tmpdir(), "tailor-artifacts-"));
  tempDirs.push(artifactsDir);
  return { t, artifactsDir };
}

describe("TAILOR handler", () => {
  it("attaches a full version with verified artifacts", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const snapshots = resolveCurrentSnapshots(t.handle, jobId);
    if (!snapshots.ok) {
      throw new Error("snapshot resolution failed in setup");
    }
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({
        proposals: { [snapshots.jdSnapshotId]: e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId) },
      }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome.result).toBe("SUCCEEDED");
    expect(outcome.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.outputHash).toMatch(/^[0-9a-f]{64}$/);

    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("AWAITING_REVIEW");
    expect(job?.tailoringReasonCode).toBeNull();
    expect(job?.activeResumeVersionId).not.toBeNull();

    const analyses = t.handle.db.select().from(jobAnalyses).where(eq(jobAnalyses.jobId, jobId)).all();
    expect(analyses).toHaveLength(1);
    const requirements = JSON.parse(analyses[0]?.requirementsJson as string) as {
      schemaVersion: string;
      requirements: unknown[];
    };
    expect(requirements.schemaVersion).toBe("analysis-requirements/v1");
    expect(requirements.requirements).toHaveLength(5);
    const gaps = JSON.parse(analyses[0]?.gapsJson as string) as {
      gaps: Array<{ requirement_id: string }>;
    };
    expect(gaps.gaps.map((gap) => gap.requirement_id).sort()).toEqual(["req_cobol", "req_k8s"]);
    expect(analyses[0]?.provider).toBe("test-provider");
    expect(analyses[0]?.promptVersion).toBe("tailor-prompt/v1");
    expect(analyses[0]?.proposalSchemaVersion).toBe("resume-proposal/v1");
    const attempt = JSON.parse(analyses[0]?.attemptJson as string) as { providerId: string };
    expect(attempt.providerId).toBe("test-provider");

    const versions = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.parentVersionId).toBeNull();
    expect(versions[0]?.templateId).toBe("mouad_standard_v1");
    expect(versions[0]?.rankerVersion).toBe("coverage-first/v1");
    expect(versions[0]?.reviewState).toBe("AWAITING_REVIEW");
    expect(versions[0]?.contentHash).toBe(outcome.outputHash);
    const content = ResumeContentV1.parse(JSON.parse(versions[0]?.contentJson as string));
    expect(content.audit.validatedClaims).toBe(6);
    expect(content.draft.claims).toHaveLength(6);

    const claims = t.handle.db
      .select()
      .from(resumeClaims)
      .where(eq(resumeClaims.resumeVersionId, versions[0]?.id as string))
      .all();
    expect(claims).toHaveLength(6);
    const citations = t.handle.db.select().from(resumeClaimFacts).all();
    expect(citations.length).toBeGreaterThan(0);
    expect(new Set(citations.map((row) => row.factId))).toEqual(
      new Set(["f_api", "f_auth", "f_scale", "f_team"]),
    );

    const artifacts = t.handle.db
      .select()
      .from(resumeArtifacts)
      .where(eq(resumeArtifacts.resumeVersionId, versions[0]?.id as string))
      .all();
    expect(artifacts.map((row) => row.kind).sort()).toEqual(["DOCX", "MARKDOWN", "PDF"]);
    for (const artifact of artifacts) {
      const bytes = readFileSync(join(artifactsDir, artifact.relativePath));
      expect(bytes.length).toBe(artifact.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
  });

  it("reruns idempotently on identical content", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const runOnce = async (extraction: string) => {
      const snapshots = resolveCurrentSnapshots(t.handle, jobId);
      if (!snapshots.ok) {
        throw new Error("snapshot resolution failed in setup");
      }
      const { workItemId } = requestTailoring(t.handle, { jobId, extractionId: extraction });
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
    };
    const first = await runOnce(extractionId);
    expect(first.result).toBe("SUCCEEDED");
    // Simulate a revision request, then rerun on a superseding
    // extraction with identical JD text: same snapshots, same content,
    // so the second run dedupes onto the first version.
    t.handle.db
      .update(jobs)
      .set({ tailoringState: "REVISION_REQUESTED" })
      .where(eq(jobs.id, jobId))
      .run();
    const secondExtraction = addExtraction(t, jobId);
    const second = await runOnce(secondExtraction);
    expect(second.result).toBe("SUCCEEDED");
    expect(second.outputHash).toBe(first.outputHash);
    const versions = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).all();
    expect(versions).toHaveLength(1);
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("AWAITING_REVIEW");
  });

  it("blocks superseding runs while a review is pending", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const snapshots = resolveCurrentSnapshots(t.handle, jobId);
    if (!snapshots.ok) {
      throw new Error("snapshot resolution failed in setup");
    }
    const runOnce = async (extraction: string) => {
      const { workItemId } = requestTailoring(t.handle, { jobId, extractionId: extraction });
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
    };
    expect((await runOnce(extractionId)).result).toBe("SUCCEEDED");
    // A newer extraction cannot yank the pending review: the run
    // reports BLOCKED and the human resolves the review first.
    const second = await runOnce(addExtraction(t, jobId));
    expect(second).toMatchObject({ result: "BLOCKED", errorCode: "STALE_INPUT" });
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("AWAITING_REVIEW");
  });

  it("reports BLOCKED when no provider is configured", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: null,
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "PROVIDER_UNAVAILABLE" });
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("BLOCKED");
    expect(job?.tailoringReasonCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("reports BLOCKED when no profile is active", async () => {
    const { t, artifactsDir } = setup();
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({ proposals: {} }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "PROFILE_REQUIRED" });
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("BLOCKED");
  });

  it("fails invalid proposals without persisting anything", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const snapshots = resolveCurrentSnapshots(t.handle, jobId);
    if (!snapshots.ok) {
      throw new Error("snapshot resolution failed in setup");
    }
    const bad = e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId);
    const requirements = bad["requirements"] as Array<Record<string, unknown>>;
    requirements[0] = { ...requirements[0], jd_quote: "Fabricated quote about nothing" };
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({ proposals: { [snapshots.jdSnapshotId]: bad } }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome.result).toBe("FAILED");
    expect(outcome.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(outcome.errorDetail).toContain("must quote exact JD text");
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("FAILED");
    expect(t.handle.db.select().from(jobAnalyses).all()).toHaveLength(0);
    expect(t.handle.db.select().from(resumeVersions).all()).toHaveLength(0);
  });

  it("fences runs superseded by a newer extraction", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    addExtraction(t, jobId);
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({ proposals: {} }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "STALE_INPUT" });
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("PENDING");
    expect(t.handle.db.select().from(jobAnalyses).all()).toHaveLength(0);
  });

  it("fences rejected jobs without touching state", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    t.handle.db.update(jobs).set({ status: "REJECTED" }).where(eq(jobs.id, jobId)).run();
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({ proposals: {} }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "STALE_INPUT" });
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("PENDING");
  });

  it("stops early when the lease is lost", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({ proposals: {} }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId, () => false));
    expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LEASE_EXPIRED" });
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.tailoringState).toBe("PENDING");
  });

  it("rejects unusable queue payloads", async () => {
    const { t, artifactsDir } = setup();
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId: newId() });
    t.handle.db
      .update(workItems)
      .set({ payloadJson: "{not json" })
      .where(eq(workItems.id, workItemId))
      .run();
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({ proposals: {} }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome).toMatchObject({ result: "FAILED", errorCode: "STALE_INPUT" });
  });

  it("dedupes enqueue by job and extraction", () => {
    const { t } = setup();
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const extractionId = newId();
    const first = requestTailoring(t.handle, { jobId, extractionId });
    const second = requestTailoring(t.handle, { jobId, extractionId });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.workItemId).toBe(first.workItemId);
  });

  it("backfills missing salary before the fenced run", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const snapshots = resolveCurrentSnapshots(t.handle, jobId);
    if (!snapshots.ok) {
      throw new Error("snapshot resolution failed in setup");
    }
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const factsJson = JSON.stringify({
      schemaVersion: "salary-facts/v1",
      salaryMinMinor: 14590000,
      salaryMaxMinor: 19740000,
      currency: "CAD",
      salaryText: "$145,900 - $197,400 CAD per year",
      isHourlyOrDaily: false,
      compensationHighlights: ["RRSP matching"],
      model: "stub",
    });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({
        proposals: { [snapshots.jdSnapshotId]: e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId) },
      }),
      renderPdf: async (html) => stubRenderPdf(html),
      salaryFallback: {
        argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(factsJson)})`],
        timeoutMs: 5000,
        maxOutputBytes: 65_536,
      },
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome.result).toBe("SUCCEEDED");
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job).toMatchObject({
      salaryText: "$145,900 - $197,400 CAD per year",
      salaryCurrency: "CAD",
      salaryMinMinor: 14590000,
      salaryMaxMinor: 19740000,
      compensationHighlightsJson: JSON.stringify(["RRSP matching"]),
      tailoringState: "AWAITING_REVIEW",
    });
  });

  it("survives salary sidecar failure without failing the run", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const snapshots = resolveCurrentSnapshots(t.handle, jobId);
    if (!snapshots.ok) {
      throw new Error("snapshot resolution failed in setup");
    }
    const { workItemId } = requestTailoring(t.handle, { jobId, extractionId });
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({
        proposals: { [snapshots.jdSnapshotId]: e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId) },
      }),
      renderPdf: async (html) => stubRenderPdf(html),
      salaryFallback: {
        argv: [process.execPath, "-e", "process.exit(3)"],
        timeoutMs: 5000,
        maxOutputBytes: 65_536,
      },
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome.result).toBe("SUCCEEDED");
    const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(job?.salaryText).toBeNull();
    expect(job?.tailoringState).toBe("AWAITING_REVIEW");
  });
});
