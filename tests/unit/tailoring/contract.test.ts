// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AuditSummaryV1,
  ProviderAttemptV1,
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  TAILOR_PROMPT_VERSION,
  TAILOR_PROMPT_VERSION_V2,
  TAILORING_INPUT_SCHEMA_VERSION,
  TAILORING_INPUT_SCHEMA_VERSION_V2,
  TailoringInputAnyVersion,
  TailoringInputV1,
  TailoringInputV2,
} from "../../../src/tailoring/contract";
import { v2FocusPair } from "./v2FocusFixtures";

const PROFILE = {
  full_name: "Contract Candidate",
  work_experience: [],
  verified_facts: [],
  skills: [],
  education: [],
};

const REQUIREMENT = {
  requirement_id: "req_1",
  jd_quote: "Build APIs.",
  category: "skill",
  importance: "required",
  match_status: "matched",
  evidence_fact_ids: ["f1"],
  evidence_quotes: ["Built APIs."],
  review_status: "confirmed",
};

function validProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
    jdSnapshotId: "jd-1",
    candidateSnapshotId: "cs-1",
    requirements: [REQUIREMENT],
    rationale: "Mapped one requirement.",
    questions: [],
    ...overrides,
  };
}

describe("provider contract schemas", () => {
  it("accepts a minimal valid proposal and input", () => {
    expect(() => ResumeProposalV1.parse(validProposal())).not.toThrow();
    expect(() =>
      TailoringInputV1.parse({
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION,
        jobId: "job-1",
        jobTitle: "Engineer",
        company: "Acme",
        jdSnapshotId: "jd-1",
        jdText: "Build APIs.",
        candidateSnapshotId: "cs-1",
        profile: PROFILE,
        approvedFactIds: ["f1"],
        promptVersion: TAILOR_PROMPT_VERSION,
      }),
    ).not.toThrow();
  });

  it("rejects provider approval, path, hash, template, and coverage fields", () => {
    for (const [key, value] of [
      ["approval", "APPROVED"],
      ["approved", true],
      ["templatePath", "/tmp/evil.html"],
      ["template_id", "attacker_template"],
      ["outputPath", "/tmp/x.pdf"],
      ["artifactHash", "0".repeat(64)],
      ["contentHash", "0".repeat(64)],
      ["coverage", 1.0],
      ["coverageScore", 0.99],
    ] as const) {
      const parsed = ResumeProposalV1.safeParse(validProposal({ [key]: value }));
      expect(parsed.success, `field ${key} must be rejected`).toBe(false);
    }
  });

  it("rejects unknown fields anywhere in the proposal", () => {
    expect(ResumeProposalV1.safeParse(validProposal({ extra: 1 })).success).toBe(false);
    expect(
      ResumeProposalV1.safeParse(
        validProposal({ requirements: [{ ...REQUIREMENT, injected: true }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects wrong versions, empty requirements, and oversized text", () => {
    expect(
      ResumeProposalV1.safeParse(validProposal({ schemaVersion: "resume-proposal/v9" })).success,
    ).toBe(false);
    expect(ResumeProposalV1.safeParse(validProposal({ requirements: [] })).success).toBe(false);
    expect(
      ResumeProposalV1.safeParse(validProposal({ rationale: "x".repeat(2001) })).success,
    ).toBe(false);
    expect(
      ResumeProposalV1.safeParse(
        validProposal({ questions: Array.from({ length: 21 }, () => "q") }),
      ).success,
    ).toBe(false);
  });

  it("rejects invalid requirement enums and empty evidence bindings", () => {
    expect(
      ResumeProposalV1.safeParse(
        validProposal({ requirements: [{ ...REQUIREMENT, match_status: "maybe" }] }),
      ).success,
    ).toBe(false);
    expect(
      ResumeProposalV1.safeParse(
        validProposal({ requirements: [{ ...REQUIREMENT, category: "vibes" }] }),
      ).success,
    ).toBe(false);
    expect(
      ResumeProposalV1.safeParse(
        validProposal({ requirements: [{ ...REQUIREMENT, requirement_id: "  " }] }),
      ).success,
    ).toBe(false);
  });
});

describe("v1.3 provider input (E3)", () => {
  function baseInput() {
    const { focus, recommendations } = v2FocusPair();
    return {
      jobId: "job-v2-1",
      jobTitle: "Engineer",
      company: "Acme",
      jdSnapshotId: "jd-v2-1",
      jdText: "Build APIs with Redis caching.",
      candidateSnapshotId: "cs-v2-1",
      profile: PROFILE,
      approvedFactIds: ["f1"],
      profileId: "local",
      selectedKeywords: ["Redis caching"],
      directives: "Emphasize caching.",
      focus,
      recommendations,
    };
  }

  it("accepts the frozen v2 envelope with a 4000-character revision note", () => {
    const parsed = TailoringInputV2.safeParse({
      ...baseInput(),
      schemaVersion: TAILORING_INPUT_SCHEMA_VERSION_V2,
      promptVersion: TAILOR_PROMPT_VERSION_V2,
      revisionNote: "n".repeat(4000),
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps v1 steering bounds while v2 carries focus snapshots", () => {
    expect(
      TailoringInputV1.safeParse({
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION,
        jobId: "job-1",
        jobTitle: "Engineer",
        company: "Acme",
        jdSnapshotId: "jd-1",
        jdText: "Build APIs.",
        candidateSnapshotId: "cs-1",
        profile: PROFILE,
        approvedFactIds: ["f1"],
        promptVersion: TAILOR_PROMPT_VERSION,
        revisionNote: "n".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      TailoringInputV2.safeParse({
        ...baseInput(),
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION_V2,
        promptVersion: TAILOR_PROMPT_VERSION_V2,
        selectedKeywords: ["k".repeat(129)],
      }).success,
    ).toBe(false);
    expect(
      TailoringInputV2.safeParse({
        ...baseInput(),
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION_V2,
        promptVersion: TAILOR_PROMPT_VERSION_V2,
        focus: undefined,
      }).success,
    ).toBe(false);
  });

  it("reads v1 and v2 inputs without relabeling prompt versions", () => {
    const v1 = TailoringInputAnyVersion.parse({
      schemaVersion: TAILORING_INPUT_SCHEMA_VERSION,
      jobId: "job-1",
      jobTitle: "Engineer",
      company: "Acme",
      jdSnapshotId: "jd-1",
      jdText: "Build APIs.",
      candidateSnapshotId: "cs-1",
      profile: PROFILE,
      approvedFactIds: ["f1"],
      promptVersion: TAILOR_PROMPT_VERSION,
    });
    const v2 = TailoringInputAnyVersion.parse({
      ...baseInput(),
      schemaVersion: TAILORING_INPUT_SCHEMA_VERSION_V2,
      promptVersion: TAILOR_PROMPT_VERSION_V2,
    });
    expect(v1.promptVersion).toBe(TAILOR_PROMPT_VERSION);
    expect(v2.promptVersion).toBe(TAILOR_PROMPT_VERSION_V2);
    expect(
      TailoringInputAnyVersion.safeParse({ ...v1, schemaVersion: "tailoring-input/v9" }).success,
    ).toBe(false);
  });

  it("accepts v1/v2 prompt versions in attempt and audit readers", () => {
    const attempt = {
      schemaVersion: "provider-attempt/v1",
      providerId: "command",
      model: null,
      executable: "node",
      argvHash: "a".repeat(64),
      configVersion: "command-adapter/v1",
      proposalSchemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
      startedAt: "2026-09-16T12:00:00.000Z",
      finishedAt: "2026-09-16T12:00:01.000Z",
      exitCode: 0,
      timedOut: false,
      outputBytes: 12,
      inputHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      questions: [],
    };
    expect(
      ProviderAttemptV1.parse({ ...attempt, promptVersion: TAILOR_PROMPT_VERSION }).promptVersion,
    ).toBe(TAILOR_PROMPT_VERSION);
    expect(
      ProviderAttemptV1.parse({ ...attempt, promptVersion: TAILOR_PROMPT_VERSION_V2 }).promptVersion,
    ).toBe(TAILOR_PROMPT_VERSION_V2);
    const audit = {
      schemaVersion: "audit-summary/v1",
      requirementsTotal: 1,
      supportedCount: 1,
      gapCount: 0,
      validatedClaims: 1,
      totalClaims: 1,
      factsReferenced: ["f1"],
      contentHash: "d".repeat(64),
      inputHash: "b".repeat(64),
      proposalHash: "c".repeat(64),
      providerId: "command",
      model: null,
      rationale: "ok",
      questions: [],
    };
    expect(
      AuditSummaryV1.parse({ ...audit, promptVersion: TAILOR_PROMPT_VERSION }).promptVersion,
    ).toBe(TAILOR_PROMPT_VERSION);
    expect(
      AuditSummaryV1.parse({ ...audit, promptVersion: TAILOR_PROMPT_VERSION_V2 }).promptVersion,
    ).toBe(TAILOR_PROMPT_VERSION_V2);
  });
});
