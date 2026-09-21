// @vitest-environment node
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  newId,
  resumeAssessments,
  resumeClaimFacts,
  resumeClaims,
} from "../../../src/db";
import {
  assessmentDelta,
  assessmentPercent,
  buildAssessmentV1,
  buildDocumentChecksMeasure,
  buildEvidenceMeasure,
  buildKeywordMeasure,
  buildRequirementMeasure,
} from "../../../src/domain/assessment";
import { AssessmentV1 } from "../../../src/domain/tailoringWorkspace";
import { computeAssessmentForAttach } from "../../../src/server/assessment";
import { insertAssessment } from "../../../src/db/tailoringWorkspace";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { V13_MASTER_TEXT, withV13Database } from "../db/v13world";
import { G_PRIORITY_SUPPORTED, gFixtureFacts, seedGEditedPlan } from "./g-world";

/**
 * WO-1.3-G acceptance: G2 (frozen denominators, VERIFIED_SOURCE-only
 * verified counts, validation-row coverage, persisted lineage) and
 * G3 (empty sets stay not_assessed, no composite score, provider
 * scores rejected). Pure-measure legs pin the exact G2 fixture
 * numbers; the attach leg runs the real calculator over frozen rows.
 */

const MASTER_2_OF_4 = [
  "John Rivera",
  "Led platform roadmap for billing.", // phrase 1
  "Cut deploy time with automation.", // phrase 2
  "Earlier career in support.",
].join("\n");

const TAILORED_3_OF_4 = [
  "John Rivera",
  "Led platform roadmap for billing.", // phrase 1
  "Cut deploy time with automation.", // phrase 2
  "Drove supply chain roadmap planning.", // phrase 3
].join("\n");

const KEYWORD_IDS = ["kw-roadmap", "kw-deploy", "kw-supply", "kw-netsuite"];
const KEYWORD_TEXTS = [
  "platform roadmap",
  "deploy time",
  "supply chain roadmap",
  "NetSuite administration",
];

describe("G2 keyword denominators", () => {
  it("scores original 2/4 and tailored 3/4 over the frozen phrase set", () => {
    const measure = buildKeywordMeasure({
      itemIds: KEYWORD_IDS,
      texts: KEYWORD_TEXTS,
      masterText: MASTER_2_OF_4,
      tailoredText: TAILORED_3_OF_4,
    });
    expect(measure.key).toBe("selected_keywords");
    expect(measure.original).toEqual({ status: "assessed", numerator: 2, denominator: 4 });
    expect(measure.tailored).toEqual({ status: "assessed", numerator: 3, denominator: 4 });
    expect(measure.itemIds).toEqual(KEYWORD_IDS);
    expect(assessmentPercent(measure.original)).toBe(50);
    expect(assessmentPercent(measure.tailored)).toBe(75);
    expect(assessmentDelta(measure.original, measure.tailored)).toBe(25);
  });

  it("leaves the original side not_assessed when the baseline is missing", () => {
    const measure = buildKeywordMeasure({
      itemIds: KEYWORD_IDS,
      texts: KEYWORD_TEXTS,
      masterText: null,
      tailoredText: TAILORED_3_OF_4,
    });
    expect(measure.original).toEqual({
      status: "not_assessed",
      reason: "BASELINE_UNAVAILABLE",
    });
    expect(measure.tailored).toEqual({ status: "assessed", numerator: 3, denominator: 4 });
    expect(assessmentDelta(measure.original, measure.tailored)).toBeNull();
  });
});

describe("G2 supported requirements", () => {
  it("scores 3/5 tailored with the original side not_assessed", () => {
    const measure = buildRequirementMeasure({
      itemIds: ["r1", "r2", "r3", "r4", "r5"],
      coveredIds: ["r1", "r3", "r5"],
    });
    expect(measure.key).toBe("supported_requirements");
    expect(measure.original).toEqual({
      status: "not_assessed",
      reason: "BASELINE_UNAVAILABLE",
    });
    expect(measure.tailored).toEqual({ status: "assessed", numerator: 3, denominator: 5 });
    expect(assessmentPercent(measure.tailored)).toBe(60);
  });

  it("ignores covered ids outside the eligible set", () => {
    const measure = buildRequirementMeasure({
      itemIds: ["r1", "r2"],
      coveredIds: ["r1", "foreign", "r1"],
    });
    expect(measure.tailored).toEqual({ status: "assessed", numerator: 1, denominator: 2 });
  });
});

