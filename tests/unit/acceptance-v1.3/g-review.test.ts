// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  candidateProfileVersions,
  jobs,
  newId,
  resumeArtifacts,
  resumeVersions,
  type DatabaseHandle,
} from "../../../src/db";
import { getTailoringJob } from "../../../src/db/tailoring";
import { WorkflowReviewV2 } from "../../../src/domain/workflowReview";
import { buildWorkflowInsights } from "../../../src/server/workflowReview";
import { buildWorkflowReview } from "../../../src/server/workflowReview";
import { getResumeReviewView } from "../../../src/server/review";
import { listVersionSummaries } from "../../../src/server/tailoringWorkspace";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import {
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  V13_MASTER_TEXT,
  withV13Database,
} from "../db/v13world";
import { seedGEditedPlan, type GEditedPlan } from "./g-world";

/**
 * WO-1.3-G acceptance: G1 (exact-version read model validates,
 * markers/segments/provenance match, foreign versions excluded),
 * G4 (insights cite real frozen records with provenance; gaps stay
 * gaps), G5 (frozen inputs survive master changes; legacy renders
 * baseline-unavailable without substitution).
 */

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function stageMarkdown(
  handle: DatabaseHandle,
  versionId: string,
  text: string,
): string {
  const artifactsDir = mkdtempSync(join(tmpdir(), "g-review-"));
  tempDirs.push(artifactsDir);
  const relativePath = `versions/${versionId}/resume.md`;
  mkdirSync(join(artifactsDir, `versions/${versionId}`), { recursive: true });
  writeFileSync(join(artifactsDir, relativePath), text, "utf8");
  handle.db
    .insert(resumeArtifacts)
    .values({
      id: newId(),
      resumeVersionId: versionId,
      kind: "MARKDOWN",
      relativePath,
      mediaType: "text/markdown",
      byteSize: Buffer.byteLength(text, "utf8"),
      sha256: sha256HexUtf8(text),
    })
    .run();
  return artifactsDir;
}

function buildReview(handle: DatabaseHandle, versionId: string, artifactsDir?: string) {
  const version = handle.db
    .select()
    .from(resumeVersions)
    .where(eq(resumeVersions.id, versionId))
    .get();
  if (version === undefined) {
    throw new Error("G review lost its version row");
  }
  const job = getTailoringJob(handle, version.jobId);
  if (job === null) {
    throw new Error("G review lost its job row");
  }
  return buildWorkflowReview(handle, { version, job, gapKeys: [], artifactsDir });
}

function pointActiveAt(handle: DatabaseHandle, jobId: string, versionId: string): void {
  handle.db
    .update(jobs)
    .set({ activeResumeVersionId: versionId })
    .where(eq(jobs.id, jobId))
    .run();
}

