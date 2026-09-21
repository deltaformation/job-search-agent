// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  jobs,
  newId,
  resumeArtifacts,
  resumeVersions,
  generationRequests,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getBoardView } from "../../../src/server/board";
import { approveResume } from "../../../src/server/review";
import { seedCrossProfileWorld } from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  V13_T0,
  withV13Database,
} from "../db/v13world";

/**
 * WO-1.3-H acceptance: H3 (batched selected-approved PDF resolves
 * exact v1/v2 version context, never the awaiting draft) and H6
 * (one batch artifact query regardless of card count; metadata
 * only, bodies stay on disk).
 */

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function settleRun(handle: DatabaseHandle, requestId: string, workItemId: string): void {
  handle.db
    .update(generationRequests)
    .set({ status: "SUCCEEDED", updatedAt: V13_T0 })
    .where(eq(generationRequests.id, requestId))
    .run();
  handle.db
    .update(workItems)
    .set({ state: "SUCCEEDED", leaseToken: null })
    .where(eq(workItems.id, workItemId))
    .run();
}

function stageVersionArtifacts(
  handle: DatabaseHandle,
  artifactsDir: string,
  versionId: string,
  tag: string,
): { pdfId: string; pdfSha256: string } {
  let pdfId = "";
  let pdfSha256 = "";
  const kinds = [
    ["MARKDOWN", "resume.md", "text/markdown", `# Resume ${tag}\n`],
    ["DOCX", "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `docx-${tag}`],
    ["PDF", "resume.pdf", "application/pdf", `%PDF-1.4 ${tag}\n`],
  ] as const;
  for (const [kind, file, mediaType, body] of kinds) {
    const relativePath = `versions/${versionId}/${file}`;
    mkdirSync(join(artifactsDir, `versions/${versionId}`), { recursive: true });
    const absolute = join(artifactsDir, relativePath);
    writeFileSync(absolute, body, "utf8");
    const bytes = Buffer.from(body, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = newId();
    handle.db
      .insert(resumeArtifacts)
      .values({ id, resumeVersionId: versionId, kind, relativePath, mediaType, byteSize: bytes.byteLength, sha256 })
      .run();
    if (kind === "PDF") {
      pdfId = id;
      pdfSha256 = sha256;
    }
  }
  return { pdfId, pdfSha256 };
}

/** Count prepares through the Drizzle choke point, capturing SQL texts. */
function countPrepares(handle: DatabaseHandle, fn: () => void): { count: number; sql: string[] } {
  const sqlite = handle.sqlite;
  const originalPrepare = sqlite.prepare;
  const sql: string[] = [];
  sqlite.prepare = ((source: string) => {
    sql.push(source);
    return originalPrepare.call(sqlite, source);
  }) as typeof sqlite.prepare;
  try {
    fn();
  } finally {
    sqlite.prepare = originalPrepare;
  }
  return { count: sql.length, sql };
}

function findCard(t: TestDatabase, jobId: string) {
  const view = getBoardView(t.handle, {});
  for (const column of view.columns) {
    const card = column.cards.find((entry) => entry.id === jobId);
    if (card !== undefined) {
      return card;
    }
  }
  throw new Error("H download lost its card");
}

describe("H3 selected-approved PDF resolution", () => {
  it("resolves v1 while v2 awaits; approving v2 flips Q7 to v2", () => {
    withV13Database((t, world) => {
      const artifactsDir = mkdtempSync(join(tmpdir(), "h-download-"));
      tempDirs.push(artifactsDir);
      const basics = seedV13Basics(t.handle, world);
      const run1 = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run1);
      const v1 = seedV13Version(t.handle, basics, run1, { version: 1 });
      settleRun(t.handle, run1.requestId, run1.workItemId);
      const v1pdf = stageVersionArtifacts(t.handle, artifactsDir, v1.versionId, "v1");
      // v1 selected-approved (human approval already recorded).
      t.handle.db
        .update(resumeVersions)
        .set({ reviewState: "APPROVED" })
        .where(eq(resumeVersions.id, v1.versionId))
        .run();
      t.handle.db
        .update(jobs)
        .set({
          selectedResumeVersionId: v1.versionId,
          status: "TAILORED",
          tailoringState: "AWAITING_REVIEW",
        })
        .where(eq(jobs.id, basics.jobId))
        .run();
      // v2 awaiting: the active draft the download must NOT resolve.
      const run2 = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run2);
      const v2 = seedV13Version(t.handle, basics, run2, { version: 2 });
      settleRun(t.handle, run2.requestId, run2.workItemId);
      const v2pdf = stageVersionArtifacts(t.handle, artifactsDir, v2.versionId, "v2");
      t.handle.db
        .update(jobs)
        .set({ activeResumeVersionId: v2.versionId })
        .where(eq(jobs.id, basics.jobId))
        .run();

      const before = findCard(t, basics.jobId);
      expect(before.resume).toMatchObject({ versionId: v2.versionId });
      expect(before.selectedApprovedPdfArtifactId).toBe(v1pdf.pdfId);
      expect(before.selectedApprovedPdfSha256).toBe(v1pdf.pdfSha256);

      const approved = approveResume(
        t.handle,
        { jobId: basics.jobId, resumeVersionId: v2.versionId, observedRowVersion: 1, actor: "human" },
        { artifactsDir },
      );
      expect(approved.ok).toBe(true);

      const after = findCard(t, basics.jobId);
      expect(after.selectedApprovedPdfArtifactId).toBe(v2pdf.pdfId);
      expect(after.selectedApprovedPdfSha256).toBe(v2pdf.pdfSha256);
    });
  });

  it("resolves null without a selected PDF — never an awaiting fallback", () => {
    withV13Database((t, world) => {
      const artifactsDir = mkdtempSync(join(tmpdir(), "h-download-null-"));
      tempDirs.push(artifactsDir);
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const v1 = seedV13Version(t.handle, basics, run);
      settleRun(t.handle, run.requestId, run.workItemId);
      // Awaiting v1 HAS a staged PDF — but nothing is selected.
      stageVersionArtifacts(t.handle, artifactsDir, v1.versionId, "awaiting");
      t.handle.db
        .update(jobs)
        .set({ activeResumeVersionId: v1.versionId })
        .where(eq(jobs.id, basics.jobId))
        .run();
      const card = findCard(t, basics.jobId);
      expect(card.resume).toMatchObject({ versionId: v1.versionId });
      expect(card.selectedApprovedPdfArtifactId).toBeNull();
      expect(card.selectedApprovedPdfSha256).toBeNull();
    });
  });
});

