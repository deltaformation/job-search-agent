// @vitest-environment node
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createTestDatabase,
  jobExtractions,
  jobs,
  newId,
  scrapeAttempts,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { createProfile, listSnapshotFacts, setFactVerification } from "../../../src/db/candidates";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateSnapshots,
} from "../../../src/db/schema";
import { CandidateProfilePayloadV1, CandidateSnapshotV1 } from "../../../src/domain/candidate";
import { canonicalJson } from "../../../src/domain/canonical";
import { sha256HexUtf8 } from "../../../src/db/utils";
import {
  activateProfileVersion,
  getActiveProfile,
  getOrCreateCandidateSnapshot,
  getOrCreateJdSnapshot,
  importCandidate,
  resolveCurrentSnapshots,
} from "../../../src/server/candidates";

const NOW = "2026-09-11T12:00:00.000Z";

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-candidates-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function fixtureDocument(): unknown {
  const path = join(process.cwd(), "tests", "fixtures", "candidate", "master-resume.v1.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function seedJobWithExtraction(
  handle: DatabaseHandle,
  overrides: { descriptionText?: string | null; linkExtraction?: boolean } = {},
): { jobId: string; extractionId: string } {
  const jobId = newId();
  const attemptId = newId();
  const extractionId = newId();
  handle.db.insert(jobs).values({ id: jobId }).run();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId,
      canonicalUrl: "https://example.com/jobs/1",
      startedAt: NOW,
      finishedAt: NOW,
      outcome: "SUCCEEDED",
    })
    .run();
  handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "extraction-v1",
      adapter: "generic",
      extractedJson: "{}",
    })
    .run();
  handle.db
    .update(jobs)
    .set({
      descriptionText: overrides.descriptionText ?? "Build things.\r\nShip them.",
      activeExtractionId: overrides.linkExtraction === false ? null : extractionId,
    })
    .where(eq(jobs.id, jobId))
    .run();
  return { jobId, extractionId };
}

function importFixture(handle: DatabaseHandle, document: unknown = fixtureDocument()) {
  const result = importCandidate(handle, { document, actor: "human", now: NOW });
  if (!result.ok) {
    throw new Error(`fixture import failed: ${result.error}`);
  }
  return result;
}

describe("importCandidate", () => {
  it("stores an immutable version with stable fact_id values", () => {
    withDatabase((t) => {
      const result = importFixture(t.handle);
      expect(result.version).toBe(1);
      expect(result.insertedFacts).toEqual([
        "fact_001",
        "fact_002",
        "fact_003",
        "fact_004",
        "fact_005",
        "fact_006",
      ]);
      expect(result.reusedFacts).toEqual([]);
      const stored = t.handle.db
        .select()
        .from(candidateProfileVersions)
        .where(eq(candidateProfileVersions.id, result.versionId))
        .get();
      expect(stored?.version).toBe(1);
      expect(stored?.activatedAt).toBeNull();
      const payload = CandidateProfilePayloadV1.parse(JSON.parse(stored?.payloadJson ?? ""));
      expect(payload.schemaVersion).toBe("candidate-profile/v1");
      expect(stored?.payloadHash).toBe(sha256HexUtf8(canonicalJson(payload)));
    });
  });

  it("numbers versions sequentially and reuses byte-identical facts", () => {
    withDatabase((t) => {
      const first = importFixture(t.handle);
      const second = importFixture(t.handle);
      expect(second.version).toBe(2);
      expect(second.insertedFacts).toEqual([]);
      expect(second.reusedFacts).toHaveLength(6);
      expect(first.versionId).not.toBe(second.versionId);
    });
  });

  it("rejects conflicting fact_id reuse without writing anything", () => {
    withDatabase((t) => {
      importFixture(t.handle);
      const document = fixtureDocument() as Record<string, unknown>;
      const achievements = document.achievements as Array<Record<string, unknown>>;
      achievements[0] = { ...achievements[0], text: "Rewritten history." };
      const result = importCandidate(t.handle, { document, actor: "human", now: NOW });
      expect(result).toMatchObject({ ok: false, error: "fact-id-conflict", factId: "fact_001" });
      const versions = t.handle.db.select().from(candidateProfileVersions).all();
      expect(versions).toHaveLength(1);
    });
  });

  it("throws ZodError on schema violations and accepts zero achievements", () => {
    withDatabase((t) => {
      expect(() =>
        importCandidate(t.handle, { document: { nope: true }, actor: "human" }),
      ).toThrow(z.ZodError);
      const result = importCandidate(t.handle, {
        document: {
          schemaVersion: "candidate-import/v1",
          identity: { fullName: "Skills Only" },
        },
        actor: "human",
      });
      expect(result.ok).toBe(true);
    });
  });
});