describe("G1 edited-plan read model", () => {
  it("validates and projects the frozen correction inputs", () => {
    withV13Database((t, world) => {
      const g: GEditedPlan = seedGEditedPlan(t.handle, world);
      pointActiveAt(t.handle, g.basics.jobId, g.version.versionId);
      const tailoredText = `# Avery Stone\n\n${g.summaryText}\n`;
      const artifactsDir = stageMarkdown(t.handle, g.version.versionId, tailoredText);
      const review = buildReview(t.handle, g.version.versionId, artifactsDir);
      expect(review).not.toBeNull();
      // Strict schema validation of the exact-version model.
      const parsed = WorkflowReviewV2.parse(review);
      expect(parsed.format).toBe("edited-plan");
      expect(parsed.version).toMatchObject({
        id: g.version.versionId,
        version: 1,
        reviewState: "AWAITING_REVIEW",
        contentHash: g.version.contentHash,
      });
      expect(parsed.request).toMatchObject({
        id: g.run.requestId,
        kind: "INITIAL",
        parentVersionId: null,
      });
      // Frozen profile binding from the request, never the pointer.
      expect(parsed.profile).toMatchObject({
        profileId: g.basics.profileId,
        profileVersionId: g.basics.profileVersionId,
      });
      expect(parsed.master).toEqual({
        text: V13_MASTER_TEXT,
        hash: sha256HexUtf8(V13_MASTER_TEXT),
      });
      expect(parsed.summaryOrigin).toBe("master");
      expect(parsed.summaryText).toBe(g.summaryText);
      // Ordered frozen operations with human detail.
      expect(parsed.operations.map((op) => op.op)).toEqual(["add", "exclude"]);
      expect(parsed.operations[0]?.detail).toContain("sug-001");
      // Coverage derives from the frozen validation row.
      expect(parsed.validation).toMatchObject({
        id: g.validationId,
        policyVersion: "step2-claims/2",
        planId: g.planRowId,
        planHash: g.planHash,
        draftHash: g.draftHash,
      });
      // Frozen segments with per-segment provenance.
      expect(parsed.segments).toHaveLength(2);
      const summary = parsed.segments.find((segment) => segment.kind === "summary");
      const bullet = parsed.segments.find((segment) => segment.kind === "bullet");
      expect(summary?.provenance).toBe("VERIFIED_SOURCE");
      expect(bullet?.provenance).toBe("USER_ACCEPTED_AI");
      expect(bullet?.sourceOperationId).toBe(g.operations[0]?.operationId);
      expect(bullet?.anchorFactIds).toContain(g.factIds[0]);
      expect(parsed.excludedTexts).toEqual([g.excludedText]);
      // Markers match the job pointers.
      expect(parsed.markers).toMatchObject({
        latestPublished: true,
        selectedApproved: false,
        isApplicationVersion: false,
      });
      expect(parsed.tailoredTextStatus).toBe("ok");
      expect(parsed.tailoredText).toBe(tailoredText);
    });
  });
});

describe("G1 focus and legacy formats", () => {
  it("projects focus runs without segments or validation", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      seedV13RequestInputs(t.handle, basics, run);
      const version = seedV13Version(t.handle, basics, run);
      const review = buildReview(t.handle, version.versionId);
      expect(review?.format).toBe("focus");
      expect(review?.summaryOrigin).toBe("focus");
      expect(review?.segments).toEqual([]);
      expect(review?.operations).toEqual([]);
      expect(review?.validation).toBeNull();
      expect(review?.master?.text).toBe(V13_MASTER_TEXT);
      expect(review?.focus).toMatchObject({ kind: "focus" });
      expect(() => WorkflowReviewV2.parse(review)).not.toThrow();
    });
  });

  it("renders request-less versions as legacy with null frozen data", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      // No request-inputs row: the version predates frozen capture.
      const version = seedV13Version(t.handle, basics, run);
      const review = buildReview(t.handle, version.versionId);
      expect(review?.format).toBe("legacy");
      expect(review?.master).toBeNull();
      expect(review?.summaryOrigin).toBeNull();
      expect(review?.segments).toEqual([]);
      expect(review?.assessment).toBeNull();
      expect(() => WorkflowReviewV2.parse(review)).not.toThrow();
    });
  });
});

describe("G1 foreign versions", () => {
  it("scopes version listings to the owning job and binds views to it", () => {
    withV13Database((t, world) => {
      const own = seedV13Basics(t.handle, world);
      const ownRun = seedV13RunningRun(t.handle, own);
      seedV13RequestInputs(t.handle, own, ownRun);
      const ownVersion = seedV13Version(t.handle, own, ownRun);
      const foreign = seedV13Basics(t.handle, world);
      const foreignRun = seedV13RunningRun(t.handle, foreign);
      seedV13RequestInputs(t.handle, foreign, foreignRun);
      const foreignVersion = seedV13Version(t.handle, foreign, foreignRun);

      const listed = listVersionSummaries(t.handle, own.jobId, { limit: 50 });
      expect(listed.ok).toBe(true);
      if (!listed.ok) {
        throw new Error("G listing failed");
      }
      const ids = listed.versions.map((version) => version.id);
      expect(ids).toContain(ownVersion.versionId);
      expect(ids).not.toContain(foreignVersion.versionId);

      // The tailor page's C5 ownership check has nothing foreign to render.
      const view = getResumeReviewView(t.handle, foreignVersion.versionId);
      expect(view?.job.id).toBe(foreign.jobId);
      expect(view?.job.id).not.toBe(own.jobId);
    });
  });
});

