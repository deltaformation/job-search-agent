// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applications,
  candidateProfileVersions,
  intakeBatches,
  intakeItems,
  jdSnapshots,
  jobExtractions,
  jobSources,
  jobs,
  newId,
  resumeArtifacts,
  resumeVersions,
  scrapeAttempts,
  utcNow,
  workAttempts,
  workItems,
} from "../../../src/db";
import { runWithTestDb, seedResumeChain } from "./helpers";

describe("uniqueness constraints", () => {
  it("dedupes intake lines, canonical keys, and queue idempotency keys", () => {
    runWithTestDb((t) => {
      const { db } = t.handle;
      const batchId = newId();
      db.insert(intakeBatches).values({ id: batchId }).run();
      const item = {
        batchId,
        lineNumber: 1,
        rawInput: "https://example.com/jobs/1",
      };
      db.insert(intakeItems).values({ id: newId(), ...item }).run();
      expect(() =>
        db.insert(intakeItems).values({ id: newId(), ...item }).run(),
      ).toThrow(/UNIQUE constraint/i);

      const jobId = newId();
      db.insert(jobs).values({ id: jobId }).run();
      const source = {
        jobId,
        submittedUrl: "https://example.com/jobs/1?utm=x",
        canonicalUrl: "https://example.com/jobs/1",
        canonicalKey: "example.com/jobs/1",
      };
      db.insert(jobSources).values({ id: newId(), ...source }).run();
      expect(() =>
        db.insert(jobSources).values({ id: newId(), ...source }).run(),
      ).toThrow(/UNIQUE constraint/i);

      const key = `idem-${newId()}`;
      db.insert(workItems)
        .values({ id: newId(), kind: "SCRAPE", idempotencyKey: key })
        .run();
      expect(() =>
        db
          .insert(workItems)
          .values({ id: newId(), kind: "SCRAPE", idempotencyKey: key })
          .run(),
      ).toThrow(/UNIQUE constraint/i);
    });
  });

  it("versions extractions, attempts, snapshots, resumes, and artifacts", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;

      // One extraction per attempt; one row per (job, version).
      expect(() =>
        db
          .insert(jobExtractions)
          .values({
            id: newId(),
            jobId: chain.jobId,
            scrapeAttemptId: chain.attemptId,
            version: 2,
            schemaVersion: "extraction-v1",
            adapter: "generic",
            extractedJson: "{}",
          })
          .run(),
      ).toThrow(/UNIQUE constraint/i);

      // One row per (job, jd hash).
      expect(() =>
        db
          .insert(jdSnapshots)
          .values({
            id: newId(),
            jobId: chain.jobId,
            extractionId: chain.extractionId,
            jdText: "We need a builder.",
            canonicalSha256: "jd-hash-1",
          })
          .run(),
      ).toThrow(/UNIQUE constraint/i);

      // One row per (job, resume version).
      expect(() =>
        db
          .insert(resumeVersions)
          .values({
            id: newId(),
            jobId: chain.jobId,
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
            contentHash: "other",
          })
          .run(),
      ).toThrow(/UNIQUE constraint/i);

      // One artifact per (version, kind).
      const artifact = {
        resumeVersionId: chain.resumeVersionId,
        kind: "MARKDOWN" as const,
        relativePath: "artifacts/v1.md",
        mediaType: "text/markdown",
        byteSize: 12,
        sha256: "artifact-hash",
      };
      db.insert(resumeArtifacts).values({ id: newId(), ...artifact }).run();
      expect(() =>
        db.insert(resumeArtifacts).values({ id: newId(), ...artifact }).run(),
      ).toThrow(/UNIQUE constraint/i);

      // One attempt row per (item, number).
      const itemId = newId();
      db.insert(workItems)
        .values({ id: itemId, kind: "SCRAPE", idempotencyKey: `k-${newId()}` })
        .run();
      const attempt = {
        workItemId: itemId,
        attemptNumber: 1,
        startedAt: utcNow(),
        result: "FAILED" as const,
      };
      db.insert(workAttempts).values({ id: newId(), ...attempt }).run();
      expect(() =>
        db.insert(workAttempts).values({ id: newId(), ...attempt }).run(),
      ).toThrow(/UNIQUE constraint/i);

      // One application row per job.
      db.insert(applications)
        .values({ id: newId(), jobId: chain.jobId, appliedAt: utcNow() })
        .run();
      expect(() =>
        db
          .insert(applications)
          .values({ id: newId(), jobId: chain.jobId, appliedAt: utcNow() })
          .run(),
      ).toThrow(/UNIQUE constraint/i);
    });
  });

  it("keeps exactly one activated profile version", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      db.update(candidateProfileVersions)
        .set({ activatedAt: utcNow() })
        .where(eq(candidateProfileVersions.id, chain.profileVersionId))
        .run();
      expect(() =>
        db
          .update(candidateProfileVersions)
          .set({ activatedAt: utcNow() })
          .where(eq(candidateProfileVersions.id, chain.otherProfileVersionId))
          .run(),
      ).toThrow(/UNIQUE constraint/i);
      // Deactivating first, then activating the other, is the legal rotation.
      db.update(candidateProfileVersions)
        .set({ activatedAt: null })
        .where(eq(candidateProfileVersions.id, chain.profileVersionId))
        .run();
      db.update(candidateProfileVersions)
        .set({ activatedAt: utcNow() })
        .where(eq(candidateProfileVersions.id, chain.otherProfileVersionId))
        .run();
    });
  });

  it("allows distinct versions and kinds side by side", () => {
    runWithTestDb((t) => {
      const chain = seedResumeChain(t);
      const { db } = t.handle;
      const attemptId = newId();
      db.insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId: chain.jobId,
          canonicalUrl: "https://example.com/3",
          startedAt: utcNow(),
          outcome: "SUCCEEDED",
        })
        .run();
      db.insert(jobExtractions)
        .values({
          id: newId(),
          jobId: chain.jobId,
          scrapeAttemptId: attemptId,
          version: 2,
          schemaVersion: "extraction-v1",
          adapter: "generic",
          extractedJson: "{}",
        })
        .run();
      db.insert(resumeArtifacts)
        .values({
          id: newId(),
          resumeVersionId: chain.resumeVersionId,
          kind: "PDF",
          relativePath: "artifacts/v1.pdf",
          mediaType: "application/pdf",
          byteSize: 99,
          sha256: "pdf-hash",
        })
        .run();
    });
  });
});