describe("activateProfileVersion", () => {
  it("selects exactly one active version and is idempotent", () => {
    withDatabase((t) => {
      const first = importFixture(t.handle);
      const second = importFixture(t.handle);
      expect(getActiveProfile(t.handle)).toBeNull();
      const activated = activateProfileVersion(t.handle, {
        versionId: first.versionId,
        actor: "human",
        now: NOW,
      });
      expect(activated).toMatchObject({ ok: true, version: 1, alreadyActive: false });
      expect(getActiveProfile(t.handle)?.versionId).toBe(first.versionId);
      const switched = activateProfileVersion(t.handle, { version: 2, actor: "human", now: NOW });
      expect(switched).toMatchObject({
        ok: true,
        versionId: second.versionId,
        alreadyActive: false,
      });
      expect(getActiveProfile(t.handle)?.versionId).toBe(second.versionId);
      const repeated = activateProfileVersion(t.handle, { version: 2, actor: "human", now: NOW });
      expect(repeated).toMatchObject({ ok: true, alreadyActive: true });
    });
  });

  it("returns not-found for unknown versions", () => {
    withDatabase((t) => {
      expect(
        activateProfileVersion(t.handle, { versionId: newId(), actor: "human" }),
      ).toEqual({ ok: false, error: "version-not-found" });
    });
  });
});

