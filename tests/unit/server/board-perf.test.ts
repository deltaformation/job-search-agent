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
  candidateProfileVersions,
  candidateProfiles,
  candidateSnapshots,
  jdSnapshots,
  jobAnalyses,
  jobExtractions,
  jobNotes,
  jobSources,
  jobs,
  resumeVersions,
  scrapeAttempts,
} from "../../../src/db/schema";
import type { BoardStatus } from "../../../src/domain/enums";
import { getBoardView } from "../../../src/server/board";

/**
 * Phase 0 baseline / Phase 1.1 budget guard for `getBoardView`.
 *
 * Seeds isolated temporary databases with representative card loads (0, 10,
 * 50, 100 cards spread over all five columns, varied note counts, active
 * resume versions on every other card) and counts the exact number of SQLite
 * statements executed per board read by wrapping `sqlite.prepare` — the single
 * choke point every Drizzle better-sqlite3 execution passes through
 * (`prepareQuery` calls `client.prepare` exactly once per query).
 *
 * Baseline (per-card resume + note lookups): ~10 + 2N queries.
 * Budget after Phase 1.1: constant O(1) queries regardless of card count.
 */

const COLUMN_STATUSES: readonly BoardStatus[] = [
  "NEW",
  "TAILORED",
  "APPLIED",
  "INTERVIEWED",
  "REJECTED",
];

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-board-perf-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

/** Shared candidate profile/version/snapshot every analysis binds to. */
function seedSharedCandidate(handle: DatabaseHandle): string {
  handle.db
    .insert(candidateProfiles)
    .values({ id: "local", name: "default", displayName: "Primary Profile", isDefault: true })
    .run();
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
  return snapshotId;
}

function seedCardJob(
  handle: DatabaseHandle,
  index: number,
  candidateSnapshotId: string,
): void {
  const id = newId();
  const day = String(1 + (index % 27)).padStart(2, "0");
  const stamp = `2026-09-${day}T12:00:00.000Z`;
  handle.db
    .insert(jobs)
    .values({
      id,
      status: COLUMN_STATUSES[index % COLUMN_STATUSES.length],
      rank: index % 7,
      rowVersion: 1,
      title: `Engineer ${index}`,
      company: `Company ${index % 11}`,
      location: index % 2 === 0 ? "Remote" : "Berlin",
      createdAt: stamp,
      updatedAt: stamp,
      activeResumeVersionId: null,
    })
    .run();
  handle.db
    .insert(jobSources)
    .values({
      id: newId(),
      jobId: id,
      submittedUrl: `https://example.com/jobs/${index}`,
      canonicalUrl: `https://example.com/jobs/${index}`,
      canonicalKey: `url:https://example.com/jobs/${index}`,
    })
    .run();
  const noteCount = index % 4;
  for (let note = 0; note < noteCount; note += 1) {
    handle.db
      .insert(jobNotes)
      .values({ id: newId(), jobId: id, body: `note ${note} for job ${index}` })
      .run();
  }
  if (index % 2 !== 0) {
    return;
  }
  const attemptId = newId();
  handle.db
    .insert(scrapeAttempts)
    .values({
      id: attemptId,
      jobId: id,
      canonicalUrl: `https://example.com/jobs/${index}`,
      adapter: "generic",
      startedAt: stamp,
      finishedAt: stamp,
      outcome: "SUCCEEDED",
      workerId: "bench",
    })
    .run();
  const extractionId = newId();
  handle.db
    .insert(jobExtractions)
    .values({
      id: extractionId,
      jobId: id,
      scrapeAttemptId: attemptId,
      version: 1,
      schemaVersion: "job-extraction-v1",
      adapter: "generic",
      extractedJson: "{}",
      confidence: 0.9,
    })
    .run();
  const jdSnapshotId = newId();
  handle.db
    .insert(jdSnapshots)
    .values({
      id: jdSnapshotId,
      jobId: id,
      extractionId,
      jdText: `Job description ${index}`,
      canonicalSha256: `bench-jd-${index}`,
    })
    .run();
  const analysisId = newId();
  handle.db
    .insert(jobAnalyses)
    .values({
      id: analysisId,
      jobId: id,
      jdSnapshotId,
      candidateSnapshotId,
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
      jobId: id,
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
    .update(jobs)
    .set({ activeResumeVersionId: versionId })
    .where(eq(jobs.id, id))
    .run();
}

function seedBoard(
  handle: DatabaseHandle,
  cardCount: number,
): void {
  const candidateSnapshotId = seedSharedCandidate(handle);
  for (let index = 0; index < cardCount; index += 1) {
    seedCardJob(handle, index, candidateSnapshotId);
  }
}

function measureBoardView(handle: DatabaseHandle): {
  queryCount: number;
  durationMs: number;
} {
  const sqlite = handle.sqlite;
  const originalPrepare = sqlite.prepare;
  let queryCount = 0;
  sqlite.prepare = ((source: string) => {
    queryCount += 1;
    return originalPrepare.call(sqlite, source);
  }) as typeof sqlite.prepare;
  const startedAt = performance.now();
  try {
    getBoardView(handle, {});
  } finally {
    sqlite.prepare = originalPrepare;
  }
  return { queryCount, durationMs: performance.now() - startedAt };
}

describe("getBoardView query budget", () => {
  it("keeps SQLite queries constant as cards grow from 10 to 100", () => {
    const results: Array<{
      size: number;
      queries: number;
      durationMs: number;
    }> = [];
    for (const size of [0, 10, 50, 100]) {
      withDatabase((t) => {
        seedBoard(t.handle, size);
        const { queryCount, durationMs } = measureBoardView(t.handle);
        results.push({
          size,
          queries: queryCount,
          durationMs: Math.round(durationMs * 100) / 100,
        });
      });
    }
    console.log(`board-perf: ${JSON.stringify(results)}`);
    const at10 = results[1].queries;
    const at100 = results[3].queries;
    expect(at100).toBe(at10);
    expect(at100).toBeLessThanOrEqual(10);
  });

  it("preserves card projections at scale", () => {
    withDatabase((t) => {
      seedBoard(t.handle, 50);
      const view = getBoardView(t.handle, {});
      for (const column of view.columns) {
        expect(column.total).toBe(10);
        expect(column.cards).toHaveLength(10);
      }
      for (const column of view.columns) {
        for (const card of column.cards) {
          const index = Number(card.title?.replace("Engineer ", ""));
          expect(Number.isInteger(index)).toBe(true);
          expect(card.notesCount).toBe(index % 4);
          expect(card.sourceUrl).toBe(`https://example.com/jobs/${index}`);
          if (index % 2 === 0) {
            expect(card.resume).toMatchObject({
              version: 1,
              reviewState: "AWAITING_REVIEW",
            });
            expect(typeof card.resume?.versionId).toBe("string");
          } else {
            expect(card.resume).toBeNull();
          }
        }
      }
      const searched = getBoardView(t.handle, { q: "Company 3" });
      const searchedTotal = searched.columns.reduce(
        (sum, column) => sum + column.total,
        0,
      );
      expect(searchedTotal).toBe(5);
      const paged = getBoardView(t.handle, { limit: 3 });
      for (const column of paged.columns) {
        expect(column.total).toBe(10);
        expect(column.cards).toHaveLength(3);
      }
    });
  });
});