describe("G4 provenance-aware insights", () => {
  it("keeps the NetSuite gap a gap and provenance explicit", () => {
    withV13Database((t, world) => {
      const g = seedGEditedPlan(t.handle, world);
      const review = buildReview(t.handle, g.version.versionId);
      const gap = review?.insights.find((insight) => insight.kind === "requirement-gap");
      expect(gap?.text).toContain("NetSuite administration");
      expect(gap?.text).toContain("remains a gap");
      const provenance = review?.insights.find((insight) => insight.kind === "provenance-note");
      expect(provenance?.text).toContain("1 verified source");
      expect(provenance?.text).toContain("1 accepted AI suggestion");
      expect(provenance?.text).toContain("not counted as verified");
      const joined = (review?.insights ?? []).map((insight) => insight.text).join("\n");
      expect(joined).not.toMatch(/gained|expertise|proven/i);
    });
  });

  it("never describes user-edited claims as verified or gained", () => {
    const insights = buildWorkflowInsights({
      format: "edited-plan",
      derived: {
        format: "edited-plan",
        summaryOrigin: "master",
        summaryText: "Summary.",
        operations: [],
        segments: [
          {
            segmentId: "seg-edit",
            kind: "bullet",
            roleId: "role-1",
            text: "Hand-written bullet.",
            textHash: "0".repeat(64),
            provenance: "USER_EDITED",
            sourceOperationId: "op-1",
            anchorFactIds: ["fact-pm-1"],
            priorityIds: [],
          },
        ],
        excludedTexts: [],
        focus: { kind: "edited-plan", priorities: [], featuredPriorityIds: [] },
        validation: null,
      },
      assessment: null,
      gapKeys: [],
    });
    const provenance = insights.find((insight) => insight.kind === "provenance-note");
    expect(provenance?.text).toContain("1 user edit");
    expect(provenance?.text).toContain("not counted as verified");
    expect(provenance?.citations.segmentIds).toContain("seg-edit");
    const joined = insights.map((insight) => insight.text).join("\n");
    expect(joined).not.toMatch(/verified resume claim covers|gained/i);
  });
});

describe("G5 frozen inputs", () => {
  it("survives an active-master change byte-for-byte", () => {
    withV13Database((t, world) => {
      const g = seedGEditedPlan(t.handle, world);
      const before = buildReview(t.handle, g.version.versionId);
      const beforeJson = JSON.stringify(before);
      // A later Settings edit publishes a new live profile version.
      const live = t.handle.db
        .select()
        .from(candidateProfileVersions)
        .where(eq(candidateProfileVersions.id, g.basics.profileVersionId))
        .get();
      if (live === undefined) {
        throw new Error("G world lost its profile version");
      }
      t.handle.db
        .update(candidateProfileVersions)
        .set({ activatedAt: null })
        .where(eq(candidateProfileVersions.id, live.id))
        .run();
      t.handle.db
        .insert(candidateProfileVersions)
        .values({
          id: newId(),
          profileId: live.profileId,
          version: live.version + 1,
          payloadJson: JSON.stringify({ rewritten: "new master document" }),
          payloadHash: "7".repeat(64),
          schemaVersion: live.schemaVersion,
          activatedAt: "2026-09-17T12:00:00.000Z",
        })
        .run();
      const after = buildReview(t.handle, g.version.versionId);
      expect(JSON.stringify(after)).toBe(beforeJson);
      expect(after?.master).toEqual({
        text: V13_MASTER_TEXT,
        hash: sha256HexUtf8(V13_MASTER_TEXT),
      });
      expect(after?.profile?.profileVersionId).toBe(g.basics.profileVersionId);
      expect(after?.validation?.id).toBe(g.validationId);
    });
  });

  it("never substitutes the current master for a missing legacy baseline", () => {
    withV13Database((t, world) => {
      const basics = seedV13Basics(t.handle, world);
      const run = seedV13RunningRun(t.handle, basics);
      const version = seedV13Version(t.handle, basics, run);
      const review = buildReview(t.handle, version.versionId);
      expect(review?.master).toBeNull();
      expect(JSON.stringify(review)).not.toContain("Avery Stone");
    });
  });
});