describe("H6 board artifact query budget", () => {
  it("adds exactly one batch artifact query for 1000 cards; metadata only", () => {
    const t = createTestDatabase("job-tracker-v13-h6-");
    try {
      seedCrossProfileWorld(t);
      const statuses = ["NEW", "TAILORED", "APPLIED", "INTERVIEWED", "REJECTED"] as const;
      for (let i = 0; i < 1000; i += 1) {
        t.handle.db
          .insert(jobs)
          .values({
            id: newId(),
            status: statuses[i % statuses.length] as (typeof statuses)[number],
            rowVersion: 1,
            rank: i,
            title: `Bulk job ${i}`,
            company: "Bulk",
            tailoringState: "READY",
          })
          .run();
      }
      const { count, sql } = countPrepares(t.handle, () => {
        getBoardView(t.handle, {});
      });
      // 1 totals + 5 columns + 1 batch artifact query.
      expect(count).toBe(7);
      const artifactStatements = sql.filter((text) => text.includes("resume_artifacts"));
      expect(artifactStatements).toHaveLength(1);
      // Metadata only: id + digest, no bodies, no per-card statements.
      expect(artifactStatements[0]).toContain("sha256");
      expect(artifactStatements[0]).not.toMatch(/relative_path|byte_size|media_type/i);
    } finally {
      t.cleanup();
    }
  });
});
