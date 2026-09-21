import { describe, expect, it } from "vitest";
import {
  evaluateDirectiveOutcomes,
  evaluateTermOutcomes,
} from "../../../src/tailoring/coaching";

const REQUIREMENTS = [
  {
    requirementId: "req_001",
    jdQuote: "Own product strategy and roadmap prioritization",
    matchStatus: "matched",
    evidenceFactIds: ["fact-roadmap"],
  },
  {
    requirementId: "req_002",
    jdQuote: "Scale B2B SaaS onboarding",
    matchStatus: "partial",
    evidenceFactIds: ["fact-discovery"],
  },
];

const GAPS = [
  { requirementId: "req_003", jdQuote: "Grow ARR to $50M in year one", matchStatus: "gap" },
];

const JD = "Own product strategy and roadmap prioritization. Scale B2B SaaS onboarding. Grow ARR to $50M. Kubernetes experience preferred.";

describe("evaluateTermOutcomes", () => {
  it("reports used terms with their rendered evidence", () => {
    const outcomes = evaluateTermOutcomes({
      selectedKeywords: ["product strategy"],
      requirements: REQUIREMENTS,
      gaps: GAPS,
      claims: [{ requirementRef: "req_001" }],
      jdText: JD,
    });
    expect(outcomes).toEqual([
      {
        term: "product strategy",
        outcome: "used",
        requirementIds: ["req_001"],
        evidenceFactIds: ["fact-roadmap"],
        detail: "The run rendered evidence for this term.",
      },
    ]);
  });

  it("distinguishes budget omissions from honest gaps", () => {
    const outcomes = evaluateTermOutcomes({
      selectedKeywords: ["B2B SaaS", "ARR"],
      requirements: REQUIREMENTS,
      gaps: GAPS,
      claims: [],
      jdText: JD,
    });
    expect(outcomes).toEqual([
      {
        term: "B2B SaaS",
        outcome: "omitted-by-budget",
        requirementIds: ["req_002"],
        evidenceFactIds: ["fact-discovery"],
        detail:
          "Supported by profile facts, but the run rendered nothing for it — the evidence budget went elsewhere.",
      },
      {
        term: "ARR",
        outcome: "unsupported",
        requirementIds: ["req_003"],
        evidenceFactIds: [],
        detail: "No profile facts back this term — honestly kept off the resume.",
      },
    ]);
  });

  it("reports unextracted JD terms as not-assessed and foreign terms as not-applicable", () => {
    const outcomes = evaluateTermOutcomes({
      selectedKeywords: ["Kubernetes", "C2 clearance"],
      requirements: REQUIREMENTS,
      gaps: GAPS,
      claims: [{ requirementRef: "req_001" }],
      jdText: JD,
    });
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["not-assessed", "not-applicable"]);
    expect(outcomes[0]?.detail).toContain("steered ranking only");
    expect(outcomes[1]?.detail).toContain("Not in the job description");
  });

  it("matches normalized phrases across punctuation variants", () => {
    const outcomes = evaluateTermOutcomes({
      selectedKeywords: ["go-to-market"],
      requirements: [
        {
          requirementId: "req_009",
          jdQuote: "Lead go to market launches",
          matchStatus: "matched",
          evidenceFactIds: ["fact-gtm"],
        },
      ],
      gaps: [],
      claims: [{ requirementRef: "req_009" }],
      jdText: "Lead go to market launches.",
    });
    expect(outcomes).toEqual([
      {
        term: "go-to-market",
        outcome: "used",
        requirementIds: ["req_009"],
        evidenceFactIds: ["fact-gtm"],
        detail: "The run rendered evidence for this term.",
      },
    ]);
  });
});

describe("evaluateDirectiveOutcomes", () => {
  it("maps stored lines to directive gaps by index", () => {
    const { recorded, outcomes } = evaluateDirectiveOutcomes({
      directivesText: "Emphasize platform wins.\nGrow ARR to $50M in year one.",
      directiveGaps: [{ requirementId: "directive-1", explanation: "KPI token \"50m\" is not backed" }],
    });
    expect(recorded).toBe(true);
    expect(outcomes).toEqual([
      { index: 0, directive: "Emphasize platform wins.", outcome: "used", explanation: null },
      {
        index: 1,
        directive: "Grow ARR to $50M in year one.",
        outcome: "unsupported",
        explanation: "KPI token \"50m\" is not backed",
      },
    ]);
  });

  it("reports unrecorded directives honestly", () => {
    expect(
      evaluateDirectiveOutcomes({ directivesText: null, directiveGaps: [] }),
    ).toEqual({ recorded: false, outcomes: [] });
  });
});
