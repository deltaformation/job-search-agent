// @vitest-environment node
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applications,
  candidateFacts,
  candidateProfileVersions,
  candidateSnapshotFacts,
  candidateSnapshots,
  generationRequests,
  intakeBatches,
  intakeItems,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobNotes,
  jobSources,
  jobs,
  newId,
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  sourceArtifacts,
  utcNow,
  workAttempts,
  workItems,
  workflowEvents,
} from "../../../src/db";
import { runWithTestDb, seedResumeChain } from "./helpers";

describe("immutability and append-only guards", () => {
  it("freezes evidence, snapshots, analyses, claims, artifacts, and logs", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;

      // Append-only event/attempt logs reject updates and deletes.
      const eventId = newId();
      db.insert(workflowEvents)
        .values({
          id: eventId,
          jobId: chain.jobId,
          actor: "human",
          fromStatus: null,
          toStatus: "NEW",
          rowVersion: 1,
        })
        .run();
      expect(() =>
        db
          .update(workflowEvents)
          .set({ reason: "rewrite history" })
          .where(eq(workflowEvents.id, eventId))
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        db.delete(workflowEvents).where(eq(workflowEvents.id, eventId)).run(),
      ).toThrow(/append-only/);

      const itemId = newId();
      db.insert(workItems)
        .values({ id: itemId, kind: "SCRAPE", idempotencyKey: `k-${newId()}` })
        .run();
      const workAttemptId = newId();
      db.insert(workAttempts)
        .values({
          id: workAttemptId,
          workItemId: itemId,
          attemptNumber: 1,
          startedAt: utcNow(),
          result: "SUCCEEDED",
        })
        .run();
      // Terminal rows are frozen; only the RUNNING → terminal finish is
      // allowed, exactly once.
      expect(() =>
        db
          .update(workAttempts)
          .set({ result: "FAILED" })
          .where(eq(workAttempts.id, workAttemptId))
          .run(),
      ).toThrow(/exactly once/);
      const runningAttemptId = newId();
      db.insert(workAttempts)
        .values({
          id: runningAttemptId,
          workItemId: itemId,
          attemptNumber: 2,
          startedAt: utcNow(),
          result: "RUNNING",
        })
        .run();
      // Frozen columns reject even on a live row.
      expect(() =>
        db
          .update(workAttempts)
          .set({ workerId: "worker-b" })
          .where(eq(workAttempts.id, runningAttemptId))
          .run(),
      ).toThrow(/exactly once/);
      db.update(workAttempts)
        .set({ result: "SUCCEEDED", finishedAt: utcNow() })
        .where(eq(workAttempts.id, runningAttemptId))
        .run();
      expect(() =>
        db
          .update(workAttempts)
          .set({ result: "FAILED" })
          .where(eq(workAttempts.id, runningAttemptId))
          .run(),
      ).toThrow(/exactly once/);

      expect(() =>
        db
          .update(scrapeAttempts)
          .set({ outcome: "FAILED" })
          .where(eq(scrapeAttempts.id, chain.attemptId))
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        db
          .delete(scrapeAttempts)
          .where(eq(scrapeAttempts.id, chain.attemptId))
          .run(),
      ).toThrow(/append-only/);

      // Immutable content rows reject updates and deletes.
      expect(() =>
        db
          .update(jobExtractions)
          .set({ extractedJson: "{}" })
          .where(eq(jobExtractions.id, chain.extractionId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .update(candidateSnapshots)
          .set({ canonicalJson: "{}" })
          .where(eq(candidateSnapshots.id, chain.snapshotId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .update(jdSnapshots)
          .set({ jdText: "edited" })
          .where(eq(jdSnapshots.id, chain.jdSnapshotId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .update(jobAnalyses)
          .set({ rationale: "edited" })
          .where(eq(jobAnalyses.id, chain.analysisId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .update(resumeClaims)
          .set({ claimText: "edited" })
          .where(eq(resumeClaims.id, chain.claimId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .delete(resumeClaimFacts)
          .where(
            and(
              eq(resumeClaimFacts.claimId, chain.claimId),
              eq(resumeClaimFacts.factId, chain.approvedFactId),
            ),
          )
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .delete(candidateSnapshotFacts)
          .where(
            and(
              eq(candidateSnapshotFacts.snapshotId, chain.snapshotId),
              eq(candidateSnapshotFacts.factId, chain.approvedFactId),
            ),
          )
          .run(),
      ).toThrow(/immutable/);

      const artifactId = newId();
      db.insert(resumeArtifacts)
        .values({
          id: artifactId,
          resumeVersionId: chain.resumeVersionId,
          kind: "MARKDOWN",
          relativePath: "artifacts/v1.md",
          mediaType: "text/markdown",
          byteSize: 3,
          sha256: "md-hash",
        })
        .run();
      expect(() =>
        db
          .update(resumeArtifacts)
          .set({ byteSize: 4 })
          .where(eq(resumeArtifacts.id, artifactId))
          .run(),
      ).toThrow(/immutable/);

      const sourceArtifactId = newId();
      db.insert(sourceArtifacts)
        .values({
          id: sourceArtifactId,
          scrapeAttemptId: chain.attemptId,
          kind: "HTML",
          relativePath: "evidence/x.html",
          mediaType: "text/html",
          byteSize: 5,
          sha256: "html-hash",
        })
        .run();
      expect(() =>
        db
          .delete(sourceArtifacts)
          .where(eq(sourceArtifacts.id, sourceArtifactId))
          .run(),
      ).toThrow(/immutable/);

      const reviewId = newId();
      db.insert(resumeReviews)
        .values({
          id: reviewId,
          resumeVersionId: chain.resumeVersionId,
          action: "APPROVED",
          actor: "human",
          resumeHash: "h",
          contentHash: "content-hash-1",
          artifactHashesJson: "{}",
        })
        .run();
      expect(() =>
        db
          .update(resumeReviews)
          .set({ note: "edited" })
          .where(eq(resumeReviews.id, reviewId))
          .run(),
      ).toThrow(/append-only/);
    });
  });

  it("blocks deletes of jobs, intake, sources, queue items, and applications", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db.delete(jobs).where(eq(jobs.id, chain.jobId)).run(),
      ).toThrow(/cannot be deleted/);
      expect(() =>
        db
          .delete(intakeItems)
          .where(eq(intakeItems.id, chain.intakeItemId))
          .run(),
      ).toThrow(/cannot be deleted/);
      expect(() =>
        db.delete(intakeBatches).where(eq(intakeBatches.id, chain.batchId)).run(),
      ).toThrow(/cannot be deleted/);

      const sourceId = newId();
      db.insert(jobSources)
        .values({
          id: sourceId,
          jobId: chain.jobId,
          submittedUrl: "https://example.com/jobs/1",
          canonicalUrl: "https://example.com/jobs/1",
          canonicalKey: `key-${newId()}`,
        })
        .run();
      expect(() =>
        db.delete(jobSources).where(eq(jobSources.id, sourceId)).run(),
      ).toThrow(/cannot be deleted/);
      // Merging repoints the source row instead of deleting it.
      db.update(jobSources)
        .set({ jobId: chain.otherJobId })
        .where(eq(jobSources.id, sourceId))
        .run();

      const itemId = newId();
      db.insert(workItems)
        .values({ id: itemId, kind: "SCRAPE", idempotencyKey: `k-${newId()}` })
        .run();
      expect(() =>
        db.delete(workItems).where(eq(workItems.id, itemId)).run(),
      ).toThrow(/cannot be deleted/);

      const applicationId = newId();
      db.insert(applications)
        .values({ id: applicationId, jobId: chain.jobId, appliedAt: utcNow() })
        .run();
      expect(() =>
        db.delete(applications).where(eq(applications.id, applicationId)).run(),
      ).toThrow(/cannot be deleted/);
      // Correcting a confirmation number stays allowed.
      db.update(applications)
        .set({ confirmationNumber: "ABC-123" })
        .where(eq(applications.id, applicationId))
        .run();
    });
  });

  it("lets profile versions activate but never change payload", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .update(candidateProfileVersions)
          .set({ payloadJson: "{\"edited\":true}" })
          .where(eq(candidateProfileVersions.id, chain.profileVersionId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .delete(candidateProfileVersions)
          .where(eq(candidateProfileVersions.id, chain.profileVersionId))
          .run(),
      ).toThrow(/cannot be deleted/);
      db.update(candidateProfileVersions)
        .set({ activatedAt: utcNow() })
        .where(eq(candidateProfileVersions.id, chain.profileVersionId))
        .run();
    });
  });

  it("freezes approved facts while drafts stay editable", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .update(candidateFacts)
          .set({ statement: "edited" })
          .where(eq(candidateFacts.factId, chain.approvedFactId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .delete(candidateFacts)
          .where(eq(candidateFacts.factId, chain.approvedFactId))
          .run(),
      ).toThrow(/cannot be deleted/);
      // Draft facts can be refined, approved, and then they freeze too.
      db.update(candidateFacts)
        .set({ statement: "Refined draft." })
        .where(eq(candidateFacts.factId, chain.pendingFactId))
        .run();
      db.update(candidateFacts)
        .set({ verification: "APPROVED" })
        .where(eq(candidateFacts.factId, chain.pendingFactId))
        .run();
      expect(() =>
        db
          .update(candidateFacts)
          .set({ statement: "too late" })
          .where(eq(candidateFacts.factId, chain.pendingFactId))
          .run(),
      ).toThrow(/immutable/);
    });
  });

  it("lets resume review state advance until approval, then freezes", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .update(resumeVersions)
          .set({ contentJson: "{\"edited\":true}" })
          .where(eq(resumeVersions.id, chain.resumeVersionId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .update(resumeVersions)
          .set({ templateVersion: "v2" })
          .where(eq(resumeVersions.id, chain.resumeVersionId))
          .run(),
      ).toThrow(/immutable/);
      db.update(resumeVersions)
        .set({ reviewState: "AWAITING_REVIEW" })
        .where(eq(resumeVersions.id, chain.resumeVersionId))
        .run();
      db.update(resumeVersions)
        .set({ reviewState: "APPROVED" })
        .where(eq(resumeVersions.id, chain.resumeVersionId))
        .run();
      expect(() =>
        db
          .update(resumeVersions)
          .set({ reviewState: "DRAFT" })
          .where(eq(resumeVersions.id, chain.resumeVersionId))
          .run(),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .delete(resumeVersions)
          .where(eq(resumeVersions.id, chain.resumeVersionId))
          .run(),
      ).toThrow(/cannot be deleted/);
    });
  });

  it("keeps user notes editable", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      const noteId = newId();
      db.insert(jobNotes)
        .values({ id: noteId, jobId: chain.jobId, body: "first" })
        .run();
      db.update(jobNotes)
        .set({ body: "second" })
        .where(eq(jobNotes.id, noteId))
        .run();
      db.delete(jobNotes).where(eq(jobNotes.id, noteId)).run();
    });
  });
});

