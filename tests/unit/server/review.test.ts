// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  candidateFacts,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshotFacts,
  candidateSnapshots,
  createTestDatabase,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobs,
  newId,
  resumeArtifacts,
  resumeClaimFacts,
  resumeClaims,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  workItems,
  workflowEvents,
  type TestDatabase,
} from "../../../src/db";
import {
  approveResume,
  getResumeArtifact,
  getResumeReviewView,
  requestRevision,
  resumeIdentityHash,
} from "../../../src/server/review";
import { tailorRevisionIdempotencyKey } from "../../../src/tailoring/enqueue";

/**
 * R4-F review command tests: exact-version approval with artifact
 * re-hashing, revision requests with atomic follow-up enqueue, the
 * side-by-side review projection, and the full rejection matrix. Each
 * test seeds one reviewable version with real artifact bytes on disk.
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
  const t = createTestDatabase("review-service-");
  testDbs.push(t);
  const artifactsDir = mkdtempSync(join(tmpdir(), "review-service-artifacts-"));
  tempDirs.push(artifactsDir);
  return { t, artifactsDir };
}

const NOW = "2026-09-11T12:00:00.000Z";
const VERSION_CONTENT_HASH = "c".repeat(64);

const REQUIREMENTS_JSON = JSON.stringify({
  schemaVersion: "analysis-requirements/v1",
  requirements: [
    {
      requirement_id: "req_api",
      jd_quote: "TypeScript API experience",
      category: "skill",
      importance: "required",
      match_status: "matched",
      evidence_fact_ids: ["f1"],
      evidence_quotes: ["Led the API migration."],
      review_status: "confirmed",
    },
    {
      requirement_id: "req_cache",
      jd_quote: "Redis caching",
      category: "skill",
      importance: "preferred",
      match_status: "partial",
      evidence_fact_ids: ["f1"],
      evidence_quotes: [],
      review_status: "proposed",
    },
  ],
});

const GAPS_JSON = JSON.stringify({
  schemaVersion: "analysis-gaps/v1",
  gaps: [
    {
      requirement_id: "req_k8s",
      jd_quote: "Kubernetes deployment",
      category: "skill",
      importance: "required",
      match_status: "gap",
    },
  ],
});

const CONTENT_JSON = JSON.stringify({
  schemaVersion: "resume-content/v1",
  summaryStrategy: "fact-grounded",
  omittedUnsupported: ["Kubernetes"],
  changeSummary: {
    addedBullets: ["Led the API migration to TypeScript."],
    removedBullets: ["Assisted with legacy maintenance."],
    summaryChanged: true,
    baselineLines: 40,
    tailoredLines: 44,
  },
  audit: {
    requirementsTotal: 3,
    supportedCount: 2,
    gapCount: 1,
    validatedClaims: 1,
    totalClaims: 1,
    rationale: "Two requirements supported by approved facts; one gap reported.",
    questions: ["Is the caching metric current?"],
  },
});

const ARTIFACT_BYTES: Record<string, Buffer> = {
  MARKDOWN: Buffer.from("# Tailored Resume\n\nLed the API migration to TypeScript.\n", "utf8"),
  DOCX: Buffer.from("PK-fake-docx-bytes-for-review-tests", "utf8"),
  PDF: Buffer.from("%PDF-1.4 fake-pdf-bytes-for-review-tests", "utf8"),
};

const ARTIFACT_MEDIA_TYPES: Record<string, string> = {
  MARKDOWN: "text/markdown; charset=utf-8",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PDF: "application/pdf",
};

interface SeedOptions {
  status?: string;
  tailoringState?: string;
  reviewState?: string;
  kinds?: string[];
  requirementsJson?: string;
  gapsJson?: string;
  contentJson?: string;
}

interface ReviewSeed {
  jobId: string;
  extractionId: string;
  versionId: string;
  analysisId: string;
  digests: Record<string, string>;
}

function seedReviewable(t: TestDatabase, artifactsDir: string, overrides: SeedOptions = {}): ReviewSeed {
  const kinds = overrides.kinds ?? ["MARKDOWN", "DOCX", "PDF"];
  const jobId = newId();
  t.handle.db
    .insert(jobs)
    .values({
      id: jobId,
      status: overrides.status ?? "NEW",
      rank: 0,
      rowVersion: 1,
      title: "Backend Engineer",
      company: "Acme",
      tailoringState: overrides.tailoringState ?? "AWAITING_REVIEW",
    })
    .run();
  t.handle.db
    .insert(candidateProfiles)
    .values({ id: "local", name: "default", displayName: "Primary Profile", isDefault: true })
    .run();
  const profileVersionId = newId();
  t.handle.db
    .insert(candidateProfileVersions)
    .values({
      id: profileVersionId,
      profileId: "local",
      version: 1,
      payloadJson: "{}",
      payloadHash: "0".repeat(64),
      schemaVersion: "candidate-profile-v1",
    })
    .run();
  t.handle.db
    .insert(candidateFacts)
    .values({
      factId: "f1",
      profileVersionId,
      kind: "experience",
      statement: "Led the API migration to TypeScript.",
      verification: "APPROVED",
    })
    .run();
  const candidateSnapshotId = newId();
  t.handle.db
    .insert(candidateSnapshots)
    .values({
      id: candidateSnapshotId,
      profileVersionId,
      canonicalJson: "{}",
      schemaVersion: "candidate-snapshot-v1",
      sha256: "1".repeat(64),
    })
    .run();
  t.handle.db.insert(candidateSnapshotFacts).values({ snapshotId: candidateSnapshotId, factId: "f1" }).run();
  const attemptId = newId();
  t.handle.db
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
  t.handle.db.update(jobs).set({ activeExtractionId: extractionId }).where(eq(jobs.id, jobId)).run();
  const jdSnapshotId = newId();
  t.handle.db
    .insert(jdSnapshots)
    .values({
      id: jdSnapshotId,
      jobId,
      extractionId,
      jdText: "TypeScript API experience and Redis caching. Kubernetes deployment.",
      canonicalSha256: "2".repeat(64),
    })
    .run();
  const analysisId = newId();
  t.handle.db
    .insert(jobAnalyses)
    .values({
      id: analysisId,
      jobId,
      jdSnapshotId,
      candidateSnapshotId,
      requirementsJson: overrides.requirementsJson ?? REQUIREMENTS_JSON,
      gapsJson: overrides.gapsJson ?? GAPS_JSON,
      provider: "test-provider",
      model: "test-model",
      promptVersion: "tailor-prompt/v1",
      proposalSchemaVersion: "resume-proposal/v1",
      rationale: "Two requirements supported by approved facts; one gap reported.",
    })
    .run();
  const versionId = newId();
  t.handle.db
    .insert(resumeVersions)
    .values({
      id: versionId,
      jobId,
      version: 1,
      parentVersionId: null,
      analysisId,
      templateId: "standard",
      templateVersion: "v1",
      templateHash: "t".repeat(64),
      rankerVersion: "ranker-v1",
      policyVersion: "policy-v1",
      configVersion: "config-v1",
      renderSchemaVersion: "render-v1",
      contentJson: overrides.contentJson ?? CONTENT_JSON,
      contentHash: VERSION_CONTENT_HASH,
      reviewState: overrides.reviewState ?? "AWAITING_REVIEW",
    })
    .run();
  t.handle.db.update(jobs).set({ activeResumeVersionId: versionId }).where(eq(jobs.id, jobId)).run();
  const claimId = newId();
  t.handle.db
    .insert(resumeClaims)
    .values({
      id: claimId,
      resumeVersionId: versionId,
      claimText: "Led the API migration to TypeScript.",
      requirementRef: "req_api",
      derivationKind: null,
      derivationPayload: null,
    })
    .run();
  t.handle.db.insert(resumeClaimFacts).values({ claimId, factId: "f1" }).run();
  const digests: Record<string, string> = {};
  const extensions: Record<string, string> = { MARKDOWN: "md", DOCX: "docx", PDF: "pdf" };
  for (const kind of kinds) {
    const bytes = ARTIFACT_BYTES[kind] as Buffer;
    const relativePath = `resumes/${jobId}/v1_${VERSION_CONTENT_HASH.slice(0, 8)}.${extensions[kind]}`;
    mkdirSync(join(artifactsDir, `resumes/${jobId}`), { recursive: true });
    writeFileSync(join(artifactsDir, relativePath), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    digests[kind] = sha256;
    t.handle.db
      .insert(resumeArtifacts)
      .values({
        id: newId(),
        resumeVersionId: versionId,
        kind,
        relativePath,
        mediaType: ARTIFACT_MEDIA_TYPES[kind] as string,
        byteSize: bytes.length,
        sha256,
      })
      .run();
  }
  return { jobId, extractionId, versionId, analysisId, digests };
}

/** Attach a v2 child (same analysis) and move the active pointer to it. */
function seedSecondVersion(
  t: TestDatabase,
  artifactsDir: string,
  seed: ReviewSeed,
  reviewState = "AWAITING_REVIEW",
): string {
  const versionId = newId();
  t.handle.db
    .insert(resumeVersions)
    .values({
      id: versionId,
      jobId: seed.jobId,
      version: 2,
      parentVersionId: seed.versionId,
      analysisId: seed.analysisId,
      templateId: "standard",
      templateVersion: "v1",
      templateHash: "t".repeat(64),
      rankerVersion: "ranker-v1",
      policyVersion: "policy-v1",
      configVersion: "config-v1",
      renderSchemaVersion: "render-v1",
      contentJson: CONTENT_JSON,
      contentHash: "d".repeat(64),
      reviewState,
    })
    .run();
  t.handle.db.update(jobs).set({ activeResumeVersionId: versionId }).where(eq(jobs.id, seed.jobId)).run();
  const extensions: Record<string, string> = { MARKDOWN: "md", DOCX: "docx", PDF: "pdf" };
  for (const kind of ["MARKDOWN", "DOCX", "PDF"]) {
    const bytes = Buffer.from(`v2-${kind.toLowerCase()}-bytes`, "utf8");
    const relativePath = `resumes/${seed.jobId}/v2_dddddddd.${extensions[kind]}`;
    writeFileSync(join(artifactsDir, relativePath), bytes);
    t.handle.db
      .insert(resumeArtifacts)
      .values({
        id: newId(),
        resumeVersionId: versionId,
        kind,
        relativePath,
        mediaType: ARTIFACT_MEDIA_TYPES[kind] as string,
        byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
      .run();
  }
  return versionId;
}

function readState(t: TestDatabase, jobId: string, versionId: string) {
  const job = t.handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const version = t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.id, versionId)).get();
  const reviews = t.handle.db
    .select()
    .from(resumeReviews)
    .where(eq(resumeReviews.resumeVersionId, versionId))
    .all();
  const events = t.handle.db.select().from(workflowEvents).where(eq(workflowEvents.jobId, jobId)).all();
  const work = t.handle.db.select().from(workItems).all();
  return { job, version, reviews, events, work };
}