describe("getOrCreateCandidateSnapshot", () => {
  it("binds approved facts with stable canonical bytes and membership", () => {
    withDatabase((t) => {
      const imported = importFixture(t.handle);
      const first = getOrCreateCandidateSnapshot(t.handle, {
        profileVersionId: imported.versionId,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.created).toBe(true);
      const stored = t.handle.db
        .select()
        .from(candidateSnapshots)
        .where(eq(candidateSnapshots.id, first.snapshotId))
        .get();
      const snapshot = CandidateSnapshotV1.parse(JSON.parse(stored?.canonicalJson ?? ""));
      expect(snapshot.version).toBe(1);
      expect(snapshot.facts.map((fact) => fact.factId)).toEqual([
        "fact_001",
        "fact_002",
        "fact_003",
        "fact_004",
        "fact_005",
        "fact_006",
      ]);
      expect(stored?.sha256).toBe(sha256HexUtf8(canonicalJson(snapshot)));
      expect(listSnapshotFacts(t.handle, first.snapshotId)).toHaveLength(6);
      const second = getOrCreateCandidateSnapshot(t.handle, {
        profileVersionId: imported.versionId,
      });
      expect(second).toEqual({ ...first, created: false });
    });
  });

  it("excludes pending facts from the bound set", () => {
    withDatabase((t) => {
      const document = fixtureDocument() as Record<string, unknown>;
      const achievements = document.achievements as Array<Record<string, unknown>>;
      achievements[0] = { ...achievements[0], verification: "PENDING" };
      const imported = importFixture(t.handle, document);
      const result = getOrCreateCandidateSnapshot(t.handle, {
        profileVersionId: imported.versionId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(listSnapshotFacts(t.handle, result.snapshotId).map((fact) => fact.factId)).toEqual([
        "fact_002",
        "fact_003",
        "fact_004",
        "fact_005",
        "fact_006",
      ]);
    });
  });

  it("returns version-not-found for unknown versions", () => {
    withDatabase((t) => {
      expect(getOrCreateCandidateSnapshot(t.handle, { profileVersionId: newId() })).toEqual({
        ok: false,
        error: "version-not-found",
      });
    });
  });
});

describe("getOrCreateJdSnapshot", () => {
  it("canonicalizes text and reuses identical snapshots", () => {
    withDatabase((t) => {
      const { jobId, extractionId } = seedJobWithExtraction(t.handle);
      const first = getOrCreateJdSnapshot(t.handle, {
        jobId,
        extractionId,
        jdText: "  Build things.\r\nShip them. ",
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.created).toBe(true);
      expect(first.sha256).toBe(sha256HexUtf8("Build things.\nShip them."));
      const second = getOrCreateJdSnapshot(t.handle, {
        jobId,
        extractionId,
        jdText: "Build things.\nShip them.",
      });
      expect(second).toEqual({ ...first, created: false });
      const changed = getOrCreateJdSnapshot(t.handle, {
        jobId,
        extractionId,
        jdText: "Build different things.",
      });
      expect(changed.ok && changed.created).toBe(true);
    });
  });

  it("fails closed on empty text and mismatched lineage", () => {
    withDatabase((t) => {
      const { jobId, extractionId } = seedJobWithExtraction(t.handle);
      const other = seedJobWithExtraction(t.handle);
      expect(
        getOrCreateJdSnapshot(t.handle, { jobId, extractionId, jdText: " \r\n " }),
      ).toMatchObject({ ok: false, error: "empty-jd" });
      expect(
        getOrCreateJdSnapshot(t.handle, { jobId: newId(), extractionId, jdText: "x" }),
      ).toEqual({ ok: false, error: "job-not-found" });
      expect(
        getOrCreateJdSnapshot(t.handle, { jobId, extractionId: newId(), jdText: "x" }),
      ).toEqual({ ok: false, error: "extraction-not-found" });
      expect(
        getOrCreateJdSnapshot(t.handle, { jobId, extractionId: other.extractionId, jdText: "x" }),
      ).toEqual({ ok: false, error: "extraction-job-mismatch" });
    });
  });
});

describe("resolveCurrentSnapshots", () => {
  it("resolves and reuses both current snapshots", () => {
    withDatabase((t) => {
      const { jobId } = seedJobWithExtraction(t.handle);
      const imported = importFixture(t.handle);
      activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human", now: NOW });
      const first = resolveCurrentSnapshots(t.handle, jobId);
      expect(first).toMatchObject({ ok: true, jdCreated: true, candidateCreated: true });
      const second = resolveCurrentSnapshots(t.handle, jobId);
      expect(second).toMatchObject({ ok: true, jdCreated: false, candidateCreated: false });
      if (first.ok && second.ok) {
        expect(second.jdSnapshotId).toBe(first.jdSnapshotId);
        expect(second.candidateSnapshotId).toBe(first.candidateSnapshotId);
      }
    });
  });

  it("reports PROFILE_REQUIRED, missing extraction text, and unknown jobs", () => {
    withDatabase((t) => {
      const { jobId } = seedJobWithExtraction(t.handle);
      expect(resolveCurrentSnapshots(t.handle, jobId)).toMatchObject({
        ok: false,
        error: "blocked",
        reason: "PROFILE_REQUIRED",
      });
      const imported = importFixture(t.handle);
      activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human", now: NOW });
      const bare = seedJobWithExtraction(t.handle, { descriptionText: null, linkExtraction: false });
      expect(resolveCurrentSnapshots(t.handle, bare.jobId)).toMatchObject({
        ok: false,
        error: "blocked",
        reason: "EXTRACTION_INCOMPLETE",
      });
      expect(resolveCurrentSnapshots(t.handle, newId())).toEqual({
        ok: false,
        error: "job-not-found",
      });
    });
  });

  it("binds an explicit profile's active version instead of the default", () => {
    withDatabase((t) => {
      const { jobId } = seedJobWithExtraction(t.handle);
      createProfile(t.handle, { name: "empty-default", displayName: "Empty Default" });
      const second = createProfile(t.handle, { name: "second", displayName: "Second" });
      const imported = importCandidate(t.handle, {
        document: fixtureDocument(),
        actor: "human",
        now: NOW,
        profileId: second.id,
      });
      expect(imported.ok).toBe(true);
      if (!imported.ok) {
        throw new Error(`fixture import failed: ${imported.error}`);
      }
      activateProfileVersion(t.handle, { versionId: imported.versionId, actor: "human", now: NOW });
      // The default profile has no versions, so unscoped resolution blocks ...
      expect(resolveCurrentSnapshots(t.handle, jobId)).toMatchObject({
        ok: false,
        error: "blocked",
        reason: "PROFILE_REQUIRED",
      });
      // ... while the explicit profile resolves, and a deleted one is stale.
      expect(resolveCurrentSnapshots(t.handle, jobId, { profileId: second.id })).toMatchObject({
        ok: true,
      });
      expect(resolveCurrentSnapshots(t.handle, jobId, { profileId: "gone" })).toMatchObject({
        ok: false,
        error: "blocked",
        reason: "STALE_INPUT",
      });
    });
  });
});

describe("fact review and immutability", () => {
  it("approves pending facts once and then freezes them", () => {
    withDatabase((t) => {
      const document = fixtureDocument() as Record<string, unknown>;
      const achievements = document.achievements as Array<Record<string, unknown>>;
      achievements[0] = { ...achievements[0], verification: "PENDING" };
      importFixture(t.handle, document);
      expect(setFactVerification(t.handle, "fact_001", "APPROVED")).toBe(true);
      expect(setFactVerification(t.handle, "fact_001", "REJECTED")).toBe(false);
      expect(() =>
        t.handle.db
          .update(candidateFacts)
          .set({ statement: "Tampered." })
          .where(eq(candidateFacts.factId, "fact_001"))
          .run(),
      ).toThrow(/approved candidate facts are immutable/);
      expect(setFactVerification(t.handle, "fact-nope", "APPROVED")).toBe(false);
    });
  });
});