describe("v1.2 generation guards (D9)", () => {
  it("refuses legacy TAILOR inserts while SCRAPE rows pass through", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      // Old-binary exclusion: a pre-D process enqueueing v1 work (or no
      // payload at all) fails loudly at the database boundary.
      expect(() =>
        db
          .insert(workItems)
          .values({
            id: newId(),
            kind: "TAILOR",
            idempotencyKey: `legacy-${newId()}`,
            payloadJson: JSON.stringify({
              schemaVersion: "tailor-queue/v1",
              jobId: newId(),
              extractionId: newId(),
            }),
          })
          .run(),
      ).toThrow(/UNSUPPORTED_TAILOR_PAYLOAD/);
      expect(() =>
        db
          .insert(workItems)
          .values({
            id: newId(),
            kind: "TAILOR",
            idempotencyKey: `legacy-${newId()}`,
            payloadJson: null,
          })
          .run(),
      ).toThrow(/UNSUPPORTED_TAILOR_PAYLOAD/);
      db
        .insert(workItems)
        .values({ id: newId(), kind: "SCRAPE", idempotencyKey: `scrape-${newId()}` })
        .run();
    });
  });

  it("rejects analyses and versions without durable linkage", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .insert(jobAnalyses)
          .values({
            id: newId(),
            jobId: chain.jobId,
            jdSnapshotId: chain.jdSnapshotId,
            candidateSnapshotId: chain.snapshotId,
            requirementsJson: "{}",
            gapsJson: "{}",
            promptVersion: "tailor-prompt/v1",
            proposalSchemaVersion: "resume-proposal/v1",
          })
          .run(),
      ).toThrow(/new analyses require generation_request_id and work_attempt_id/);
      expect(() =>
        db
          .insert(resumeVersions)
          .values({
            id: newId(),
            jobId: chain.jobId,
            version: 9,
            analysisId: chain.analysisId,
            templateId: "standard",
            templateVersion: "v1",
            templateHash: "t",
            rankerVersion: "ranker-v1",
            policyVersion: "policy-v1",
            configVersion: "config-v1",
            renderSchemaVersion: "render-v1",
            contentJson: "{}",
            contentHash: "c",
          })
          .run(),
      ).toThrow(/new resume versions require generation_request_id and work_attempt_id/);
    });
  });

  it("freezes generation request bindings and forbids request deletion", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .update(generationRequests)
          .set({ directivesText: "tampered after the fact" })
          .where(eq(generationRequests.id, chain.requestId))
          .run(),
      ).toThrow(/bindings and guidance are immutable/);
      expect(() =>
        db.delete(generationRequests).where(eq(generationRequests.id, chain.requestId)).run(),
      ).toThrow(/cannot be deleted/);
      // Execution bookkeeping stays writable: status moves are the only
      // post-insert mutation the worker needs.
      db
        .update(generationRequests)
        .set({ status: "RUNNING", startedAt: utcNow() })
        .where(eq(generationRequests.id, chain.requestId))
        .run();
    });
  });
});
