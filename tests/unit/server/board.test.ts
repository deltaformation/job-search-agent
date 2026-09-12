// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import {
  applications,
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshots,
  intakeBatches,
  intakeItems,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobNotes,
  jobSources,
  jobs,
  resumeArtifacts,
  resumeReviews,
  resumeVersions,
  scrapeAttempts,
  sourceArtifacts,
  workAttempts,
  workItems,
  workflowEvents,
} from "../../../src/db/schema";
import type { BoardStatus } from "../../../src/domain/enums";
import { getBoardView, getJobDetail } from "../../../src/server/board";

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-board-test-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

function seedJob(
  handle: DatabaseHandle,
  overrides: {
    status?: BoardStatus;
    rank?: number;
    rowVersion?: number;
    title?: string | null;
    company?: string | null;
    location?: string | null;
    createdAt?: string;
    updatedAt?: string;
    activeResumeVersionId?: string | null;
  } = {},
): string {
  const id = newId();
  handle.db
    .insert(jobs)
    .values({
      id,
      status: overrides.status ?? "NEW",
      rank: overrides.rank ?? 0,
      rowVersion: overrides.rowVersion ?? 1,
      title: overrides.title ?? null,
      company: overrides.company ?? null,
      location: overrides.location ?? null,
      createdAt: overrides.createdAt ?? "2026-09-11T12:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-09-11T12:00:00.000Z",
      activeResumeVersionId: overrides.activeResumeVersionId ?? null,
    })
    .run();
  return id;
}

