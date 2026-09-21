// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildTailoredDraft } from "../../../src/tailoring/draft";
import {
  evaluateFocusOutcomes,
  orderRankedFactsWithFocus,
  summaryGapDrafts,
} from "../../../src/tailoring/focusSteering";
import { E2E_JD_TEXT, e2eProfile, e2eProposal } from "./support";
import { V2_REDIS_PHRASE_ID, v2FocusPair } from "./v2FocusFixtures";

/**
 * E3 compiler leg: supported mappings reorder eligible facts without
 * changing the eligible set or budgets; foreign mappings steer nothing;
 * invented summary wording becomes an explicit gap; supported
 * paraphrases report not-assessed rather than a false verdict.
 */

const REQUIREMENTS = (
  e2eProposal("jd-1", "cs-1")["requirements"] as Array<Record<string, unknown>>
).map((entry) => ({
  requirementId: String(entry["requirement_id"]),
  jdQuote: String(entry["jd_quote"]),
  matchStatus: String(entry["match_status"]),
  evidenceFactIds: [...(entry["evidence_fact_ids"] as string[])],
}));
const PROVIDER_GAPS = [
  {
    requirementId: "req_cobol",
    jdQuote: "COBOL migration experience is a plus",
    matchStatus: "unsupported",
    category: "skill",
  },
  {
    requirementId: "req_k8s",
    jdQuote: "Kubernetes deployment skills required",
    matchStatus: "gap",
    category: "skill",
  },
];

describe("focus ranking steering", () => {
  it("prioritizes a supported mapping while preserving the eligible set", () => {
    const profile = e2eProfile();
    const { focus, recommendations } = v2FocusPair();
    const legacy = buildTailoredDraft({
      profile,
      requirements: e2eProposal("jd-1", "cs-1")["requirements"],
      jobId: "job-1",
      jobTitle: "Backend Engineer",
      jobCompany: "Acme",
      asOf: "2024-05-01",
    });
    const steered = buildTailoredDraft({
      profile,
      requirements: e2eProposal("jd-1", "cs-1")["requirements"],
      jobId: "job-1",
      jobTitle: "Backend Engineer",
      jobCompany: "Acme",
      asOf: "2024-05-01",
      focusSteering: { focus, recommendations },
    });
    expect(legacy.rankedFactIds[0]).not.toBe("f_scale");
    expect(steered.rankedFactIds[0]).toBe("f_scale");
    expect(new Set(steered.rankedFactIds)).toEqual(new Set(legacy.rankedFactIds));
    expect(steered.draft.claims).toHaveLength(legacy.draft.claims.length);
  });

  it("ignores foreign mapping facts without changing the rank", () => {
    const profile = e2eProfile();
    const { focus, recommendations } = v2FocusPair({
      focus: {
        selectedPhraseIds: [],
        mappings: [{ roleId: "emp-1", phraseId: V2_REDIS_PHRASE_ID, factIds: ["f_api"] }],
      },
    });
    const ordered = orderRankedFactsWithFocus({
      rankedFactIds: ["f_api", "f_auth", "f_scale"],
      profile,
      focus,
      recommendations,
    });
    expect(ordered.rankedFactIds).toEqual(["f_api", "f_auth", "f_scale"]);
  });
});

describe("focus outcomes", () => {
  function evaluated(summaryDirection: string) {
    const profile = e2eProfile();
    const { focus, recommendations } = v2FocusPair({ focus: { summaryDirection } });
    const built = buildTailoredDraft({
      profile,
      requirements: e2eProposal("jd-1", "cs-1")["requirements"],
      jobId: "job-1",
      jobTitle: "Backend Engineer",
      jobCompany: "Acme",
      asOf: "2024-05-01",
      focusSteering: { focus, recommendations },
    });
    const summaryClaim = built.draft.claims.find((claim) => claim["section"] === "summary");
    return evaluateFocusOutcomes({
      profile,
      focus,
      recommendations,
      requirements: REQUIREMENTS,
      gaps: PROVIDER_GAPS,
      rankedFactIds: built.rankedFactIds,
      citedFactIds: built.citedFactIds,
      renderedSummaryText: String(summaryClaim?.["text"] ?? ""),
      summaryFactIds: (summaryClaim?.["fact_ids"] as string[] | undefined) ?? [],
      jdText: E2E_JD_TEXT,
    });
  }

  it("reports used mapping/selection/theme outcomes with supporting facts", () => {
    const outcomes = evaluated("");
    expect(
      outcomes.find((outcome) => outcome.field === "mappings"),
    ).toMatchObject({
      outcome: "used",
      phraseId: V2_REDIS_PHRASE_ID,
      evidenceFactIds: ["f_scale"],
    });
    expect(
      outcomes.find((outcome) => outcome.field === "selectedPhraseIds"),
    ).toMatchObject({ outcome: "used", evidenceFactIds: ["f_scale"] });
    expect(outcomes.find((outcome) => outcome.field === "themeId")).toMatchObject({
      outcome: "used",
    });
    expect(outcomes.some((outcome) => outcome.field === "summaryDirection")).toBe(false);
  });

  it("marks invented tooling/metrics unsupported and unassessed paraphrases not-assessed", () => {
    const outcomes = evaluated(
      "NetSuite ERP rollout delivered 30% faster implementations. Backend Engineer specializing in TypeScript delivery.",
    );
    const summary = outcomes.filter((outcome) => outcome.field === "summaryDirection");
    expect(summary.map((outcome) => outcome.outcome)).toEqual(["unsupported", "not-assessed"]);
    expect(summary[0]?.requirementIds).toEqual(["summary-0"]);
    expect(summary[0]?.evidenceFactIds).toEqual([]);
    expect(summary[1]?.evidenceFactIds).toEqual(["f_api"]);
    const gaps = summaryGapDrafts({
      profile: e2eProfile(),
      summaryDirection: "NetSuite ERP rollout delivered 30% faster implementations.",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.requirementId).toBe("summary-0");
    expect(gaps[0]?.explanation).toContain("NetSuite");
  });

  it("reports supported-but-unrendered selections as omitted-by-budget", () => {
    const profile = e2eProfile();
    const { focus, recommendations } = v2FocusPair();
    const outcomes = evaluateFocusOutcomes({
      profile,
      focus,
      recommendations,
      requirements: REQUIREMENTS,
      gaps: PROVIDER_GAPS,
      rankedFactIds: ["f_api", "f_auth", "f_scale"],
      citedFactIds: [],
      renderedSummaryText: "",
      summaryFactIds: [],
      jdText: E2E_JD_TEXT,
    });
    expect(
      outcomes.find((outcome) => outcome.field === "selectedPhraseIds"),
    ).toMatchObject({ outcome: "omitted-by-budget", evidenceFactIds: ["f_scale"] });
  });
});
