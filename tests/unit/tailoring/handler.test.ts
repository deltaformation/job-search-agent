// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeVersions,
  scrapeAttempts,
  utcNow,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { eq } from "drizzle-orm";
import type { WorkHandlerContext } from "../../../src/queue/dispatch";
import {
  activateProfileVersion,
  importCandidate,
  resolveCurrentSnapshots,
} from "../../../src/server/candidates";
import { ResumeContentV1 } from "../../../src/tailoring/contract";
import { requestTailoring } from "../../../src/tailoring/enqueue";
import { createTailorHandler } from "../../../src/tailoring/handler";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { E2E_JD_TEXT, e2eProposal, stubRenderPdf } from "./support";

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

function importTestProfile(t: TestDatabase): string {
  const imported = importCandidate(t.handle, {
    document: {
      schemaVersion: "candidate-import/v1",
      identity: {
        fullName: "Orchestration Candidate",
        headline: "Backend Engineer",
        email: "orchestration@example.com",
        phone: "+1-555-0100",
        location: "Toronto, ON",
      },
      targetTitles: ["Backend Engineer"],
      employment: [
        {
          id: "emp-1",
          company: "Acme",
          role: "Engineer",
          location: "Toronto, ON",
          startDate: "2020-01-15",
          endDate: "2022-06-30",
          isCurrent: false,
        },
        {
          id: "emp-2",
          company: "Beta",
          role: "Senior Engineer",
          location: "Remote",
          startDate: "2022-07-01",
          isCurrent: true,
        },
      ],
      achievements: [
        {
          factId: "f_api",
          employmentId: "emp-2",
          category: "experience",
          text: "Led the public API migration to TypeScript serving ten million daily requests.",
          technologies: ["TypeScript"],
          metrics: ["10M daily requests"],
          verification: "APPROVED",
        },
        {
          factId: "f_auth",
          employmentId: "emp-2",
          category: "experience",
          text: "Shipped single sign-on with SAML for forty enterprise tenants.",
          technologies: ["SAML"],
          metrics: ["40 tenants"],
          verification: "APPROVED",
        },
        {
          factId: "f_scale",
          employmentId: "emp-1",
          category: "experience",
          text: "Reduced API latency by forty percent with caching and connection pooling.",
          technologies: ["Redis"],
          metrics: ["40% lower latency"],
          verification: "APPROVED",
        },
        {
          factId: "f_team",
          employmentId: "emp-1",
          category: "experience",
          text: "Mentored four engineers and established incident review practices.",
          technologies: [],
          metrics: ["4 engineers"],
          verification: "APPROVED",
        },
      ],
      skills: [
        { name: "TypeScript", verified: true },
        { name: "SAML", verified: true },
        { name: "COBOL", verified: true },
        { name: "Rust", verified: false },
      ],
      education: [
        {
          degree: "B.Sc.",
          fieldOfStudy: "Computer Science",
          institution: "Test University",
          startDate: "2014-09-01",
          endDate: "2018-05-31",
        },
      ],
    },
    actor: "human",
  });
  if (!imported.ok) {
    throw new Error(`profile import failed: ${imported.error}`);
  }
  const activated = activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human" });
  if (!activated.ok) {
    throw new Error("profile activation failed");
  }
  return imported.versionId;
}

function seedJob(t: TestDatabase, descriptionText: string): { jobId: string; extractionId: string } {
  const jobId = newId();
  t.handle.db
    .insert(jobs)
    .values({ id: jobId, title: "Backend Engineer", company: "Acme", status: "NEW" })
    .run();
  const attemptId = newId();
  t.handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: utcNow(),
      finishedAt: utcNow(),
      outcome: "SUCCEEDED",
    })
    .run();
  const extractionId = newId();
  t.handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "job-extraction-v1",
      adapter: "test",
      extractedJson: "{}",
    })
    .run();
  t.handle.db
    .update(jobs)
    .set({ descriptionText, activeExtractionId: extractionId })
    .where(eq(jobs.id, jobId))
    .run();
  return { jobId, extractionId };
}

function addExtraction(t: TestDatabase, jobId: string): string {
  const attemptId = newId();
  t.handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: utcNow(),
      finishedAt: utcNow(),
      outcome: "SUCCEEDED",
    })
    .run();
  const extractionId = newId();
  t.handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 2,
      schemaVersion: "job-extraction-v1",
      adapter: "test",
      extractedJson: "{}",
    })
    .run();
  t.handle.db
    .update(jobs)
    .set({ activeExtractionId: extractionId })
    .where(eq(jobs.id, jobId))
    .run();
  return extractionId;
}

function handlerContext(
  t: TestDatabase,
  workItemId: string,
  heartbeat: () => boolean = () => true,
): WorkHandlerContext {
  const item = t.handle.db.select().from(workItems).where(eq(workItems.id, workItemId)).get();
  if (item === undefined) {
    throw new Error("work item missing");
  }
  return { handle: t.handle, item: { ...item, leaseToken: "test-lease" }, workerId: "test-worker", heartbeat };
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
    expect(content.audit.validatedClaims).toBe(5);
    expect(content.draft.claims).toHaveLength(5);

    const claims = t.handle.db
      .select()
      .from(resumeClaims)
      .where(eq(resumeClaims.resumeVersionId, versions[0]?.id as string))
      .all();
    expect(claims).toHaveLength(5);
    const citations = t.handle.db.select().from(resumeClaimFacts).all();
    expect(citations.length).toBeGreaterThan(0);
    expect(new Set(citations.map((row) => row.factId))).toEqual(
      new Set(["f_api", "f_auth", "f_scale"]),
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
});