describe("getBoardView", () => {
  it("projects all five columns with rank order and totals", () => {
    withDatabase((t) => {
      seedJob(t.handle, { status: "NEW", rank: 2, title: "B" });
      seedJob(t.handle, { status: "NEW", rank: 1, title: "A" });
      seedJob(t.handle, {
        status: "APPLIED",
        rank: 0,
        title: "C",
        rowVersion: 5,
        company: "Acme",
        location: "Remote",
      });
      const board = getBoardView(t.handle, {});
      expect(board.columns.map((column) => column.status)).toEqual([
        "NEW",
        "TAILORED",
        "APPLIED",
        "INTERVIEWED",
        "REJECTED",
      ]);
      const fresh = board.columns[0];
      expect(fresh.total).toBe(2);
      expect(fresh.cards.map((card) => card.title)).toEqual(["A", "B"]);
      expect(fresh.cards[0]).toMatchObject({ rank: 1, rowVersion: 1 });
      expect(board.columns[1]).toMatchObject({ total: 0, cards: [] });
      expect(board.columns[2].cards[0]).toMatchObject({
        title: "C",
        company: "Acme",
        location: "Remote",
        rowVersion: 5,
      });
    });
  });

  it("breaks rank ties deterministically and paginates per column", () => {
    withDatabase((t) => {
      const first = seedJob(t.handle, {
        status: "NEW",
        rank: 0,
        createdAt: "2026-09-11T10:00:00.000Z",
      });
      const second = seedJob(t.handle, {
        status: "NEW",
        rank: 0,
        createdAt: "2026-09-11T11:00:00.000Z",
      });
      seedJob(t.handle, { status: "NEW", rank: 0 });
      const ordered = getBoardView(t.handle, {});
      expect(ordered.columns[0].cards.map((card) => card.id)).toEqual([
        first,
        second,
        ordered.columns[0].cards[2].id,
      ]);
      const page = getBoardView(t.handle, { limit: 1, offset: 1 });
      expect(page.columns[0].total).toBe(3);
      expect(page.columns[0].cards.map((card) => card.id)).toEqual([second]);
    });
  });

  it("searches title, company, and location with literal wildcards", () => {
    withDatabase((t) => {
      seedJob(t.handle, { title: "100% Remote Engineer" });
      seedJob(t.handle, { company: "Acme_Corp" });
      seedJob(t.handle, { location: "Berlin", title: "Designer" });
      const percent = getBoardView(t.handle, { q: "100%" });
      expect(percent.columns[0].total).toBe(1);
      expect(percent.columns[0].cards[0].title).toBe("100% Remote Engineer");
      const underscore = getBoardView(t.handle, { q: "Acme_Corp" });
      expect(underscore.columns[0].total).toBe(1);
      // Bare wildcards must match literally, not everything.
      const wildcard = getBoardView(t.handle, { q: "%" });
      expect(wildcard.columns[0].total).toBe(1);
      const literal = getBoardView(t.handle, { q: "_" });
      expect(literal.columns[0].total).toBe(1);
      const missing = getBoardView(t.handle, { q: "no-such-job" });
      expect(missing.columns[0]).toMatchObject({ total: 0, cards: [] });
    });
  });

  it("sorts by updated and created timestamps", () => {
    withDatabase((t) => {
      seedJob(t.handle, {
        status: "NEW",
        rank: 0,
        title: "Old",
        createdAt: "2026-09-10T10:00:00.000Z",
        updatedAt: "2026-09-10T10:00:00.000Z",
      });
      seedJob(t.handle, {
        status: "NEW",
        rank: 5,
        title: "New",
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: "2026-09-11T10:00:00.000Z",
      });
      const byRank = getBoardView(t.handle, { sort: "rank" });
      expect(byRank.columns[0].cards.map((card) => card.title)).toEqual([
        "Old",
        "New",
      ]);
      const byUpdated = getBoardView(t.handle, { sort: "updated" });
      expect(byUpdated.columns[0].cards.map((card) => card.title)).toEqual([
        "New",
        "Old",
      ]);
      const byCreated = getBoardView(t.handle, { sort: "created" });
      expect(byCreated.columns[0].cards.map((card) => card.title)).toEqual([
        "New",
        "Old",
      ]);
    });
  });

  it("clamps runaway limits", () => {
    withDatabase((t) => {
      for (let index = 0; index < 205; index += 1) {
        seedJob(t.handle, { status: "NEW", rank: index });
      }
      const board = getBoardView(t.handle, { limit: 9999 });
      expect(board.columns[0].total).toBe(205);
      expect(board.columns[0].cards).toHaveLength(200);
    });
  });

  it("resolves resume pointers, notes, and source URLs safely", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, { status: "TAILORED" });
      t.handle.db
        .insert(jobSources)
        .values({
          id: newId(),
          jobId,
          submittedUrl: "https://example.com/jobs/1",
          canonicalUrl: "https://example.com/jobs/1",
          canonicalKey: "url:https://example.com/jobs/1",
        })
        .run();
      t.handle.db
        .insert(jobNotes)
        .values({ id: newId(), jobId, body: "first" })
        .run();
      t.handle.db
        .insert(jobNotes)
        .values({ id: newId(), jobId, body: "second" })
        .run();
      const board = getBoardView(t.handle, {});
      const card = board.columns[1].cards[0];
      expect(card).toMatchObject({
        resume: null,
        notesCount: 2,
        sourceUrl: "https://example.com/jobs/1",
      });

      // Hostile submitted URLs never reach the card as links.
      const hostile = seedJob(t.handle, { status: "NEW" });
      t.handle.db
        .insert(jobSources)
        .values({
          id: newId(),
          jobId: hostile,
          submittedUrl: "javascript:alert(1)",
          canonicalUrl: "javascript:alert(1)",
          canonicalKey: "url:javascript:alert(1)",
        })
        .run();
      const rebound = getBoardView(t.handle, {});
      expect(rebound.columns[0].cards[0].sourceUrl).toBeNull();

      // Dangling active pointers are impossible: a database trigger
      // rejects versions that do not belong to the job, so the builder's
      // null fallback is unreachable defense in depth. Null pointers are
      // the ordinary "no resume yet" state.
      expect(card.resume).toBeNull();
    });
  });
});

