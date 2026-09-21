// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  generationRequests,
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
import { claimNextWorkItem, recoverStaleLeases } from "../../../src/queue/leases";
import { getOrCreateCandidateSnapshot, getOrCreateJdSnapshot } from "../../../src/server/candidates";
import { requestGeneration } from "../../../src/server/tailoring";
import { ResumeContentV1 } from "../../../src/tailoring/contract";
import { createTailorHandler } from "../../../src/tailoring/handler";
import { terminalizeExhaustedRun } from "../../../src/tailoring/persist";
import {
  SteeringSnapshotV1,
  generationRequestIdentity,
  hashGenerationRequest,
} from "../../../src/tailoring/requests";
import { candidateProfiles } from "../../../src/db/schema/candidates";
import { utcNow } from "../../../src/db/utils";
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
 * TAILOR handler integration (WO-1.2-D): seeded database plus isolated
 * artifact directory, scripted provider, stub PDF renderer. Runs start
 * through the explicit generation command, claim through the real
 * lease path, and execute through the v2 handler. Asserts outcomes,
 * pinned bindings, durable linkage, recovery, and bytes on disk.
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
  const t = createTestDatabase("tailor-handler-");
  testDbs.push(t);
  const artifactsDir = mkdtempSync(join(tmpdir(), "tailor-artifacts-"));
  tempDirs.push(artifactsDir);
  return { t, artifactsDir };
}

interface StartedRun {
  requestId: string;
  workItemId: string;
  newRowVersion: number;
}

function startRun(
  t: TestDatabase,
  input: {
    jobId: string;
    observedRowVersion: number;
    parentVersionId?: string;
    selectedKeywords?: string[];
    directives?: string;
  },
): StartedRun {
  const result = requestGeneration(t.handle, { ...input, actor: "human" }, PROVIDER);
  if (!result.ok) {
    throw new Error(`run start failed: ${result.error} ${result.detail}`);
  }
  return {
    requestId: result.requestId,
    workItemId: result.workItemId,
    newRowVersion: result.newRowVersion,
  };
}

function readJob(t: TestDatabase, jobId: string) {
  return t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

function readRequest(t: TestDatabase, requestId: string) {
  return t.handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.id, requestId))
    .get();
}

function pinnedSnapshots(t: TestDatabase, workItemId: string): { jdSnapshotId: string; candidateSnapshotId: string } {
  const item = t.handle.db.select().from(workItems).where(eq(workItems.id, workItemId)).get();
  const payload = JSON.parse(String(item?.payloadJson)) as {
    jdSnapshotId: string;
    profileVersionId: string;
  };
  const candidate = getOrCreateCandidateSnapshot(t.handle, {
    profileVersionId: payload.profileVersionId,
  });
  if (!candidate.ok) {
    throw new Error("candidate snapshot resolution failed in setup");
  }
  return { jdSnapshotId: payload.jdSnapshotId, candidateSnapshotId: candidate.snapshotId };
}

function runHandler(
  t: TestDatabase,
  artifactsDir: string,
  workItemId: string,
  options: {
    proposals?: Record<string, Record<string, unknown>>;
    provider?: null;
    heartbeat?: () => boolean;
    now?: string;
  } = {},
) {
  const claimed = claimNextWorkItem(t.handle, {
    workerId: "test-worker",
    kinds: ["TAILOR"],
    leaseDurationMs: 60_000,
    now: options.now ?? new Date().toISOString(),
  });
  expect(claimed?.id).toBe(workItemId);
  const snapshots = pinnedSnapshots(t, workItemId);
  const handler = createTailorHandler({
    artifactsDir,
    provider:
      options.provider === null
        ? null
        : new TestProvider({
            proposals: options.proposals ?? {
              [snapshots.jdSnapshotId]: e2eProposal(
                snapshots.jdSnapshotId,
                snapshots.candidateSnapshotId,
              ),
            },
          }),
    renderPdf: async (html) => stubRenderPdf(html),
  });
  return handler(handlerContext(t, workItemId, options.heartbeat));
}

