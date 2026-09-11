// @vitest-environment node
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshotFacts,
  candidateSnapshots,
  createTestDatabase,
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
  type TestDatabase,
} from "../../../src/db";

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

  db.insert(candidateProfiles).values({ id: "local" }).run();
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
