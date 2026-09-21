// @vitest-environment node
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshotFacts,
  candidateSnapshots,
  createTestDatabase,
  generationRequests,
  intakeBatches,
  intakeItems,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  resumeClaimFacts,
  resumeClaims,
  resumeVersions,
  scrapeAttempts,
  utcNow,
  workAttempts,
  workItems,
  type TestDatabase,
} from "../../../src/db";
import { canonicalJson } from "../../../src/domain/canonical";
import {
  canonicalKeywordSet,
  generationRequestIdentity,
  hashGenerationRequest,
  SteeringSnapshotV1,
  TAILOR_QUEUE_SCHEMA_VERSION_V2,
} from "../../../src/tailoring/requests";

/** Run one test against a fresh isolated database, always cleaning up. */
export function runWithTestDb(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase();
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

export interface ResumeChain {
  jobId: string;
  otherJobId: string;
  batchId: string;
  intakeItemId: string;
  attemptId: string;
  extractionId: string;
  profileVersionId: string;
  otherProfileVersionId: string;
  approvedFactId: string;
  pendingFactId: string;
  outsiderFactId: string;
  snapshotId: string;
  jdSnapshotId: string;
  requestId: string;
  workItemId: string;
  workAttemptId: string;
  analysisId: string;
  resumeVersionId: string;
  claimId: string;
}

/**
 * Seed the smallest graph that reaches a cited resume claim: job, attempt,
 * extraction, profile version with approved/pending facts, snapshots,
 * analysis, resume version, and one claim citing one approved member fact.
 * Also seeds an outsider job, profile version, and fact for negative tests.
 */
export function seedResumeChain(t: TestDatabase): ResumeChain {
  const { db } = t.handle;
  const now = utcNow();
  const chain: ResumeChain = {
    jobId: newId(),
    otherJobId: newId(),
    batchId: newId(),
    intakeItemId: newId(),
    attemptId: newId(),
    extractionId: newId(),
    profileVersionId: newId(),
    otherProfileVersionId: newId(),
    approvedFactId: `fact-approved-${newId().slice(0, 8)}`,
    pendingFactId: `fact-pending-${newId().slice(0, 8)}`,
    outsiderFactId: `fact-outsider-${newId().slice(0, 8)}`,
    snapshotId: newId(),
    jdSnapshotId: newId(),
    requestId: newId(),
    workItemId: newId(),
    workAttemptId: newId(),
    analysisId: newId(),
    resumeVersionId: newId(),
    claimId: newId(),
  };

  db.insert(jobs).values({ id: chain.jobId }).run();
  db.insert(jobs).values({ id: chain.otherJobId }).run();
  db.insert(intakeBatches).values({ id: chain.batchId }).run();
  db.insert(intakeItems)
    .values({
      id: chain.intakeItemId,
      batchId: chain.batchId,
      lineNumber: 1,
      rawInput: "https://example.com/jobs/1",
      outcome: "ENQUEUED",
      canonicalUrl: "https://example.com/jobs/1",
      jobId: chain.jobId,
    })
    .run();
  db.insert(scrapeAttempts)
    .values({
      id: chain.attemptId,
      intakeItemId: chain.intakeItemId,
      jobId: chain.jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: now,
      finishedAt: now,
      outcome: "SUCCEEDED",
    })
    .run();
  db.insert(jobExtractions)
    .values({
      id: chain.extractionId,
      jobId: chain.jobId,
      scrapeAttemptId: chain.attemptId,
      version: 1,
      schemaVersion: "extraction-v1",
      adapter: "generic",
      extractedJson: "{}",
    })
    .run();

  db.insert(candidateProfiles)
    .values({ id: "local", name: "default", displayName: "Primary Profile", isDefault: true })
    .run();
  db.insert(candidateProfileVersions)
    .values({
      id: chain.profileVersionId,
      profileId: "local",
      version: 1,
      payloadJson: "{}",
      payloadHash: "payload-hash-1",
      schemaVersion: "profile-v1",
    })
    .run();
  db.insert(candidateProfileVersions)
    .values({
      id: chain.otherProfileVersionId,
      profileId: "local",
      version: 2,
      payloadJson: "{}",
      payloadHash: "payload-hash-2",
      schemaVersion: "profile-v1",
    })
    .run();
  db.insert(candidateFacts)
    .values({
      factId: chain.approvedFactId,
      profileVersionId: chain.profileVersionId,
      kind: "ACHIEVEMENT",
      statement: "Shipped the thing.",
      verification: "APPROVED",
    })
    .run();
  db.insert(candidateFacts)
    .values({
      factId: chain.pendingFactId,
      profileVersionId: chain.profileVersionId,
      kind: "ACHIEVEMENT",
      statement: "Draft claim.",
      verification: "PENDING",
    })
    .run();
  db.insert(candidateFacts)
    .values({
      factId: chain.outsiderFactId,
      profileVersionId: chain.otherProfileVersionId,
      kind: "ACHIEVEMENT",
      statement: "Belongs to another version.",
      verification: "APPROVED",
    })
    .run();
  db.insert(candidateSnapshots)
    .values({
      id: chain.snapshotId,
      profileVersionId: chain.profileVersionId,
      canonicalJson: "{}",
      schemaVersion: "snapshot-v1",
      sha256: "snapshot-hash-1",
    })
    .run();
  db.insert(candidateSnapshotFacts)
    .values({ snapshotId: chain.snapshotId, factId: chain.approvedFactId })
    .run();
  db.insert(candidateSnapshotFacts)
    .values({ snapshotId: chain.snapshotId, factId: chain.pendingFactId })
    .run();

  db.insert(jdSnapshots)
    .values({
      id: chain.jdSnapshotId,
      jobId: chain.jobId,
      extractionId: chain.extractionId,
      jdText: "We need a builder.",
      canonicalSha256: "jd-hash-1",
    })
    .run();
  // D9 durable linkage: the queue item, request, and attempt the
  // analysis and version below must reference.
  const chainIdentity = generationRequestIdentity(chain.requestId);
  const chainKeywords = canonicalKeywordSet(["builder"]);
  const chainSteering = SteeringSnapshotV1.parse({
    schemaVersion: "generation-steering/v1",
    profileId: "local",
    profileVersionId: chain.profileVersionId,
    profileName: "default",
    profileDisplayName: "Primary Profile",
    executiveNarrative: null,
    targetTitles: [],
    targetLocations: [],
    careerKeywords: [],
    workMode: [],
    workAuthorization: [],
    sponsorshipRequired: null,
    willingToRelocate: null,
    yearsOfExperience: null,
  });
  const chainPayloadHash = hashGenerationRequest({
    requestIdentity: chainIdentity,
    jobId: chain.jobId,
    extractionId: chain.extractionId,
    profileId: "local",
    profileVersionId: chain.profileVersionId,
    jdSnapshotId: chain.jdSnapshotId,
    parentVersionId: null,
    requestKind: "INITIAL",
    steeringSnapshot: chainSteering,
    selectedKeywords: chainKeywords,
    directivesText: null,
    revisionNote: null,
  });
  db.insert(workItems)
    .values({
      id: chain.workItemId,
      kind: "TAILOR",
      idempotencyKey: chainIdentity,
      jobId: chain.jobId,
      payloadJson: canonicalJson({
        schemaVersion: TAILOR_QUEUE_SCHEMA_VERSION_V2,
        generationRequestId: chain.requestId,
        jobId: chain.jobId,
        extractionId: chain.extractionId,
        profileId: "local",
        profileVersionId: chain.profileVersionId,
        jdSnapshotId: chain.jdSnapshotId,
        payloadHash: chainPayloadHash,
      }),
      state: "SUCCEEDED",
      attemptCount: 1,
      maxAttempts: 3,
    })
    .run();
  db.insert(generationRequests)
    .values({
      id: chain.requestId,
      requestIdentity: chainIdentity,
      jobId: chain.jobId,
      extractionId: chain.extractionId,
      profileId: "local",
      profileVersionId: chain.profileVersionId,
      jdSnapshotId: chain.jdSnapshotId,
      parentVersionId: null,
      requestKind: "INITIAL",
      steeringSnapshotJson: canonicalJson(chainSteering),
      selectedKeywordsJson: canonicalJson(chainKeywords),
      directivesText: null,
      revisionNote: null,
      payloadHash: chainPayloadHash,
      status: "SUCCEEDED",
      workItemId: chain.workItemId,
      startedAt: now,
      finishedAt: now,
    })
    .run();
  db.insert(workAttempts)
    .values({
      id: chain.workAttemptId,
      workItemId: chain.workItemId,
      attemptNumber: 1,
      workerId: "chain-seed",
      startedAt: now,
      finishedAt: now,
      result: "SUCCEEDED",
    })
    .run();
  db.insert(jobAnalyses)
    .values({
      id: chain.analysisId,
      jobId: chain.jobId,
      jdSnapshotId: chain.jdSnapshotId,
      candidateSnapshotId: chain.snapshotId,
      requirementsJson: "[]",
      gapsJson: "[]",
      promptVersion: "prompt-v1",
      proposalSchemaVersion: "proposal-v1",
      generationRequestId: chain.requestId,
      workAttemptId: chain.workAttemptId,
    })
    .run();
  db.insert(resumeVersions)
    .values({
      id: chain.resumeVersionId,
      jobId: chain.jobId,
      version: 1,
      analysisId: chain.analysisId,
      templateId: "standard",
      templateVersion: "v1",
      templateHash: "template-hash",
      rankerVersion: "ranker-v1",
      policyVersion: "policy-v1",
      configVersion: "config-v1",
      renderSchemaVersion: "render-v1",
      contentJson: "{}",
      contentHash: "content-hash-1",
      generationRequestId: chain.requestId,
      workAttemptId: chain.workAttemptId,
    })
    .run();
  db.insert(resumeClaims)
    .values({
      id: chain.claimId,
      resumeVersionId: chain.resumeVersionId,
      claimText: "Shipped the thing.",
    })
    .run();
  db.insert(resumeClaimFacts)
    .values({ claimId: chain.claimId, factId: chain.approvedFactId })
    .run();

  return chain;
}

export interface SeededRequest {
  requestId: string;
  workItemId: string;
}

/**
 * Seed one more QUEUED generation request (+ its v2 queue item) for
 * negative tests that need a distinct request identity without
 * executing a run.
 */
export function seedExtraRequest(
  t: TestDatabase,
  chain: ResumeChain,
  overrides: { requestKind?: "INITIAL" | "NEW_VERSION" | "REVISION"; parentVersionId?: string | null } = {},
): SeededRequest {
  const { db } = t.handle;
  const now = utcNow();
  const requestId = newId();
  const workItemId = newId();
  const identity = generationRequestIdentity(requestId);
  const keywords = canonicalKeywordSet(["builder"]);
  const steering = SteeringSnapshotV1.parse({
    schemaVersion: "generation-steering/v1",
    profileId: "local",
    profileVersionId: chain.profileVersionId,
    profileName: "default",
    profileDisplayName: "Primary Profile",
    executiveNarrative: null,
    targetTitles: [],
    targetLocations: [],
    careerKeywords: [],
    workMode: [],
    workAuthorization: [],
    sponsorshipRequired: null,
    willingToRelocate: null,
    yearsOfExperience: null,
  });
  const payloadHash = hashGenerationRequest({
    requestIdentity: identity,
    jobId: chain.jobId,
    extractionId: chain.extractionId,
    profileId: "local",
    profileVersionId: chain.profileVersionId,
    jdSnapshotId: chain.jdSnapshotId,
    parentVersionId: overrides.parentVersionId ?? null,
    requestKind: overrides.requestKind ?? "INITIAL",
    steeringSnapshot: steering,
    selectedKeywords: keywords,
    directivesText: null,
    revisionNote: null,
  });
  db.insert(workItems)
    .values({
      id: workItemId,
      kind: "TAILOR",
      idempotencyKey: identity,
      jobId: chain.jobId,
      // Terminal history: the one-live-TAILOR index forbids a second
      // live item for the chain job. Linkage tests only need the
      // request row below.
      state: "SUCCEEDED",
      attemptCount: 1,
      maxAttempts: 3,
      payloadJson: canonicalJson({
        schemaVersion: TAILOR_QUEUE_SCHEMA_VERSION_V2,
        generationRequestId: requestId,
        jobId: chain.jobId,
        extractionId: chain.extractionId,
        profileId: "local",
        profileVersionId: chain.profileVersionId,
        jdSnapshotId: chain.jdSnapshotId,
        payloadHash,
      }),
    })
    .run();
  db.insert(generationRequests)
    .values({
      id: requestId,
      requestIdentity: identity,
      jobId: chain.jobId,
      extractionId: chain.extractionId,
      profileId: "local",
      profileVersionId: chain.profileVersionId,
      jdSnapshotId: chain.jdSnapshotId,
      parentVersionId: overrides.parentVersionId ?? null,
      requestKind: overrides.requestKind ?? "INITIAL",
      steeringSnapshotJson: canonicalJson(steering),
      selectedKeywordsJson: canonicalJson(keywords),
      directivesText: null,
      revisionNote: null,
      payloadHash,
      workItemId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { requestId, workItemId };
}
