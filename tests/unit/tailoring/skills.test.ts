// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  locateKeywordPlacements,
  planSkillRows,
  quoteAppearsIn,
  selectTopKeywords,
} from "../../../src/tailoring/keywords";
import { e2eProfile } from "./support";

function matchedRequirement(id: string, quote: string): Record<string, unknown> {
  return {
    requirement_id: id,
    jd_quote: quote,
    category: "skill",
    importance: "required",
    match_status: "matched",
    evidence_fact_ids: ["f_api"],
    evidence_quotes: [],
    review_status: "confirmed",
  };
}

describe("categorized skill rows", () => {
  it("groups verified skills by category with JD matches first", () => {
    const profile = {
      ...e2eProfile(),
      skills: [
        { name: "Zebra Skill", category: "Cat A", verified: true },
        { name: "TypeScript", category: "Cat A", verified: true },
        { name: "Alpha Skill", category: "Cat B", verified: true },
        { name: "Unverified Skill", category: "Cat B", verified: false },
        { name: "No Category Skill", verified: true },
      ],
    };
    const rows = planSkillRows({
      profile,
      requirements: [matchedRequirement("r1", "TypeScript experience needed")],
    });
    expect(rows).toEqual([
      { label: "Cat A", terms: ["TypeScript", "Zebra Skill"] },
      { label: "Cat B", terms: ["Alpha Skill"] },
      { label: "Other", terms: ["No Category Skill"] },
    ]);
  });

  it("ignores gap quotes and non-record requirements for ordering", () => {
    const profile = {
      ...e2eProfile(),
      skills: [
        { name: "COBOL", category: "Legacy", verified: true },
        { name: "TypeScript", category: "Legacy", verified: true },
      ],
    };
    const rows = planSkillRows({
      profile,
      requirements: [
        "not-a-record",
        { ...matchedRequirement("r1", "COBOL migration experience"), match_status: "gap" },
        matchedRequirement("r2", "TypeScript API experience"),
      ],
    });
    // The gap quote never promotes COBOL; the supported quote promotes TypeScript.
    expect(rows).toEqual([{ label: "Legacy", terms: ["TypeScript", "COBOL"] }]);
  });

  it("returns no rows when nothing is verified", () => {
    const profile = { ...e2eProfile(), skills: [{ name: "Rust", verified: false }] };
    expect(planSkillRows({ profile, requirements: [] })).toEqual([]);
  });

  it("sorts priority-quote matches ahead of other JD matches", () => {
    const profile = {
      ...e2eProfile(),
      skills: [
        { name: "TypeScript", category: "Languages", verified: true },
        { name: "Kafka", category: "Languages", verified: true },
        { name: "COBOL", category: "Languages", verified: true },
      ],
    };
    const requirements = [
      matchedRequirement("r1", "TypeScript API experience"),
      matchedRequirement("r2", "Kafka streaming experience"),
    ];
    const rows = planSkillRows({
      profile,
      requirements,
      priorityQuotes: ["Kafka streaming experience"],
    });
    expect(rows).toEqual([
      { label: "Languages", terms: ["Kafka", "TypeScript", "COBOL"] },
    ]);
  });
});

describe("selectTopKeywords", () => {
  function requirement(
    id: string,
    quote: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      requirement_id: id,
      jd_quote: quote,
      category: "skill",
      importance: "required",
      match_status: "matched",
      evidence_fact_ids: ["f_api"],
      evidence_quotes: [],
      review_status: "confirmed",
      ...overrides,
    };
  }

  it("orders required-first, then evidenced before gaps, capped at five", () => {
    const requirements = [
      requirement("r1", "Preferred nice-to-have", { importance: "preferred" }),
      requirement("r2", "Required gap quote", { match_status: "gap", evidence_fact_ids: [] }),
      requirement("r3", "Required partial quote", { match_status: "partial" }),
      requirement("r4", "Required matched quote", { match_status: "matched" }),
      requirement("r5", "Unspecified matched quote", { importance: "unspecified" }),
      requirement("r6", "Second required matched quote", { match_status: "matched" }),
      requirement("r7", "Third required matched quote", { match_status: "matched" }),
    ];
    const top = selectTopKeywords(requirements);
    expect(top.map((entry) => entry.requirementId)).toEqual(["r4", "r6", "r7", "r3", "r2"]);
    expect(top[4]).toMatchObject({ evidenced: false, evidenceFactIds: [] });
    expect(top[0]).toMatchObject({
      keyword: "Required matched quote",
      category: "skill",
      importance: "required",
      evidenced: true,
      evidenceFactIds: ["f_api"],
    });
  });

  it("skips records without a quote or id and tolerates non-arrays", () => {
    expect(selectTopKeywords("nope")).toEqual([]);
    expect(
      selectTopKeywords([
        "not-a-record",
        { requirement_id: "r1" },
        { jd_quote: "orphan quote" },
        requirement("r2", "kept quote"),
      ]),
    ).toEqual([
      {
        keyword: "kept quote",
        requirementId: "r2",
        category: "skill",
        importance: "required",
        evidenced: true,
        evidenceFactIds: ["f_api"],
      },
    ]);
  });
});

describe("keyword placement audit", () => {
  it("detects exact and term-overlap mentions without false positives", () => {
    expect(quoteAppearsIn("Led Kafka streaming rollout", "Kafka streaming")).toBe(true);
    expect(quoteAppearsIn("Led a Kafka based streaming rollout", "Kafka streaming platform")).toBe(
      true,
    );
    expect(quoteAppearsIn("Led the team with care", "Kafka streaming platform")).toBe(false);
    expect(quoteAppearsIn("", "Kafka")).toBe(false);
    expect(quoteAppearsIn("Kafka experience", "")).toBe(false);
  });

  it("locates placements across sections", () => {
    expect(
      locateKeywordPlacements({
        keyword: "Kafka streaming experience",
        headerText: "Jane Doe",
        summaryText: "Product leader with Kafka streaming experience.",
        skillTerms: ["Kafka", "SQL"],
        bulletTexts: ["Shipped APIs."],
      }),
    ).toEqual(["summary", "skills"]);
    expect(
      locateKeywordPlacements({
        keyword: "COBOL migration",
        headerText: "Jane Doe",
        summaryText: "Product leader.",
        skillTerms: ["Kafka"],
        bulletTexts: ["Led COBOL migration effort."],
      }),
    ).toEqual(["experience"]);
    expect(
      locateKeywordPlacements({
        keyword: "COBOL migration",
        headerText: "Jane Doe",
        summaryText: "Product leader.",
        skillTerms: ["Kafka"],
        bulletTexts: ["Shipped APIs."],
      }),
    ).toEqual([]);
  });
});