describe("approveResume", () => {
  it("approves the exact version, binds hashes, and moves the card to Tailored", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const approved = approveResume(
      t.handle,
      {
        jobId: seed.jobId,
        resumeVersionId: seed.versionId,
        observedRowVersion: 1,
        actor: "human",
        note: "Claims match the evidence.",
        now: NOW,
      },
      { artifactsDir },
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved).toMatchObject({
      jobId: seed.jobId,
      resumeVersionId: seed.versionId,
      version: 1,
      newRowVersion: 2,
      contentHash: VERSION_CONTENT_HASH,
      artifactHashes: {
        markdown: seed.digests["MARKDOWN"],
        docx: seed.digests["DOCX"],
        pdf: seed.digests["PDF"],
      },
    });
    const state = readState(t, seed.jobId, seed.versionId);
    expect(state.job).toMatchObject({ status: "TAILORED", tailoringState: "APPROVED", rowVersion: 2 });
    expect(state.version?.reviewState).toBe("APPROVED");
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]).toMatchObject({
      id: approved.reviewId,
      action: "APPROVED",
      actor: "human",
      note: "Claims match the evidence.",
      resumeHash: approved.resumeHash,
      contentHash: VERSION_CONTENT_HASH,
    });
    // The recorded hashes are the re-computed digests, not client input.
    expect(JSON.parse(state.reviews[0]?.artifactHashesJson as string)).toEqual(approved.artifactHashes);
    if (state.version === undefined) {
      throw new Error("approved version is not readable");
    }
    expect(state.reviews[0]?.resumeHash).toBe(resumeIdentityHash(state.version));
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      id: approved.eventId,
      actor: "human",
      fromStatus: "NEW",
      toStatus: "TAILORED",
      rowVersion: 2,
      reason: "approval",
    });
  });

  it("rejects tampered artifact bytes and writes nothing", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const docx = t.handle.db
      .select()
      .from(resumeArtifacts)
      .where(eq(resumeArtifacts.resumeVersionId, seed.versionId))
      .all()
      .find((row) => row.kind === "DOCX");
    writeFileSync(join(artifactsDir, docx?.relativePath as string), Buffer.from("tampered-bytes", "utf8"));
    const approved = approveResume(
      t.handle,
      { jobId: seed.jobId, resumeVersionId: seed.versionId, observedRowVersion: 1, actor: "human" },
      { artifactsDir },
    );
    expect(approved).toMatchObject({ ok: false, error: "artifact-mismatch" });
    const state = readState(t, seed.jobId, seed.versionId);
    expect(state.job).toMatchObject({ status: "NEW", rowVersion: 1 });
    expect(state.version?.reviewState).toBe("AWAITING_REVIEW");
    expect(state.reviews).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("rejects missing files, missing rows, and stale versions without writing", () => {
    const missing = setup();
    const missingSeed = seedReviewable(missing.t, missing.artifactsDir);
    const pdf = missing.t.handle.db
      .select()
      .from(resumeArtifacts)
      .where(eq(resumeArtifacts.resumeVersionId, missingSeed.versionId))
      .all()
      .find((row) => row.kind === "PDF");
    rmSync(join(missing.artifactsDir, pdf?.relativePath as string));
    expect(
      approveResume(
        missing.t.handle,
        {
          jobId: missingSeed.jobId,
          resumeVersionId: missingSeed.versionId,
          observedRowVersion: 1,
          actor: "human",
        },
        { artifactsDir: missing.artifactsDir },
      ),
    ).toMatchObject({ ok: false, error: "artifact-unreadable" });

    const partial = setup();
    const partialSeed = seedReviewable(partial.t, partial.artifactsDir, { kinds: ["MARKDOWN", "DOCX"] });
    expect(
      approveResume(
        partial.t.handle,
        {
          jobId: partialSeed.jobId,
          resumeVersionId: partialSeed.versionId,
          observedRowVersion: 1,
          actor: "human",
        },
        { artifactsDir: partial.artifactsDir },
      ),
    ).toMatchObject({ ok: false, error: "artifact-incomplete" });

    const stale = setup();
    const staleSeed = seedReviewable(stale.t, stale.artifactsDir);
    const conflicted = approveResume(
      stale.t.handle,
      {
        jobId: staleSeed.jobId,
        resumeVersionId: staleSeed.versionId,
        observedRowVersion: 99,
        actor: "human",
      },
      { artifactsDir: stale.artifactsDir },
    );
    expect(conflicted).toMatchObject({ ok: false, error: "conflict", currentRowVersion: 1 });

    for (const [harness, s] of [
      [missing, missingSeed],
      [partial, partialSeed],
      [stale, staleSeed],
    ] as const) {
      const state = readState(harness.t, s.jobId, s.versionId);
      expect(state.job?.rowVersion).toBe(1);
      expect(state.version?.reviewState).toBe("AWAITING_REVIEW");
      expect(state.reviews).toHaveLength(0);
      expect(state.events).toHaveLength(0);
    }
  });

  it("rejects unknown ids, superseded versions, and repeat approvals", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    expect(
      approveResume(
        t.handle,
        { jobId: newId(), resumeVersionId: seed.versionId, observedRowVersion: 1, actor: "human" },
        { artifactsDir },
      ),
    ).toMatchObject({ ok: false, error: "unknown-job" });
    expect(
      approveResume(
        t.handle,
        { jobId: seed.jobId, resumeVersionId: newId(), observedRowVersion: 1, actor: "human" },
        { artifactsDir },
      ),
    ).toMatchObject({ ok: false, error: "unknown-version" });

    const v2 = seedSecondVersion(t, artifactsDir, seed);
    const superseded = approveResume(
      t.handle,
      { jobId: seed.jobId, resumeVersionId: seed.versionId, observedRowVersion: 1, actor: "human" },
      { artifactsDir },
    );
    expect(superseded).toMatchObject({ ok: false, error: "stale-version", currentRowVersion: 1 });

    const first = approveResume(
      t.handle,
      { jobId: seed.jobId, resumeVersionId: v2, observedRowVersion: 1, actor: "human", now: NOW },
      { artifactsDir },
    );
    expect(first.ok).toBe(true);
    const repeat = approveResume(
      t.handle,
      {
        jobId: seed.jobId,
        resumeVersionId: v2,
        observedRowVersion: 2,
        actor: "human",
        now: NOW,
      },
      { artifactsDir },
    );
    expect(repeat).toMatchObject({ ok: false, error: "forbidden" });
    const state = readState(t, seed.jobId, v2);
    expect(state.reviews).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it("refuses non-NEW jobs and non-human actors", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir, { status: "TAILORED" });
    const refused = approveResume(
      t.handle,
      { jobId: seed.jobId, resumeVersionId: seed.versionId, observedRowVersion: 1, actor: "human" },
      { artifactsDir },
    );
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });
    expect(() =>
      approveResume(
        t.handle,
        { jobId: seed.jobId, resumeVersionId: seed.versionId, observedRowVersion: 1, actor: "agent" },
        { artifactsDir },
      ),
    ).toThrow();
    const state = readState(t, seed.jobId, seed.versionId);
    expect(state.reviews).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});

