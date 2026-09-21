import { describe, expect, it } from "vitest";
import {
  buildFocusSection,
  buildGuidanceSection,
  extractDeterministicFallback,
  validateTailoringInput,
} from "../../../scripts/tailor-provider.mjs";
import { v2FocusPair } from "../tailoring/v2FocusFixtures";

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

describe("v2 input gate (E3)", () => {
  function v2Input(overrides: Record<string, unknown> = {}) {
    const { focus, recommendations } = v2FocusPair();
    return {
      schemaVersion: "tailoring-input/v2",
      promptVersion: "tailor-prompt/v2",
      jobId: "job-v2-1",
      jdSnapshotId: "jd-v2-1",
      candidateSnapshotId: "cs-v2-1",
      jdText: "Build APIs with Redis caching.",
      approvedFactIds: ["f_scale"],
      focus,
      recommendations,
      ...overrides,
    };
  }

  it("accepts v1 and v2 envelopes with their paired prompts", () => {
    expect(
      validateTailoringInput({
        schemaVersion: "tailoring-input/v1",
        promptVersion: "tailor-prompt/v1",
        jobId: "job-1",
        jdSnapshotId: "jd-1",
        candidateSnapshotId: "cs-1",
        jdText: "Build APIs.",
        approvedFactIds: [],
      }),
    ).toEqual({ ok: true });
    expect(validateTailoringInput(v2Input())).toEqual({ ok: true });
    expect(validateTailoringInput(v2Input({ revisionNote: "n".repeat(4000) }))).toEqual({
      ok: true,
    });
  });

  it("refuses version, prompt, snapshot, and bound violations before any call", () => {
    expect(validateTailoringInput(v2Input({ schemaVersion: "tailoring-input/v9" }))).toMatchObject({
      ok: false,
    });
    expect(validateTailoringInput(v2Input({ promptVersion: "tailor-prompt/v1" }))).toMatchObject({
      ok: false,
    });
    expect(validateTailoringInput(v2Input({ focus: null }))).toMatchObject({ ok: false });
    expect(
      validateTailoringInput(v2Input({ selectedKeywords: ["k".repeat(129)] })),
    ).toMatchObject({ ok: false });
    expect(validateTailoringInput(v2Input({ directives: "d".repeat(1001) }))).toMatchObject({
      ok: false,
    });
    expect(validateTailoringInput(v2Input({ revisionNote: "n".repeat(4001) }))).toMatchObject({
      ok: false,
    });
  });
});

describe("v2 focus steering (E3)", () => {
  it("names theme, summary direction, and mappings as evidenced-only steering", () => {
    const { focus, recommendations } = v2FocusPair({
      focus: { summaryDirection: "Emphasize Redis caching outcomes." },
    });
    const section = buildFocusSection({
      schemaVersion: "tailoring-input/v2",
      focus,
      recommendations,
    });
    expect(section).toContain("FOCUS STEERING");
    expect(section).toContain("Chosen theme: experience");
    expect(section).toContain("Requested summary direction");
    expect(section).toContain("Emphasize Redis caching outcomes.");
    expect(section).toContain("Redis caching → Engineer @ Acme (f_scale)");
    expect(section).toContain("only when identifying");
    expect(section).toContain("never invent evidence");
    expect(
      buildGuidanceSection({
        schemaVersion: "tailoring-input/v2",
        selectedKeywords: ["Redis caching"],
        focus,
        recommendations,
      }),
    ).toContain("FOCUS STEERING");
  });
});