describe("G2 correction attach over frozen rows", () => {
  it("counts only VERIFIED_SOURCE segments as machine-verified", () => {
    withV13Database((t, world) => {
      // r1 links the VERIFIED_SOURCE summary claim; r2 links only the
      // accepted-AI claim, so r2 must stay uncovered. Analyses are
      // immutable, so the requirements land at insert.
      const facts = gFixtureFacts(t.handle, world.pmSnapshotId);
      const g = seedGEditedPlan(t.handle, world, {
        requirementsJson: JSON.stringify({
          requirements: [
            { requirement_id: "r1", evidence_fact_ids: [facts.keepFactId] },
            { requirement_id: "r2", evidence_fact_ids: [facts.dropFactId] },
          ],
        }),
      });
      const summary = g.derived.find((segment) => segment.kind === "summary");
      const bullet = g.derived.find((segment) => segment.kind === "bullet");
      expect(summary?.text).toBe(g.summaryText);
      if (summary === undefined || bullet === undefined) {
        throw new Error("G world lost its derived segments");
      }
      const verifiedClaimId = newId();
      const acceptedClaimId = newId();
      t.handle.db
        .insert(resumeClaims)
        .values({
          id: verifiedClaimId,
          resumeVersionId: g.version.versionId,
          claimText: summary.text,
          derivationKind: null,
          createdAt: "2026-09-16T12:00:01.000Z",
        })
        .run();
      t.handle.db
        .insert(resumeClaims)
        .values({
          id: acceptedClaimId,
          resumeVersionId: g.version.versionId,
          claimText: bullet.text,
          derivationKind: null,
          createdAt: "2026-09-16T12:00:02.000Z",
        })
        .run();
      t.handle.db
        .insert(resumeClaimFacts)
        .values({ claimId: verifiedClaimId, factId: g.factIds[0] as string })
        .run();
      t.handle.db
        .insert(resumeClaimFacts)
        .values({ claimId: acceptedClaimId, factId: g.factIds[1] as string })
        .run();

      const tailoredMarkdown = `# Avery Stone\n\nProduct leader with a billing platform past.\n`;
      const attached = computeAssessmentForAttach(t.handle, {
        versionId: g.version.versionId,
        requestId: g.run.requestId,
        tailoredMarkdown,
        renderEvidence: {
          pageCount: 1,
          pageBudget: 2,
          fragmentsChecked: 3,
          contentPresent: true,
          contactPresent: true,
          parityPassed: true,
        },
        now: "2026-09-16T12:00:03.000Z",
      });
      expect(attached.status).toBe("assessed");
      if (attached.status !== "assessed") {
        throw new Error("G attach did not assess");
      }
      const byKey = new Map(attached.assessment.measures.map((measure) => [measure.key, measure]));
      // Keywords: the gap priority never enters the eligible set; the
      // supported quote matches both frozen texts.
      expect(byKey.get("selected_keywords")).toMatchObject({
        original: { status: "assessed", numerator: 1, denominator: 1 },
        tailored: { status: "assessed", numerator: 1, denominator: 1 },
        itemIds: [G_PRIORITY_SUPPORTED],
      });
      // Requirements: only the VERIFIED_SOURCE-backed requirement counts.
      expect(byKey.get("supported_requirements")).toMatchObject({
        tailored: { status: "assessed", numerator: 1, denominator: 2 },
        itemIds: ["r1", "r2"],
      });
      expect(byKey.get("document_checks")).toMatchObject({
        tailored: { status: "assessed", numerator: 4, denominator: 4 },
      });
      expect(byKey.get("evidence_integrity")).toMatchObject({
        tailored: { status: "assessed", numerator: 2, denominator: 2 },
      });
    });
  });

  it("persists the exact input sets and hashes with the measures", () => {
    withV13Database((t, world) => {
      const g = seedGEditedPlan(t.handle, world);
      const assessment = buildAssessmentV1({
        keywords: {
          itemIds: KEYWORD_IDS,
          texts: KEYWORD_TEXTS,
          masterText: MASTER_2_OF_4,
          tailoredText: TAILORED_3_OF_4,
        },
        requirements: { itemIds: ["r1", "r2"], coveredIds: ["r1"] },
        checks: [
          { id: "nonempty-content", passed: true },
          { id: "valid-contact", passed: true },
          { id: "no-render-overflow", passed: true },
          { id: "cross-format-parity", passed: true },
        ],
        evidence: [{ claimId: "c1", intact: true }],
      });
      const masterTextHash = sha256HexUtf8(V13_MASTER_TEXT);
      insertAssessment(t.handle, {
        resumeVersionId: g.version.versionId,
        requestId: g.run.requestId,
        policyVersion: "assessment/1",
        masterTextHash,
        tailoredContentHash: g.version.contentHash,
        measuresJson: JSON.stringify(assessment),
        now: "2026-09-16T12:00:04.000Z",
      });
      const row = t.handle.db
        .select()
        .from(resumeAssessments)
        .where(eq(resumeAssessments.resumeVersionId, g.version.versionId))
        .get();
      expect(row?.requestId).toBe(g.run.requestId);
      expect(row?.policyVersion).toBe("assessment/1");
      expect(row?.masterTextHash).toBe(masterTextHash);
      expect(row?.tailoredContentHash).toBe(g.version.contentHash);
      const stored = AssessmentV1.parse(JSON.parse(row?.measuresJson ?? ""));
      expect(stored.measures.map((measure) => measure.key)).toEqual([
        "selected_keywords",
        "supported_requirements",
        "document_checks",
        "evidence_integrity",
      ]);
      expect(
        stored.measures.find((measure) => measure.key === "selected_keywords")?.itemIds,
      ).toEqual(KEYWORD_IDS);
    });
  });
});