describe("requestRevision", () => {
  it("freezes the version, records the note, and enqueues the follow-up run", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const revised = requestRevision(t.handle, {
      jobId: seed.jobId,
      resumeVersionId: seed.versionId,
      observedRowVersion: 1,
      actor: "human",
      note: "Second bullet overstates the caching work.",
      now: NOW,
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised).toMatchObject({
      jobId: seed.jobId,
      resumeVersionId: seed.versionId,
      version: 1,
      deduped: false,
      newRowVersion: 2,
    });
    const state = readState(t, seed.jobId, seed.versionId);
    expect(state.job).toMatchObject({
      status: "NEW",
      tailoringState: "REVISION_REQUESTED",
      rowVersion: 2,
    });
    expect(state.version?.reviewState).toBe("REVISION_REQUESTED");
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]).toMatchObject({
      id: revised.reviewId,
      action: "REVISION_REQUESTED",
      actor: "human",
      note: "Second bullet overstates the caching work.",
      contentHash: VERSION_CONTENT_HASH,
    });
    expect(state.work).toHaveLength(1);
    expect(state.work[0]).toMatchObject({
      id: revised.workItemId,
      kind: "TAILOR",
      state: "QUEUED",
      idempotencyKey: tailorRevisionIdempotencyKey(seed.jobId, seed.versionId),
    });
    expect(JSON.parse(state.work[0]?.payloadJson as string)).toMatchObject({
      jobId: seed.jobId,
      extractionId: seed.extractionId,
    });
  });

  it("rejects rejected jobs, missing notes, and conflicts without writing", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir, { status: "REJECTED" });
    const refused = requestRevision(t.handle, {
      jobId: seed.jobId,
      resumeVersionId: seed.versionId,
      observedRowVersion: 1,
      actor: "human",
      note: "Too late.",
    });
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });

    const fresh = setup();
    const freshSeed = seedReviewable(fresh.t, fresh.artifactsDir);
    const base = {
      jobId: freshSeed.jobId,
      resumeVersionId: freshSeed.versionId,
      observedRowVersion: 1,
      actor: "human" as const,
    };
    expect(() => requestRevision(fresh.t.handle, base)).toThrow();
    expect(() => requestRevision(fresh.t.handle, { ...base, note: "   " })).toThrow();
    const conflicted = requestRevision(fresh.t.handle, { ...base, note: "Note.", observedRowVersion: 7 });
    expect(conflicted).toMatchObject({ ok: false, error: "conflict", currentRowVersion: 1 });

    for (const [harness, s] of [[t, seed], [fresh.t, freshSeed]] as const) {
      const state = readState(harness, s.jobId, s.versionId);
      expect(state.reviews).toHaveLength(0);
      expect(state.work).toHaveLength(0);
      expect(state.version?.reviewState).toBe("AWAITING_REVIEW");
    }
  });

  it("revises despite damaged bytes but not missing rows", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const pdf = t.handle.db
      .select()
      .from(resumeArtifacts)
      .where(eq(resumeArtifacts.resumeVersionId, seed.versionId))
      .all()
      .find((row) => row.kind === "PDF");
    writeFileSync(join(artifactsDir, pdf?.relativePath as string), Buffer.from("corrupt", "utf8"));
    const revised = requestRevision(t.handle, {
      jobId: seed.jobId,
      resumeVersionId: seed.versionId,
      observedRowVersion: 1,
      actor: "human",
      note: "The PDF looks corrupt; regenerate.",
    });
    expect(revised.ok).toBe(true);
    // The revision binds the stored digests — the disk was never read.
    const state = readState(t, seed.jobId, seed.versionId);
    expect(JSON.parse(state.reviews[0]?.artifactHashesJson as string)).toEqual({
      markdown: seed.digests["MARKDOWN"],
      docx: seed.digests["DOCX"],
      pdf: seed.digests["PDF"],
    });

    const partial = setup();
    const partialSeed = seedReviewable(partial.t, partial.artifactsDir, { kinds: ["MARKDOWN"] });
    const incomplete = requestRevision(partial.t.handle, {
      jobId: partialSeed.jobId,
      resumeVersionId: partialSeed.versionId,
      observedRowVersion: 1,
      actor: "human",
      note: "Note.",
    });
    expect(incomplete).toMatchObject({ ok: false, error: "artifact-incomplete" });
    expect(readState(partial.t, partialSeed.jobId, partialSeed.versionId).work).toHaveLength(0);
  });
});