function seedRichJob(handle: DatabaseHandle): string {
  const jobId = seedJob(handle, {
    status: "APPLIED",
    rank: 1,
    rowVersion: 3,
    title: "Staff Engineer",
    company: "Gamma LLC",
    location: "Remote",
  });
  handle.db
    .insert(jobSources)
    .values({
      id: newId(),
      jobId,
      submittedUrl: "https://example.com/jobs/9?utm=x",
      canonicalUrl: "https://example.com/jobs/9",
      canonicalKey: "url:https://example.com/jobs/9",
      finalUrl: "https://example.com/jobs/9",
      applyUrl: "javascript:steal()",
      sourceIdentity: null,
    })
    .run();
  const batchId = newId();
  handle.db.insert(intakeBatches).values({ id: batchId, rawLineCount: 1 }).run();
  const intakeItemId = newId();
  handle.db
    .insert(intakeItems)
    .values({
      id: intakeItemId,
      batchId,
      lineNumber: 1,
      rawInput: "https://example.com/jobs/9?utm=x",
      outcome: "ENQUEUED",
      canonicalUrl: "https://example.com/jobs/9",
      jobId,
    })
    .run();
  const attemptId = newId();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      intakeItemId,
      jobId,
      canonicalUrl: "https://example.com/jobs/9",
      adapter: "generic",
      startedAt: "2026-09-11T10:00:00.000Z",
      finishedAt: "2026-09-11T10:00:05.000Z",
      outcome: "SUCCEEDED",
      workerId: "worker-a",
    })
    .run();
  handle.db
    .insert(sourceArtifacts)
    .values({
      id: newId(),
      scrapeAttemptId: attemptId,
      kind: "HTML",
      relativePath: "evidence/../../etc/passwd",
      mediaType: "text/html",
      byteSize: 10,
      sha256: "a".repeat(64),
    })
    .run();
  const extractionId = newId();
  handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "job-extraction-v1",
      adapter: "generic",
      extractedJson: JSON.stringify({
        schemaVersion: "job-extraction-v1",
        fields: { title: "Staff Engineer" },
        provenance: { title: "generic:h1" },
        contentHash: "b".repeat(64),
      }),
      confidence: 0.8,
      missingFieldsJson: JSON.stringify(["postedAt"]),
    })
    .run();
  handle.db
    .update(jobs)
    .set({ activeExtractionId: extractionId })
    .where(eq(jobs.id, jobId))
    .run();
  handle.db.insert(candidateProfiles).values({ id: "local" }).run();
  const profileVersionId = newId();
  handle.db
    .insert(candidateProfileVersions)
    .values({
      id: profileVersionId,
      profileId: "local",
      version: 1,
      payloadJson: "{}",
      payloadHash: "c".repeat(64),
      schemaVersion: "candidate-profile-v1",
    })
    .run();
  const snapshotId = newId();
  handle.db
    .insert(candidateSnapshots)
    .values({
      id: snapshotId,
      profileVersionId,
      canonicalJson: "{}",
      schemaVersion: "candidate-snapshot-v1",
      sha256: "d".repeat(64),
    })
    .run();
  const jdSnapshotId = newId();
  handle.db
    .insert(jdSnapshots)
    .values({
      id: jdSnapshotId,
      jobId,
      extractionId,
      jdText: "Staff Engineer",
      canonicalSha256: "e".repeat(64),
    })
    .run();
  const analysisId = newId();
  handle.db
    .insert(jobAnalyses)
    .values({
      id: analysisId,
      jobId,
      jdSnapshotId,
      candidateSnapshotId: snapshotId,
      requirementsJson: "[]",
      gapsJson: "[]",
      promptVersion: "prompt-v1",
      proposalSchemaVersion: "proposal-v1",
    })
    .run();
  const versionId = newId();
  handle.db
    .insert(resumeVersions)
    .values({
      id: versionId,
      jobId,
      version: 1,
      analysisId,
      templateId: "standard",
      templateVersion: "v1",
      templateHash: "f".repeat(64),
      rankerVersion: "ranker-v1",
      policyVersion: "policy-v1",
      configVersion: "config-v1",
      renderSchemaVersion: "render-v1",
      contentJson: "{}",
      contentHash: "0".repeat(64),
      reviewState: "AWAITING_REVIEW",
    })
    .run();
  handle.db
    .insert(resumeArtifacts)
    .values({
      id: newId(),
      resumeVersionId: versionId,
      kind: "MARKDOWN",
      relativePath: "artifacts/evil/../../../x.md",
      mediaType: "text/markdown",
      byteSize: 12,
      sha256: "1".repeat(64),
    })
    .run();
  handle.db
    .insert(resumeReviews)
    .values({
      id: newId(),
      resumeVersionId: versionId,
      action: "REVISION_REQUESTED",
      actor: "human",
      note: "tune the summary",
      resumeHash: "2".repeat(64),
      contentHash: "0".repeat(64),
      artifactHashesJson: "{}",
    })
    .run();
  handle.db
    .update(jobs)
    .set({ activeResumeVersionId: versionId })
    .where(eq(jobs.id, jobId))
    .run();
  handle.db
    .insert(jobNotes)
    .values({ id: newId(), jobId, body: "<b>bold note</b>" })
    .run();
  handle.db
    .insert(applications)
    .values({
      id: newId(),
      jobId,
      recordedBy: "human",
      appliedAt: "2026-09-11T09:00:00.000Z",
      confirmationNumber: "CONF-1",
    })
    .run();
  handle.db
    .insert(workflowEvents)
    .values({
      id: newId(),
      jobId,
      actor: "human",
      fromStatus: "TAILORED",
      toStatus: "APPLIED",
      rank: 1,
      rowVersion: 3,
      reason: "move",
      metadataJson: JSON.stringify({
        schemaVersion: "workflow-event-metadata-v1",
        appliedAt: "2026-09-11T09:00:00.000Z",
      }),
    })
    .run();
  return jobId;
}