describe("TAILOR handler", () => {
  it("attaches a full version with verified artifacts and durable linkage", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const outcome = await runHandler(t, artifactsDir, started.workItemId);
    expect(outcome.result).toBe("SUCCEEDED");
    expect(outcome.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.outputHash).toMatch(/^[0-9a-f]{64}$/);

    const job = readJob(t, jobId);
    expect(job?.tailoringState).toBe("AWAITING_REVIEW");
    expect(job?.tailoringReasonCode).toBeNull();
    expect(job?.activeResumeVersionId).not.toBeNull();
    expect(readRequest(t, started.requestId)?.status).toBe("SUCCEEDED");

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
    // Durable linkage: the exact request and claim-minted attempt.
    const item = t.handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, started.workItemId))
      .get();
    expect(analyses[0]?.generationRequestId).toBe(started.requestId);
    expect(analyses[0]?.workAttemptId).toBe(item?.currentAttemptId);

    const versions = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.parentVersionId).toBeNull();
    expect(versions[0]?.templateId).toBe("mouad_standard_v1");
    expect(versions[0]?.rankerVersion).toBe("coverage-first/v1");
    expect(versions[0]?.reviewState).toBe("AWAITING_REVIEW");
    expect(versions[0]?.contentHash).toBe(outcome.outputHash);
    expect(versions[0]?.generationRequestId).toBe(started.requestId);
    expect(versions[0]?.workAttemptId).toBe(item?.currentAttemptId);
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

  it("converges without new rows when the finished run replays", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    expect((await runHandler(t, artifactsDir, started.workItemId)).result).toBe("SUCCEEDED");
    // Crash between publish and attempt completion: the lease expires,
    // recovery requeues the item, and the worker picks it up after restart.
    t.handle.db
      .update(workItems)
      .set({ leaseExpiresAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(workItems.id, started.workItemId))
      .run();
    recoverStaleLeases(t.handle, {});
    const replay = await runHandler(t, artifactsDir, started.workItemId);
    expect(replay.result).toBe("SUCCEEDED");
    expect(t.handle.db.select().from(jobAnalyses).all()).toHaveLength(1);
    expect(t.handle.db.select().from(resumeVersions).all()).toHaveLength(1);
    expect(readRequest(t, started.requestId)?.status).toBe("SUCCEEDED");
  });

  it("reopens a run whose previous attempt died mid-flight", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    // Simulate a crash after begin: the job is RUNNING, the item goes
    // back to QUEUED through lease recovery, and the next claim
    // reopens and completes the run.
    const firstClaim = claimNextWorkItem(t.handle, {
      workerId: "dying-worker",
      kinds: ["TAILOR"],
      leaseDurationMs: 1_000,
      now: "2026-09-11T12:00:00.000Z",
    });
    expect(firstClaim?.id).toBe(started.workItemId);
    t.handle.db.update(jobs).set({ tailoringState: "RUNNING" }).where(eq(jobs.id, jobId)).run();
    const recovered = recoverStaleLeases(t.handle, { now: "2026-09-11T12:05:00.000Z" });
    expect(recovered).toMatchObject({ recovered: 1, requeued: 1, failed: 0 });
    const outcome = await runHandler(t, artifactsDir, started.workItemId);
    expect(outcome.result).toBe("SUCCEEDED");
    expect(readJob(t, jobId)?.tailoringState).toBe("AWAITING_REVIEW");
    expect(t.handle.db.select().from(resumeVersions).all()).toHaveLength(1);
  });

  it("terminalizes a run whose attempts are exhausted", () => {
    const { t } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    t.handle.db.update(jobs).set({ tailoringState: "RUNNING" }).where(eq(jobs.id, jobId)).run();
    const terminalized = terminalizeExhaustedRun(t.handle, {
      jobId,
      workItemId: started.workItemId,
      attempts: 3,
      now: new Date().toISOString(),
    });
    expect(terminalized).toEqual({ ok: true, terminalized: true });
    expect(readJob(t, jobId)).toMatchObject({
      tailoringState: "FAILED",
      tailoringReasonCode: "TIMEOUT",
    });
    expect(readRequest(t, started.requestId)).toMatchObject({
      status: "FAILED",
      errorCode: "TIMEOUT",
    });
    // A moved job is a no-op, never an error.
    expect(
      terminalizeExhaustedRun(t.handle, {
        jobId,
        workItemId: started.workItemId,
        attempts: 3,
        now: new Date().toISOString(),
      }),
    ).toEqual({ ok: true, terminalized: false });
  });

  it("reports BLOCKED when no provider is configured", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const outcome = await runHandler(t, artifactsDir, started.workItemId, { provider: null });
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "PROVIDER_UNAVAILABLE" });
    expect(readJob(t, jobId)).toMatchObject({
      tailoringState: "BLOCKED",
      tailoringReasonCode: "PROVIDER_UNAVAILABLE",
    });
    expect(readRequest(t, started.requestId)?.status).toBe("FAILED");
  });

  it("fails the run when the pinned profile version is gone", async () => {
    const { t, artifactsDir } = setup();
    // Request bindings are immutable and profile facts refuse deletion,
    // so the corruption case is built directly: a fully consistent
    // request/item pair whose pinned profile version was never written.
    // Verification passes; candidate resolution fences the run.
    const profileId = importTestProfile(t);
    const { jobId, extractionId } = seedJob(t, E2E_JD_TEXT);
    const profile = t.handle.db
      .select()
      .from(candidateProfiles)
      .where(eq(candidateProfiles.id, profileId))
      .get();
    const preferences = JSON.parse(String(profile?.workPreferencesJson ?? "null")) as {
      targetTitles?: string[];
      targetLocations?: string[];
      careerKeywords?: string[];
      workMode?: string[];
      workAuthorization?: string[];
      sponsorshipRequired?: boolean | null;
      willingToRelocate?: boolean | null;
      yearsOfExperience?: number | null;
    } | null;
    const jd = getOrCreateJdSnapshot(t.handle, {
      jobId,
      extractionId,
      jdText: E2E_JD_TEXT,
    });
    if (!jd.ok) {
      throw new Error("JD snapshot setup failed");
    }
    const missingVersionId = newId();
    const steering = SteeringSnapshotV1.parse({
      schemaVersion: "generation-steering/v1",
      profileId,
      profileVersionId: missingVersionId,
      profileName: profile?.name ?? "missing",
      profileDisplayName: profile?.displayName ?? "missing",
      executiveNarrative: profile?.executiveNarrative ?? null,
      targetTitles: preferences?.targetTitles ?? [],
      targetLocations: preferences?.targetLocations ?? [],
      careerKeywords: preferences?.careerKeywords ?? [],
      workMode: preferences?.workMode ?? [],
      workAuthorization: preferences?.workAuthorization ?? [],
      sponsorshipRequired: preferences?.sponsorshipRequired ?? null,
      willingToRelocate: preferences?.willingToRelocate ?? null,
      yearsOfExperience: preferences?.yearsOfExperience ?? null,
    });
    const requestId = newId();
    const workItemId = newId();
    const identity = generationRequestIdentity(requestId);
    const payloadHash = hashGenerationRequest({
      requestIdentity: identity,
      jobId,
      extractionId,
      profileId,
      profileVersionId: missingVersionId,
      jdSnapshotId: jd.snapshotId,
      parentVersionId: null,
      requestKind: "INITIAL",
      steeringSnapshot: steering,
      selectedKeywords: [],
      directivesText: null,
      revisionNote: null,
    });
    const now = utcNow();
    // The item lands first: the request's work_item_id FK needs it, and
    // the payload's request reference is plain text with no FK.
    t.handle.db
      .insert(workItems)
      .values({
        id: workItemId,
        kind: "TAILOR",
        idempotencyKey: `test:missing-version:${workItemId}`,
        jobId,
        payloadJson: JSON.stringify({
          schemaVersion: "tailor-queue/v2",
          generationRequestId: requestId,
          jobId,
          extractionId,
          profileId,
          profileVersionId: missingVersionId,
          jdSnapshotId: jd.snapshotId,
          payloadHash,
        }),
        state: "QUEUED",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    t.handle.db
      .insert(generationRequests)
      .values({
        id: requestId,
        requestIdentity: identity,
        jobId,
        extractionId,
        profileId,
        profileVersionId: missingVersionId,
        jdSnapshotId: jd.snapshotId,
        parentVersionId: null,
        requestKind: "INITIAL",
        steeringSnapshotJson: JSON.stringify(steering),
        selectedKeywordsJson: "[]",
        directivesText: null,
        revisionNote: null,
        payloadHash,
        status: "QUEUED",
        workItemId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    t.handle.db.update(jobs).set({ tailoringState: "PENDING" }).where(eq(jobs.id, jobId)).run();
    const claimed = claimNextWorkItem(t.handle, {
      workerId: "test-worker",
      kinds: ["TAILOR"],
      leaseDurationMs: 60_000,
      now: new Date().toISOString(),
    });
    expect(claimed?.id).toBe(workItemId);
    const handler = createTailorHandler({
      artifactsDir,
      provider: new TestProvider({
        proposals: { [jd.snapshotId]: e2eProposal(jd.snapshotId, "candidate-missing") },
      }),
      renderPdf: async (html) => stubRenderPdf(html),
    });
    const outcome = await handler(handlerContext(t, workItemId));
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "PROFILE_REQUIRED" });
    expect(readJob(t, jobId)).toMatchObject({
      tailoringState: "FAILED",
      tailoringReasonCode: "PROFILE_REQUIRED",
    });
    expect(readRequest(t, requestId)?.status).toBe("FAILED");
  });

  it("fails invalid proposals without persisting anything on the final attempt", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    t.handle.db
      .update(workItems)
      .set({ maxAttempts: 1 })
      .where(eq(workItems.id, started.workItemId))
      .run();
    const snapshots = pinnedSnapshots(t, started.workItemId);
    const bad = e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId);
    const requirements = bad["requirements"] as Array<Record<string, unknown>>;
    requirements[0] = { ...requirements[0], jd_quote: "Fabricated quote about nothing" };
    const outcome = await runHandler(t, artifactsDir, started.workItemId, {
      proposals: { [snapshots.jdSnapshotId]: bad },
    });
    expect(outcome.result).toBe("FAILED");
    expect(outcome.errorCode).toBe("INVALID_RESPONSE");
    expect(outcome.errorDetail).toContain("must quote exact JD text");
    expect(readJob(t, jobId)?.tailoringState).toBe("FAILED");
    expect(readRequest(t, started.requestId)?.status).toBe("FAILED");
    expect(t.handle.db.select().from(jobAnalyses).all()).toHaveLength(0);
    expect(t.handle.db.select().from(resumeVersions).all()).toHaveLength(0);
  });

  it("leaves the run open for retry while attempts remain", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const snapshots = pinnedSnapshots(t, started.workItemId);
    const bad = e2eProposal(snapshots.jdSnapshotId, snapshots.candidateSnapshotId);
    const requirements = bad["requirements"] as Array<Record<string, unknown>>;
    requirements[0] = { ...requirements[0], jd_quote: "Fabricated quote about nothing" };
    const outcome = await runHandler(t, artifactsDir, started.workItemId, {
      proposals: { [snapshots.jdSnapshotId]: bad },
    });
    expect(outcome.result).toBe("FAILED");
    // Attempts remain (1 of 3): the job and request stay live so the
    // requeued item can retry; nothing terminal was written.
    expect(readJob(t, jobId)?.tailoringState).toBe("RUNNING");
    expect(readRequest(t, started.requestId)?.status).toBe("RUNNING");
  });

  it("retires a run superseded by a newer extraction and rests the job READY", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    addExtraction(t, jobId);
    const outcome = await runHandler(t, artifactsDir, started.workItemId);
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "STALE_INPUT" });
    expect(readJob(t, jobId)?.tailoringState).toBe("READY");
    expect(readRequest(t, started.requestId)).toMatchObject({
      status: "FAILED",
      errorCode: "STALE_INPUT",
    });
    expect(t.handle.db.select().from(jobAnalyses).all()).toHaveLength(0);
  });

  it("fences rejected jobs without touching them", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    t.handle.db.update(jobs).set({ status: "REJECTED" }).where(eq(jobs.id, jobId)).run();
    const outcome = await runHandler(t, artifactsDir, started.workItemId);
    expect(outcome).toMatchObject({ result: "BLOCKED", errorCode: "STALE_INPUT" });
    expect(readJob(t, jobId)?.tailoringState).toBe("PENDING");
    expect(readRequest(t, started.requestId)?.status).toBe("FAILED");
  });

  it("stops early when the lease is lost", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const outcome = await runHandler(t, artifactsDir, started.workItemId, { heartbeat: () => false });
    expect(outcome).toMatchObject({ result: "FAILED", errorCode: "LEASE_EXPIRED" });
    expect(readJob(t, jobId)?.tailoringState).toBe("PENDING");
    expect(readRequest(t, started.requestId)?.status).toBe("QUEUED");
  });

  it("refuses legacy, unparseable, and unknown-request payloads without touching the run", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    // Every fenced path returns before the provider is consulted, so this
    // series claims and runs directly without resolving snapshots from the
    // (deliberately hostile) payload under test.
    const runSeries = async (payloadJson: string) => {
      t.handle.db
        .update(workItems)
        .set({
          payloadJson,
          maxAttempts: 10,
          leaseExpiresAt: "2026-01-01T00:00:00.000Z",
        })
        .where(eq(workItems.id, started.workItemId))
        .run();
      recoverStaleLeases(t.handle, {});
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "test-worker",
        kinds: ["TAILOR"],
        leaseDurationMs: 60_000,
        now: new Date().toISOString(),
      });
      expect(claimed?.id).toBe(started.workItemId);
      const handler = createTailorHandler({
        artifactsDir,
        provider: new TestProvider({ proposals: {} }),
        renderPdf: async (html) => stubRenderPdf(html),
      });
      return handler(handlerContext(t, started.workItemId));
    };
    const item = t.handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, started.workItemId))
      .get();
    const payload = JSON.parse(String(item?.payloadJson)) as Record<string, unknown>;

    const legacy = await runSeries(
      JSON.stringify({ schemaVersion: "tailor-queue/v1", jobId, extractionId: payload["extractionId"] }),
    );
    expect(legacy).toMatchObject({ result: "BLOCKED", errorCode: "LEGACY_QUEUE_REFUSED" });

    const garbage = await runSeries("{not json");
    expect(garbage).toMatchObject({ result: "BLOCKED", errorCode: "STALE_INPUT" });

    const missing = await runSeries(
      JSON.stringify({ ...payload, generationRequestId: newId() }),
    );
    expect(missing).toMatchObject({ result: "BLOCKED", errorCode: "REQUEST_NOT_FOUND" });

    // No identified request failed: the job and request are untouched.
    expect(readJob(t, jobId)?.tailoringState).toBe("PENDING");
    expect(readRequest(t, started.requestId)?.status).toBe("QUEUED");
  });

  it("fails the identified request on tampered and cross-job payloads", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const runSeries = async (payloadJson: string) => {
      t.handle.db
        .update(workItems)
        .set({
          payloadJson,
          maxAttempts: 10,
          leaseExpiresAt: "2026-01-01T00:00:00.000Z",
        })
        .where(eq(workItems.id, started.workItemId))
        .run();
      recoverStaleLeases(t.handle, {});
      const claimed = claimNextWorkItem(t.handle, {
        workerId: "test-worker",
        kinds: ["TAILOR"],
        leaseDurationMs: 60_000,
        now: new Date().toISOString(),
      });
      expect(claimed?.id).toBe(started.workItemId);
      const handler = createTailorHandler({
        artifactsDir,
        provider: new TestProvider({ proposals: {} }),
        renderPdf: async (html) => stubRenderPdf(html),
      });
      return handler(handlerContext(t, started.workItemId));
    };
    const item = t.handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, started.workItemId))
      .get();
    const payload = JSON.parse(String(item?.payloadJson)) as Record<string, unknown>;

    const tampered = await runSeries(
      JSON.stringify({ ...payload, extractionId: newId() }),
    );
    expect(tampered).toMatchObject({ result: "BLOCKED", errorCode: "REQUEST_BINDING_MISMATCH" });
    // An executor whose bindings disagree can never run: the request
    // fails so the user can start a clean run instead of stranding.
    expect(readRequest(t, started.requestId)?.status).toBe("FAILED");

    const crossJob = await runSeries(
      JSON.stringify({ ...payload, jobId: newId() }),
    );
    expect(crossJob).toMatchObject({ result: "BLOCKED", errorCode: "REQUEST_JOB_MISMATCH" });

    // Both refusals land before begin: the job never moved.
    expect(readJob(t, jobId)?.tailoringState).toBe("PENDING");
  });

  it("records unbacked directive KPIs as gaps and keeps them off the resume", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, {
      jobId,
      observedRowVersion: 1,
      directives: "Managed teams of 200+ engineers.",
    });
    const outcome = await runHandler(t, artifactsDir, started.workItemId);
    expect(outcome.result).toBe("SUCCEEDED");
    const analyses = t.handle.db.select().from(jobAnalyses).where(eq(jobAnalyses.jobId, jobId)).all();
    const gaps = JSON.parse(analyses[0]?.gapsJson as string) as {
      gaps: Array<{ requirement_id: string; category: string; match_status: string; explanation?: string }>;
    };
    const directive = gaps.gaps.find((gap) => gap.category === "directive");
    expect(directive).toMatchObject({ requirement_id: "directive-0", match_status: "unsupported" });
    expect(directive?.explanation).toContain("200");
    const versions = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, jobId)).all();
    const markdown = t.handle.db
      .select()
      .from(resumeArtifacts)
      .where(eq(resumeArtifacts.resumeVersionId, versions[0]?.id as string))
      .all()
      .find((row) => row.kind === "MARKDOWN");
    const bytes = readFileSync(join(artifactsDir, String(markdown?.relativePath)), "utf8");
    expect(bytes).not.toContain("200");
  });

  it("backfills missing salary before the fenced run", async () => {
    const { t, artifactsDir } = setup();
    importTestProfile(t);
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const snapshots = pinnedSnapshots(t, started.workItemId);
    const claimed = claimNextWorkItem(t.handle, {
      workerId: "test-worker",
      kinds: ["TAILOR"],
      leaseDurationMs: 60_000,
      now: new Date().toISOString(),
    });
    expect(claimed?.id).toBe(started.workItemId);
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
    const outcome = await handler(handlerContext(t, started.workItemId));
    expect(outcome.result).toBe("SUCCEEDED");
    const job = readJob(t, jobId);
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
    const { jobId } = seedJob(t, E2E_JD_TEXT);
    const started = startRun(t, { jobId, observedRowVersion: 1 });
    const snapshots = pinnedSnapshots(t, started.workItemId);
    const claimed = claimNextWorkItem(t.handle, {
      workerId: "test-worker",
      kinds: ["TAILOR"],
      leaseDurationMs: 60_000,
      now: new Date().toISOString(),
    });
    expect(claimed?.id).toBe(started.workItemId);
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
    const outcome = await handler(handlerContext(t, started.workItemId));
    expect(outcome.result).toBe("SUCCEEDED");
    expect(readJob(t, jobId)?.salaryText).toBeNull();
    expect(readJob(t, jobId)?.tailoringState).toBe("AWAITING_REVIEW");
  });
});
