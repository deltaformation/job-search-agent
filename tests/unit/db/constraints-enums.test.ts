// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applications,
  candidateFacts,
  candidateProfiles,
  intakeBatches,
  intakeItems,
  jobExtractions,
  jobs,
  newId,
  resumeArtifacts,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  sourceArtifacts,
  utcNow,
  workItems,
  workflowEvents,
} from "../../../src/db";
import { runWithTestDb, seedResumeChain } from "./helpers";

describe("enum and range CHECK constraints", () => {
  it("rejects unknown board, scrape, tailoring, and arrangement states", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      expect(() =>
        db.insert(jobs).values({ id: newId(), status: "NOPE" }).run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db.insert(jobs).values({ id: newId(), scrapeState: "MAYBE" }).run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db.insert(jobs).values({ id: newId(), tailoringState: "SOON" }).run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db.insert(jobs).values({ id: newId(), arrangement: "MOON" }).run(),
      ).toThrow(/CHECK constraint/i);
      // NULL arrangement stays allowed for unknown values.
      const id = newId();
      db.insert(jobs).values({ id, arrangement: null }).run();
    });
  });

  it("rejects bad salary, rank inputs and row versions", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      expect(() =>
        db.insert(jobs).values({ id: newId(), salaryMinMinor: -1 }).run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(jobs)
          .values({ id: newId(), salaryMinMinor: 200, salaryMaxMinor: 100 })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db.insert(jobs).values({ id: newId(), rowVersion: 0 }).run(),
      ).toThrow(/CHECK constraint/i);
    });
  });

  it("rejects unknown intake outcomes, attempt results, and artifact kinds", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      const batchId = newId();
      db.insert(intakeBatches).values({ id: batchId }).run();
      expect(() =>
        db
          .insert(intakeItems)
          .values({
            id: newId(),
            batchId,
            lineNumber: 1,
            rawInput: "x",
            outcome: "SORT_OF",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(scrapeAttempts)
          .values({
            id: newId(),
            canonicalUrl: "https://example.com/",
            startedAt: utcNow(),
            outcome: "PARTIAL",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      const attemptId = newId();
      db.insert(scrapeAttempts)
        .values({
          id: attemptId,
          canonicalUrl: "https://example.com/",
          startedAt: utcNow(),
          outcome: "SUCCEEDED",
        })
        .run();
      expect(() =>
        db
          .insert(sourceArtifacts)
          .values({
            id: newId(),
            scrapeAttemptId: attemptId,
            kind: "VIDEO",
            relativePath: "evidence/x",
            mediaType: "video/mp4",
            byteSize: 10,
            sha256: "abc",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
    });
  });

  it("requires a lease if and only if a work item is RUNNING", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      expect(() =>
        db
          .insert(workItems)
          .values({
            id: newId(),
            kind: "SCRAPE",
            idempotencyKey: `k-${newId()}`,
            state: "RUNNING",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(workItems)
          .values({
            id: newId(),
            kind: "SCRAPE",
            idempotencyKey: `k-${newId()}`,
            state: "QUEUED",
            leaseToken: "stale-lease",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(workItems)
          .values({
            id: newId(),
            kind: "EMAIL",
            idempotencyKey: `k-${newId()}`,
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      // RUNNING with a lease is the one legal combination with a lease.
      db.insert(workItems)
        .values({
          id: newId(),
          kind: "TAILOR",
          idempotencyKey: `k-${newId()}`,
          state: "RUNNING",
          leaseToken: "lease-1",
        })
        .run();
    });
  });

  it("rejects unknown verification, review, and workflow states", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .insert(candidateFacts)
          .values({
            factId: `fact-${newId().slice(0, 8)}`,
            profileVersionId: chain.profileVersionId,
            kind: "ACHIEVEMENT",
            statement: "x",
            verification: "MAYBE",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(workflowEvents)
          .values({
            id: newId(),
            jobId: chain.jobId,
            actor: "human",
            fromStatus: "NEW",
            toStatus: "GONE",
            rowVersion: 2,
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(resumeArtifacts)
          .values({
            id: newId(),
            resumeVersionId: chain.resumeVersionId,
            kind: "XLSX",
            relativePath: "artifacts/x",
            mediaType: "x",
            byteSize: 1,
            sha256: "x",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        db
          .insert(resumeReviews)
          .values({
            id: newId(),
            resumeVersionId: chain.resumeVersionId,
            action: "MAYBE_LATER",
            actor: "human",
            resumeHash: "h",
            contentHash: "h",
            artifactHashesJson: "{}",
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
    });
  });

  it("only humans may record applications", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      expect(() =>
        db
          .insert(applications)
          .values({
            id: newId(),
            jobId: chain.jobId,
            recordedBy: "agent",
            appliedAt: utcNow(),
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
      db.insert(applications)
        .values({ id: newId(), jobId: chain.jobId, appliedAt: utcNow() })
        .run();
    });
  });

  it("allows multiple career profiles with unique names and one default", () => {
    runWithTestDb((t) => {
      // The legacy single-row CHECK is gone: a second profile inserts cleanly.
      t.handle.db
        .insert(candidateProfiles)
        .values({ id: "local", name: "default", displayName: "Primary Profile", isDefault: true })
        .run();
      t.handle.db
        .insert(candidateProfiles)
        .values({ id: "em", name: "eng-manager", displayName: "EM", isDefault: false })
        .run();
      expect(() =>
        t.handle.db
          .insert(candidateProfiles)
          .values({ id: "x", name: "eng-manager", displayName: "X", isDefault: false })
          .run(),
      ).toThrow(/UNIQUE constraint failed/i);
      expect(() =>
        t.handle.db
          .insert(candidateProfiles)
          .values({ id: "y", name: "other", displayName: "Y", isDefault: true })
          .run(),
      ).toThrow(/UNIQUE constraint failed/i);
    });
  });

  it("rejects out-of-range extraction confidence", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      const attemptId = newId();
      db.insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId: chain.jobId,
          canonicalUrl: "https://example.com/2",
          startedAt: utcNow(),
          outcome: "SUCCEEDED",
        })
        .run();
      expect(() =>
        db
          .insert(jobExtractions)
          .values({
            id: newId(),
            jobId: chain.jobId,
            scrapeAttemptId: attemptId,
            version: 2,
            schemaVersion: "extraction-v1",
            adapter: "generic",
            extractedJson: "{}",
            confidence: 2,
          })
          .run(),
      ).toThrow(/CHECK constraint/i);
    });
  });

  it("accepts every documented review state on resume versions", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      for (const reviewState of [
        "AWAITING_REVIEW",
        "REVISION_REQUESTED",
        "FAILED",
        "DRAFT",
      ] as const) {
        db.update(resumeVersions)
          .set({ reviewState })
          .where(eq(resumeVersions.id, chain.resumeVersionId))
          .run();
      }
      expect(() =>
        db
          .update(resumeVersions)
          .set({ reviewState: "PUBLISHED" })
          .where(eq(resumeVersions.id, chain.resumeVersionId))
          .run(),
      ).toThrow(/CHECK constraint/i);
    });
  });
});
