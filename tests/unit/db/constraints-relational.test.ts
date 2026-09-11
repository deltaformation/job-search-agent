// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  candidateFacts,
  candidateSnapshotFacts,
  candidateSnapshots,
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
} from "../../../src/db";
import { runWithTestDb, seedResumeChain } from "./helpers";

describe("foreign keys and ownership guards", () => {
  it("rejects rows pointing at missing parents", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      expect(() =>
        db
          .insert(intakeItems)
          .values({
            id: newId(),
            batchId: newId(),
            lineNumber: 1,
            rawInput: "x",
          })
          .run(),
      ).toThrow(/FOREIGN KEY/i);
      expect(() =>
        db.insert(jobs).values({ id: newId() }).run(),
      ).not.toThrow();
    });
  });

  it("keeps active pointers on the same job", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;

      // Same-job pointers are accepted.
      db.update(jobs)
        .set({ activeExtractionId: chain.extractionId })
        .where(eq(jobs.id, chain.jobId))
        .run();
      db.update(jobs)
        .set({ activeResumeVersionId: chain.resumeVersionId })
        .where(eq(jobs.id, chain.jobId))
        .run();

      // Cross-job and dangling pointers are rejected.
      expect(() =>
        db
          .update(jobs)
          .set({ activeExtractionId: chain.extractionId })
          .where(eq(jobs.id, chain.otherJobId))
          .run(),
      ).toThrow(/same job/);
      expect(() =>
        db
          .update(jobs)
          .set({ activeResumeVersionId: chain.resumeVersionId })
          .where(eq(jobs.id, chain.otherJobId))
          .run(),
      ).toThrow(/same job/);
      expect(() =>
        db
          .update(jobs)
          .set({ activeExtractionId: newId() })
          .where(eq(jobs.id, chain.jobId))
          .run(),
      ).toThrow(/same job/);
    });
  });

  it("allows clearing active pointers back to NULL", () => {
    runWithTestDb((t) => {
        const chain = seedResumeChain(t);
        const { db } = t.handle;

        // Clearing from a set pointer succeeds for both columns.
        db.update(jobs)
          .set({ activeResumeVersionId: chain.resumeVersionId })
          .where(eq(jobs.id, chain.jobId))
          .run();
        db.update(jobs)
          .set({ activeResumeVersionId: null })
          .where(eq(jobs.id, chain.jobId))
          .run();
        db.update(jobs)
          .set({ activeExtractionId: chain.extractionId })
          .where(eq(jobs.id, chain.jobId))
          .run();
        db.update(jobs)
          .set({ activeExtractionId: null })
          .where(eq(jobs.id, chain.jobId))
          .run();

        // Explicitly writing NULL over NULL also succeeds: the ownership
        // guard must not fire when there is no pointer to check.
        db.update(jobs)
          .set({ activeResumeVersionId: null })
          .where(eq(jobs.id, chain.otherJobId))
          .run();
        db.update(jobs)
          .set({ activeExtractionId: null })
          .where(eq(jobs.id, chain.otherJobId))
          .run();
    });
  });

  it("keeps snapshots, analyses, and versions on the same job", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;

      expect(() =>
        db
          .insert(jdSnapshots)
          .values({
            id: newId(),
            jobId: chain.otherJobId,
            extractionId: chain.extractionId,
            jdText: "cross-job",
            canonicalSha256: "cross-jd",
          })
          .run(),
      ).toThrow(/same job/);

      expect(() =>
        db
          .insert(jobAnalyses)
          .values({
            id: newId(),
            jobId: chain.otherJobId,
            jdSnapshotId: chain.jdSnapshotId,
            candidateSnapshotId: chain.snapshotId,
            requirementsJson: "[]",
            gapsJson: "[]",
            promptVersion: "prompt-v1",
            proposalSchemaVersion: "proposal-v1",
          })
          .run(),
      ).toThrow(/same job/);

      expect(() =>
        db
          .insert(resumeVersions)
          .values({
            id: newId(),
            jobId: chain.otherJobId,
            version: 1,
            analysisId: chain.analysisId,
            templateId: "standard",
            templateVersion: "v1",
            templateHash: "h",
            rankerVersion: "r",
            policyVersion: "p",
            configVersion: "c",
            renderSchemaVersion: "render-v1",
            contentJson: "{}",
            contentHash: "cross",
          })
          .run(),
      ).toThrow(/same job/);

      // A child version of another job cannot parent this job's version.
      const foreignAnalysisId = newId();
      const foreignBatchId = newId();
      db.insert(intakeBatches).values({ id: foreignBatchId }).run();
      const foreignAttemptId = newId();
      db.insert(scrapeAttempts)
        .values({
          id: foreignAttemptId,
          jobId: chain.otherJobId,
          canonicalUrl: "https://example.com/other",
          startedAt: utcNow(),
          outcome: "SUCCEEDED",
        })
        .run();
      const foreignExtractionId = newId();
      db.insert(jobExtractions)
        .values({
          id: foreignExtractionId,
          jobId: chain.otherJobId,
          scrapeAttemptId: foreignAttemptId,
          version: 1,
          schemaVersion: "extraction-v1",
          adapter: "generic",
          extractedJson: "{}",
        })
        .run();
      const foreignJdId = newId();
      db.insert(jdSnapshots)
        .values({
          id: foreignJdId,
          jobId: chain.otherJobId,
          extractionId: foreignExtractionId,
          jdText: "other",
          canonicalSha256: "other-jd",
        })
        .run();
      db.insert(jobAnalyses)
        .values({
          id: foreignAnalysisId,
          jobId: chain.otherJobId,
          jdSnapshotId: foreignJdId,
          candidateSnapshotId: chain.snapshotId,
          requirementsJson: "[]",
          gapsJson: "[]",
          promptVersion: "prompt-v1",
          proposalSchemaVersion: "proposal-v1",
        })
        .run();
      const foreignVersionId = newId();
      db.insert(resumeVersions)
        .values({
          id: foreignVersionId,
          jobId: chain.otherJobId,
          version: 1,
          analysisId: foreignAnalysisId,
          templateId: "standard",
          templateVersion: "v1",
          templateHash: "h",
          rankerVersion: "r",
          policyVersion: "p",
          configVersion: "c",
          renderSchemaVersion: "render-v1",
          contentJson: "{}",
          contentHash: "foreign",
        })
        .run();
      expect(() =>
        db
          .insert(resumeVersions)
          .values({
            id: newId(),
            jobId: chain.jobId,
            version: 2,
            parentVersionId: foreignVersionId,
            analysisId: chain.analysisId,
            templateId: "standard",
            templateVersion: "v1",
            templateHash: "h",
            rankerVersion: "r",
            policyVersion: "p",
            configVersion: "c",
            renderSchemaVersion: "render-v1",
            contentJson: "{}",
            contentHash: "child",
          })
          .run(),
      ).toThrow(/same job/);
    });
  });

  it("only admits snapshot members from the snapshot profile version", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      // The outsider fact is approved but belongs to another profile version.
      expect(() =>
        db
          .insert(candidateSnapshotFacts)
          .values({ snapshotId: chain.snapshotId, factId: chain.outsiderFactId })
          .run(),
      ).toThrow(/snapshot profile version/);
    });
  });

  it("only lets claims cite approved member facts of the bound snapshot", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;

      // Non-member fact, even though approved: rejected.
      const outsiderSnapshotId = newId();
      db.insert(candidateSnapshots)
        .values({
          id: outsiderSnapshotId,
          profileVersionId: chain.otherProfileVersionId,
          canonicalJson: "{}",
          schemaVersion: "snapshot-v1",
          sha256: "outsider-snapshot",
        })
        .run();
      db.insert(candidateSnapshotFacts)
        .values({ snapshotId: outsiderSnapshotId, factId: chain.outsiderFactId })
        .run();
      const outsiderClaimId = newId();
      db.insert(resumeClaims)
        .values({
          id: outsiderClaimId,
          resumeVersionId: chain.resumeVersionId,
          claimText: "Outsider claim.",
        })
        .run();
      expect(() =>
        db
          .insert(resumeClaimFacts)
          .values({ claimId: outsiderClaimId, factId: chain.outsiderFactId })
          .run(),
      ).toThrow(/not a member/);

      // Member but not approved: rejected.
      const pendingClaimId = newId();
      db.insert(resumeClaims)
        .values({
          id: pendingClaimId,
          resumeVersionId: chain.resumeVersionId,
          claimText: "Pending claim.",
        })
        .run();
      expect(() =>
        db
          .insert(resumeClaimFacts)
          .values({ claimId: pendingClaimId, factId: chain.pendingFactId })
          .run(),
      ).toThrow(/not approved/);

      // Unknown fact id: rejected as well (the BEFORE INSERT membership
      // trigger fires before foreign-key enforcement, so its message wins).
      expect(() =>
        db
          .insert(resumeClaimFacts)
          .values({ claimId: pendingClaimId, factId: "fact-missing" })
          .run(),
      ).toThrow(/not a member/);

      // Approving the pending member fact unblocks its citation.
      db.update(candidateFacts)
        .set({ verification: "APPROVED" })
        .where(eq(candidateFacts.factId, chain.pendingFactId))
        .run();
      db.insert(resumeClaimFacts)
        .values({ claimId: pendingClaimId, factId: chain.pendingFactId })
        .run();
    });
  });
});