describe("resumeIdentityHash", () => {
  it("is deterministic and sensitive to every lineage field", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const version = t.handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, seed.versionId))
      .get();
    if (version === undefined) {
      throw new Error("seeded version is not readable");
    }
    const baseline = resumeIdentityHash(version);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(resumeIdentityHash({ ...version })).toBe(baseline);
    expect(resumeIdentityHash({ ...version, contentHash: "9".repeat(64) })).not.toBe(baseline);
    expect(resumeIdentityHash({ ...version, version: 2 })).not.toBe(baseline);
    expect(resumeIdentityHash({ ...version, templateHash: "8".repeat(64) })).not.toBe(baseline);
    expect(resumeIdentityHash({ ...version, parentVersionId: newId() })).not.toBe(baseline);
  });
});

describe("getResumeReviewView", () => {
  it("projects requirements, gaps, claims, changes, and actions", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const view = getResumeReviewView(t.handle, seed.versionId);
    expect(view).not.toBeNull();
    if (view === null) return;
    expect(view.job).toMatchObject({
      id: seed.jobId,
      status: "NEW",
      rowVersion: 1,
      tailoringState: "AWAITING_REVIEW",
      activeResumeVersionId: seed.versionId,
    });
    expect(view.version).toMatchObject({
      id: seed.versionId,
      version: 1,
      parentVersionId: null,
      reviewState: "AWAITING_REVIEW",
      contentHash: VERSION_CONTENT_HASH,
      templateId: "standard",
    });
    expect(view.analysis).toMatchObject({
      id: seed.analysisId,
      provider: "test-provider",
      model: "test-model",
      promptVersion: "tailor-prompt/v1",
    });
    expect(view.analysis?.requirements).toHaveLength(2);
    expect(view.analysis?.requirements[0]).toMatchObject({
      requirementId: "req_api",
      jdQuote: "TypeScript API experience",
      importance: "required",
      matchStatus: "matched",
      evidenceFactIds: ["f1"],
    });
    expect(view.analysis?.gaps).toHaveLength(1);
    expect(view.analysis?.gaps[0]).toMatchObject({
      requirementId: "req_k8s",
      jdQuote: "Kubernetes deployment",
      matchStatus: "gap",
    });
    expect(view.claims).toHaveLength(1);
    expect(view.claims[0]).toMatchObject({
      claimText: "Led the API migration to TypeScript.",
      requirementRef: "req_api",
    });
    expect(view.claims[0]?.facts).toEqual([
      { factId: "f1", statement: "Led the API migration to TypeScript.", kind: "experience" },
    ]);
    expect(view.content).toMatchObject({
      summaryStrategy: "fact-grounded",
      omittedUnsupported: ["Kubernetes"],
    });
    expect(view.content?.changeSummary).toMatchObject({
      addedBullets: ["Led the API migration to TypeScript."],
      removedBullets: ["Assisted with legacy maintenance."],
      summaryChanged: true,
    });
    expect(view.content?.audit).toMatchObject({
      requirementsTotal: 3,
      supportedCount: 2,
      gapCount: 1,
      validatedClaims: 1,
      totalClaims: 1,
    });
    expect(view.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["DOCX", "MARKDOWN", "PDF"]);
    expect("relativePath" in (view.artifacts[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(view.reviews).toHaveLength(0);
    expect(view.actions).toEqual({ canApprove: true, canRequestRevision: true, reason: null });
    // Artifact metadata resolves by id for the file route.
    const markdown = view.artifacts.find((artifact) => artifact.kind === "MARKDOWN");
    const file = getResumeArtifact(t.handle, markdown?.id as string);
    expect(file).toMatchObject({ kind: "MARKDOWN", sha256: seed.digests["MARKDOWN"] });
    expect(getResumeArtifact(t.handle, newId())).toBeNull();
  });

  it("returns null for unknown versions and degrades corrupt sections", () => {
    const { t, artifactsDir } = setup();
    expect(getResumeReviewView(t.handle, newId())).toBeNull();
    const seed = seedReviewable(t, artifactsDir, {
      requirementsJson: "{not json",
      contentJson: "[1,2,",
    });
    const view = getResumeReviewView(t.handle, seed.versionId);
    expect(view).not.toBeNull();
    expect(view?.analysis).toBeNull();
    expect(view?.content).toBeNull();
    // Corrupt sections do not take down the claims or the actions.
    expect(view?.claims).toHaveLength(1);
    expect(view?.actions.canApprove).toBe(true);
  });

  it("disables actions for superseded and decided versions", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir);
    const v2 = seedSecondVersion(t, artifactsDir, seed, "REVISION_REQUESTED");
    const oldView = getResumeReviewView(t.handle, seed.versionId);
    expect(oldView?.actions.canApprove).toBe(false);
    expect(oldView?.actions.canRequestRevision).toBe(false);
    expect(oldView?.actions.reason).toMatch(/newer resume version/i);
    const newView = getResumeReviewView(t.handle, v2);
    expect(newView?.actions.reason).toMatch(/REVISION_REQUESTED/);
  });

  it("audits top keywords with placements against the stored draft", () => {
    const { t, artifactsDir } = setup();
    const base = JSON.parse(CONTENT_JSON) as Record<string, unknown>;
    const seed = seedReviewable(t, artifactsDir, {
      contentJson: JSON.stringify({
        ...base,
        draft: {
          job_id: "job-x",
          target_role: "Backend Engineer",
          target_company: "Acme",
          claims: [
            { section: "summary", text: "Backend engineer with deep TypeScript API experience." },
            { section: "experience", text: "Led the API migration to TypeScript." },
            { section: "education", text: "BSc in Computer Science, State University" },
          ],
        },
      }),
    });
    const view = getResumeReviewView(t.handle, seed.versionId);
    // Required-first across requirements + gaps: matched, gap, then preferred.
    expect(view?.topKeywords.map((entry) => entry.requirementId)).toEqual([
      "req_api",
      "req_k8s",
      "req_cache",
    ]);
    expect(view?.topKeywords[0]).toMatchObject({
      keyword: "TypeScript API experience",
      evidenced: true,
      evidenceFactIds: ["f1"],
      placements: ["summary", "experience"],
    });
    // The gap keyword is reported honestly and woven nowhere.
    expect(view?.topKeywords[1]).toMatchObject({
      keyword: "Kubernetes deployment",
      evidenced: false,
      evidenceFactIds: [],
      placements: [],
    });
  });

  it("returns no keywords when the analysis is corrupt", () => {
    const { t, artifactsDir } = setup();
    const seed = seedReviewable(t, artifactsDir, { requirementsJson: "{not json" });
    const view = getResumeReviewView(t.handle, seed.versionId);
    expect(view?.analysis).toBeNull();
    expect(view?.topKeywords).toEqual([]);
  });
});
