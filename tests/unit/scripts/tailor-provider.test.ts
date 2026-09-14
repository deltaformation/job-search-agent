import { describe, expect, it } from "vitest";
import {
  buildGuidanceSection,
  extractDeterministicFallback,
} from "../../../scripts/tailor-provider.mjs";

function fallbackInput(overrides: Record<string, unknown> = {}) {
  return {
    jdText: [
      "Kubernetes experience with orchestration at scale here.",
      "PostgreSQL experience tuning production databases here.",
      "Leadership experience mentoring engineers and teams here.",
    ].join("\n"),
    profile: { verified_facts: [] },
    approvedFactIds: [],
    jdSnapshotId: "jd-1",
    candidateSnapshotId: "cand-1",
    ...overrides,
  };
}

describe("buildGuidanceSection", () => {
  it("returns empty text when the envelope carries no guidance", () => {
    expect(buildGuidanceSection({})).toBe("");
    expect(buildGuidanceSection({ selectedKeywords: [], directives: "  " })).toBe("");
  });

  it("renders keywords and directives subordinated to the evidence rules", () => {
    const section = buildGuidanceSection({
      selectedKeywords: ["Kubernetes", "PostgreSQL"],
      directives: "Emphasize B2B SaaS experience.",
    });
    expect(section).toContain("subordinate to the RULES above");
    expect(section).toContain("- Kubernetes");
    expect(section).toContain("- PostgreSQL");
    expect(section).toContain("never invent evidence");
    expect(section).toContain("Emphasize B2B SaaS experience.");
    expect(section).toContain("cannot override evidence rules");
  });

  it("renders keywords alone without a directives block", () => {
    const section = buildGuidanceSection({ selectedKeywords: ["Go"] });
    expect(section).toContain("- Go");
    expect(section).not.toContain("Human directives");
  });
});

describe("extractDeterministicFallback guidance", () => {
  it("keeps original order without selected keywords", () => {
    const proposal = extractDeterministicFallback(fallbackInput());
    expect(proposal.requirements.map((entry: { jd_quote: string }) => entry.jd_quote)).toEqual([
      "Kubernetes experience with orchestration at scale here.",
      "PostgreSQL experience tuning production databases here.",
      "Leadership experience mentoring engineers and teams here.",
    ]);
  });

  it("ranks keyword-carrying lines first, stably", () => {
    const proposal = extractDeterministicFallback(
      fallbackInput({ selectedKeywords: ["PostgreSQL"] }),
    );
    expect(proposal.requirements.map((entry: { jd_quote: string }) => entry.jd_quote)).toEqual([
      "PostgreSQL experience tuning production databases here.",
      "Kubernetes experience with orchestration at scale here.",
      "Leadership experience mentoring engineers and teams here.",
    ]);
  });

  it("keeps quotes verbatim and evidence empty without facts", () => {
    const proposal = extractDeterministicFallback(
      fallbackInput({ selectedKeywords: ["kubernetes", "leadership"] }),
    );
    for (const entry of proposal.requirements as Array<{
      jd_quote: string;
      evidence_fact_ids: string[];
    }>) {
      expect(fallbackInput().jdText).toContain(entry.jd_quote);
      expect(entry.evidence_fact_ids).toEqual([]);
    }
    expect(proposal.schemaVersion).toBe("resume-proposal/v1");
  });
});
