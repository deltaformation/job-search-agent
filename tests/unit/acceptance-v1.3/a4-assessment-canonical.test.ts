// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/domain/canonical";
import { AssessmentV1, type AssessmentV1 as AssessmentV1Type } from "../../../src/domain/tailoringWorkspace";

/**
 * A4: same frozen assessment inputs produce identical canonical
 * JSON; zero denominators are not_assessed; numerator above
 * denominator and duplicate measure keys are rejected; an
 * unassessed baseline carries no numeric delta.
 */

function keywordFixture(): AssessmentV1Type {
  return {
    schemaVersion: "resume-assessment/v1",
    policyVersion: "assessment/1",
    measures: [
      {
        key: "selected_keywords",
        original: { status: "assessed", numerator: 2, denominator: 4 },
        tailored: { status: "assessed", numerator: 3, denominator: 4 },
        itemIds: ["kw-a", "kw-b", "kw-c", "kw-d"],
      },
      {
        key: "supported_requirements",
        original: { status: "not_assessed", reason: "BASELINE_UNAVAILABLE" },
        tailored: { status: "assessed", numerator: 3, denominator: 5 },
        itemIds: ["r1", "r2", "r3", "r4", "r5"],
      },
      {
        key: "document_checks",
        original: { status: "not_assessed", reason: "BASELINE_UNAVAILABLE" },
        tailored: { status: "assessed", numerator: 4, denominator: 4 },
        itemIds: ["c1", "c2", "c3", "c4"],
      },
      {
        key: "evidence_integrity",
        original: { status: "not_assessed", reason: "CHECK_NOT_APPLICABLE" },
        tailored: { status: "assessed", numerator: 9, denominator: 9 },
        itemIds: ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"],
      },
    ],
  };
}

describe("A4 assessment canonical bytes and not_assessed rules", () => {
  it("produces identical canonical JSON for identical frozen inputs", () => {
    const first = canonicalJson(AssessmentV1.parse(keywordFixture()));
    const reordered = {
      policyVersion: "assessment/1",
      measures: keywordFixture().measures,
      schemaVersion: "resume-assessment/v1",
    } as AssessmentV1Type;
    expect(canonicalJson(AssessmentV1.parse(reordered))).toBe(first);
    expect(canonicalJson(AssessmentV1.parse(keywordFixture()))).toBe(first);
  });

  it("represents zero denominators as not_assessed, never 0/0", () => {
    const empty = keywordFixture();
    empty.measures[0] = {
      key: "selected_keywords",
      original: { status: "not_assessed", reason: "NO_ELIGIBLE_ITEMS" },
      tailored: { status: "not_assessed", reason: "NO_ELIGIBLE_ITEMS" },
      itemIds: [],
    };
    expect(AssessmentV1.parse(empty).measures[0]?.original).toEqual({
      status: "not_assessed",
      reason: "NO_ELIGIBLE_ITEMS",
    });
    const zeroed = keywordFixture();
    zeroed.measures[0] = {
      ...zeroed.measures[0],
      tailored: { status: "assessed", numerator: 0, denominator: 0 },
    };
    expect(AssessmentV1.safeParse(zeroed).success).toBe(false);
  });

  it("rejects numerator above denominator and duplicate measure keys", () => {
    const over = keywordFixture();
    over.measures[1] = {
      ...over.measures[1],
      tailored: { status: "assessed", numerator: 6, denominator: 5 },
    };
    expect(AssessmentV1.safeParse(over).success).toBe(false);
    const duped = keywordFixture();
    duped.measures[3] = { ...duped.measures[3], key: "selected_keywords" };
    expect(AssessmentV1.safeParse(duped).success).toBe(false);
  });

  it("carries no numeric delta on an unassessed baseline", () => {
    const baseline = keywordFixture().measures[1]?.original;
    expect(baseline?.status).toBe("not_assessed");
    expect(baseline).not.toHaveProperty("numerator");
    expect(baseline).not.toHaveProperty("denominator");
    const assessed = keywordFixture().measures[0];
    expect(assessed?.original.status).toBe("assessed");
    expect(assessed?.tailored.status).toBe("assessed");
  });
});
