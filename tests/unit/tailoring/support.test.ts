import { describe, expect, it } from "vitest";
import {
  evaluateKeywordSupport,
  type SupportEvidence,
} from "../../../src/tailoring/support";

const EVIDENCE: SupportEvidence[] = [
  {
    factId: "fact-1",
    statement: "Led B2B SaaS onboarding for enterprise buyers",
    evidenceJson: JSON.stringify({ technologies: ["Salesforce"] }),
  },
  {
    factId: "fact-2",
    statement: "Owned stakeholder updates across product and design",
    evidenceJson: null,
  },
  {
    factId: "fact-3",
    statement: "Ran platform migrations on Kubernetes",
    evidenceJson: JSON.stringify({ technologies: ["Go", "Terraform"] }),
  },
];

describe("evaluateKeywordSupport", () => {
  it("marks co-occurring phrases supported with contributing facts", () => {
    expect(evaluateKeywordSupport(["B2B SaaS", "Kubernetes"], EVIDENCE)).toEqual([
      { keyword: "B2B SaaS", status: "supported", factIds: ["fact-1"] },
      { keyword: "Kubernetes", status: "supported", factIds: ["fact-3"] },
    ]);
  });

  it("marks scattered or partial phrases uncertain, never supported", () => {
    // "stakeholder" in fact-2, "management" nowhere: partial.
    // "platform strategy": "platform" in fact-3, "strategy" nowhere.
    expect(
      evaluateKeywordSupport(["stakeholder management", "platform strategy"], EVIDENCE),
    ).toEqual([
      { keyword: "stakeholder management", status: "uncertain", factIds: ["fact-2"] },
      { keyword: "platform strategy", status: "uncertain", factIds: ["fact-3"] },
    ]);
  });

  it("marks phrases with no evidence gap without inventing facts", () => {
    expect(evaluateKeywordSupport(["forecast accuracy", "Rust"], EVIDENCE)).toEqual([
      { keyword: "forecast accuracy", status: "gap", factIds: [] },
      { keyword: "Rust", status: "gap", factIds: [] },
    ]);
  });

  it("matches whole terms only and normalizes punctuation", () => {
    // "Go" must not match "ongoing"; "CI/CD" matches "ci cd pipelines".
    const evidence: SupportEvidence[] = [
      { factId: "fact-9", statement: "Ongoing migration work", evidenceJson: null },
      { factId: "fact-10", statement: "Own ci cd pipelines", evidenceJson: null },
    ];
    expect(evaluateKeywordSupport(["Go", "CI/CD"], evidence)).toEqual([
      { keyword: "Go", status: "gap", factIds: [] },
      { keyword: "CI/CD", status: "supported", factIds: ["fact-10"] },
    ]);
  });

  it("is deterministic and total over empty evidence", () => {
    const keywords = ["B2B SaaS", "Kubernetes", "forecast accuracy"];
    expect(evaluateKeywordSupport(keywords, [])).toEqual(
      keywords.map((keyword) => ({ keyword, status: "gap", factIds: [] })),
    );
    expect(evaluateKeywordSupport(keywords, EVIDENCE)).toEqual(
      evaluateKeywordSupport(keywords, EVIDENCE),
    );
  });
});