describe("getJobDetail", () => {
  it("returns null for unknown jobs and empty sections for bare jobs", () => {
    withDatabase((t) => {
      expect(getJobDetail(t.handle, newId())).toBeNull();
      const jobId = seedJob(t.handle, {});
      const detail = getJobDetail(t.handle, jobId);
      expect(detail).not.toBeNull();
      expect(detail).toMatchObject({
        source: null,
        attempts: [],
        artifacts: [],
        extraction: null,
        resumes: [],
        notes: [],
        application: null,
        history: [],
        intake: null,
      });
      expect(detail?.job.status).toBe("NEW");
      expect(detail?.tailoringAttempt).toBeNull();
    });
  });

  it("projects compensation highlights and top keywords for the drawer", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, {});
      t.handle.db
        .update(jobs)
        .set({ compensationHighlightsJson: JSON.stringify(["RRSP matching", "Equity"]) })
        .where(eq(jobs.id, jobId))
        .run();
      const attemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId,
          canonicalUrl: "https://example.com/jobs/1",
          adapter: "generic",
          startedAt: "2026-09-11T12:00:00.000Z",
          finishedAt: "2026-09-11T12:00:05.000Z",
          outcome: "SUCCEEDED",
          workerId: "worker-a",
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
          adapter: "generic",
          extractedJson: JSON.stringify({
            schemaVersion: "job-extraction-v1",
            fields: {},
            provenance: {},
            contentHash: "b".repeat(64),
          }),
          confidence: 0.8,
          missingFieldsJson: JSON.stringify([]),
        })
        .run();
      t.handle.db.insert(candidateProfiles).values({ id: "local" }).run();
      const profileVersionId = newId();
      t.handle.db
        .insert(candidateProfileVersions)
        .values({
          id: profileVersionId,
          profileId: "local",
          version: 1,
          payloadJson: "{}",
          payloadHash: "c".repeat(64),
          schemaVersion: "candidate-profile-v1",
        })
        .run();
      const snapshotId = newId();
      t.handle.db
        .insert(candidateSnapshots)
        .values({
          id: snapshotId,
          profileVersionId,
          canonicalJson: "{}",
          schemaVersion: "candidate-snapshot-v1",
          sha256: "d".repeat(64),
        })
        .run();
      const jdSnapshotId = newId();
      t.handle.db
        .insert(jdSnapshots)
        .values({
          id: jdSnapshotId,
          jobId,
          extractionId,
          jdText: "TypeScript API experience. Kubernetes deployment.",
          canonicalSha256: "e".repeat(64),
        })
        .run();
      t.handle.db
        .insert(jobAnalyses)
        .values({
          id: newId(),
          jobId,
          jdSnapshotId,
          candidateSnapshotId: snapshotId,
          requirementsJson: JSON.stringify({
            schemaVersion: "analysis-requirements/v1",
            requirements: [
              {
                requirement_id: "req_api",
                jd_quote: "TypeScript API experience",
                category: "skill",
                importance: "required",
                match_status: "matched",
                evidence_fact_ids: ["f1"],
              },
            ],
          }),
          gapsJson: JSON.stringify({
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
          }),
          promptVersion: "prompt-v1",
          proposalSchemaVersion: "proposal-v1",
        })
        .run();
      const detail = getJobDetail(t.handle, jobId);
      expect(detail?.compensationHighlights).toEqual(["RRSP matching", "Equity"]);
      expect(detail?.topKeywords).toEqual([
        { keyword: "TypeScript API experience", evidenced: true },
        { keyword: "Kubernetes deployment", evidenced: false },
      ]);
    });
  });

  it("projects the latest tailor attempt for the error card", () => {
    withDatabase((t) => {
      const jobId = seedJob(t.handle, {});
      const itemId = newId();
      t.handle.db
        .insert(workItems)
        .values({
          id: itemId,
          kind: "TAILOR",
          idempotencyKey: `tailor:v1:${jobId}:ext-1`,
          jobId,
          payloadJson: JSON.stringify({ schemaVersion: "tailor-queue/v1" }),
          state: "FAILED",
        })
        .run();
      t.handle.db
        .insert(workAttempts)
        .values({
          id: newId(),
          workItemId: itemId,
          attemptNumber: 1,
          workerId: "worker-a",
          startedAt: "2026-09-11T12:00:00.000Z",
          finishedAt: "2026-09-11T12:00:30.000Z",
          result: "FAILED",
          errorCode: "PROVIDER_UNAVAILABLE",
          errorDetail: "OpenRouter rate limit reached (HTTP 429): wait for quota, then retry",
        })
        .run();
      const detail = getJobDetail(t.handle, jobId);
      expect(detail?.tailoringAttempt).toEqual({
        result: "FAILED",
        errorCode: "PROVIDER_UNAVAILABLE",
        errorDetail: "OpenRouter rate limit reached (HTTP 429): wait for quota, then retry",
        startedAt: "2026-09-11T12:00:00.000Z",
        finishedAt: "2026-09-11T12:00:30.000Z",
      });
    });
  });

  it("assembles the complete card without leaking paths", () => {
    withDatabase((t) => {
      const jobId = seedRichJob(t.handle);
      const detail = getJobDetail(t.handle, jobId);
      expect(detail).not.toBeNull();
      if (detail === null) return;

      expect(detail.job).toMatchObject({
        id: jobId,
        status: "APPLIED",
        rank: 1,
        rowVersion: 3,
        title: "Staff Engineer",
      });
      // Hostile apply URL is nulled; valid URLs pass through.
      expect(detail.source).toMatchObject({
        submittedUrl: "https://example.com/jobs/9?utm=x",
        canonicalUrl: "https://example.com/jobs/9",
        finalUrl: "https://example.com/jobs/9",
        applyUrl: null,
      });
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]).toMatchObject({
        outcome: "SUCCEEDED",
        workerId: "worker-a",
        adapter: "generic",
      });
      expect(detail.artifacts).toHaveLength(1);
      expect(detail.artifacts[0]).toMatchObject({
        kind: "HTML",
        byteSize: 10,
        sha256: "a".repeat(64),
      });
      expect(detail.extraction).toMatchObject({
        adapter: "generic",
        confidence: 0.8,
        missingFields: ["postedAt"],
        contentHash: "b".repeat(64),
        fields: { title: "Staff Engineer" },
        provenance: { title: "generic:h1" },
      });
      expect(detail.resumes).toHaveLength(1);
      expect(detail.resumes[0]).toMatchObject({
        version: 1,
        reviewState: "AWAITING_REVIEW",
      });
      expect(detail.resumes[0].artifacts).toHaveLength(1);
      expect(detail.resumes[0].reviews[0]).toMatchObject({
        action: "REVISION_REQUESTED",
        note: "tune the summary",
      });
      expect(detail.notes).toHaveLength(1);
      expect(detail.application).toMatchObject({
        appliedAt: "2026-09-11T09:00:00.000Z",
        confirmationNumber: "CONF-1",
      });
      expect(detail.history).toHaveLength(1);
      expect(detail.history[0]).toMatchObject({
        fromStatus: "TAILORED",
        toStatus: "APPLIED",
        reason: "move",
      });
      expect(detail.history[0].metadata).toMatchObject({
        appliedAt: "2026-09-11T09:00:00.000Z",
      });
      expect(detail.intake).toMatchObject({ lineNumber: 1 });

      // No stored path may appear anywhere in the serialized view.
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain("relativePath");
      expect(serialized).not.toContain("passwd");
      expect(serialized).not.toContain("artifacts/evil");
      expect(serialized).not.toContain(".sqlite");
      // Raw markup travels untouched for the renderer to escape.
      expect(detail.notes[0].body).toBe("<b>bold note</b>");
    });
  });

  it("fails soft on corrupt stored JSON", () => {
    withDatabase((t) => {
      const jobId = seedRichJob(t.handle);
      const attemptId = newId();
      t.handle.db
        .insert(scrapeAttempts)
        .values({
          id: attemptId,
          jobId,
          canonicalUrl: "https://example.com/jobs/9",
          startedAt: "2026-09-11T10:00:00.000Z",
          outcome: "SUCCEEDED",
        })
        .run();
      const badExtractionId = newId();
      t.handle.db
        .insert(jobExtractions)
        .values({
          id: badExtractionId,
          jobId,
          scrapeAttemptId: attemptId,
          version: 2,
          schemaVersion: "job-extraction-v1",
          adapter: "generic",
          extractedJson: "{oops",
          missingFieldsJson: "{oops",
        })
        .run();
      t.handle.db
        .update(jobs)
        .set({ activeExtractionId: badExtractionId })
        .where(eq(jobs.id, jobId))
        .run();
      t.handle.db
        .insert(workflowEvents)
        .values({
          id: newId(),
          jobId,
          actor: "human",
          toStatus: "APPLIED",
          rowVersion: 4,
          metadataJson: "{oops",
        })
        .run();
      // Unknown metadata versions degrade identically.
      t.handle.db
        .insert(workflowEvents)
        .values({
          id: newId(),
          jobId,
          actor: "human",
          toStatus: "APPLIED",
          rowVersion: 5,
          metadataJson: JSON.stringify({ schemaVersion: "workflow-event-metadata-v99" }),
        })
        .run();

      const detail = getJobDetail(t.handle, jobId);
      expect(detail).not.toBeNull();
      expect(detail?.extraction).toMatchObject({
        missingFields: [],
        contentHash: null,
        fields: null,
        provenance: null,
      });
      expect(detail?.history).toHaveLength(3);
      expect(detail?.history[1].metadata).toBeNull();
      expect(detail?.history[2].metadata).toBeNull();
      // The valid first event still parses.
      expect(detail?.history[0].metadata).not.toBeNull();
    });
  });
});