describe("G3 empty sets and score rejection", () => {
  it("marks every empty measure not_assessed, never 0% or 100%", () => {
    const keywords = buildKeywordMeasure({
      itemIds: [],
      texts: [],
      masterText: MASTER_2_OF_4,
      tailoredText: TAILORED_3_OF_4,
    });
    expect(keywords.original).toEqual({ status: "not_assessed", reason: "NO_ELIGIBLE_ITEMS" });
    expect(keywords.tailored).toEqual({ status: "not_assessed", reason: "NO_ELIGIBLE_ITEMS" });
    const requirements = buildRequirementMeasure({ itemIds: [], coveredIds: [] });
    expect(requirements.tailored.status).toBe("not_assessed");
    const checks = buildDocumentChecksMeasure([]);
    expect(checks.tailored).toEqual({
      status: "not_assessed",
      reason: "CHECK_NOT_APPLICABLE",
    });
    const evidence = buildEvidenceMeasure([]);
    expect(evidence.tailored).toEqual({ status: "not_assessed", reason: "NO_ELIGIBLE_ITEMS" });
    for (const side of [
      keywords.original,
      keywords.tailored,
      requirements.original,
      requirements.tailored,
      checks.original,
      checks.tailored,
      evidence.original,
      evidence.tailored,
    ]) {
      expect(assessmentPercent(side)).toBeNull();
    }
  });

  it("carries no composite score field", () => {
    const assessment = buildAssessmentV1({
      keywords: { itemIds: [], texts: [], masterText: null, tailoredText: "" },
      requirements: { itemIds: [], coveredIds: [] },
      checks: [],
      evidence: [],
    });
    expect(Object.keys(assessment).sort()).toEqual(["measures", "policyVersion", "schemaVersion"]);
    expect(JSON.stringify(assessment)).not.toMatch(/score|overall|ats/i);
  });

  it("rejects provider- or browser-supplied scores", () => {
    const valid = buildAssessmentV1({
      keywords: {
        itemIds: KEYWORD_IDS,
        texts: KEYWORD_TEXTS,
        masterText: MASTER_2_OF_4,
        tailoredText: TAILORED_3_OF_4,
      },
      requirements: { itemIds: ["r1"], coveredIds: ["r1"] },
      checks: [{ id: "nonempty-content", passed: true }],
      evidence: [{ claimId: "c1", intact: true }],
    });
    expect(() =>
      AssessmentV1.parse({ ...valid, overallScore: 88, atsScore: 91 }),
    ).toThrow();
    expect(() =>
      AssessmentV1.parse({
        schemaVersion: "resume-assessment/v1",
        policyVersion: "assessment/1",
        measures: valid.measures.map((measure) => ({ ...measure, score: 100 })),
      }),
    ).toThrow();
  });
});
