// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  TAILOR_PROMPT_VERSION,
  TAILORING_INPUT_SCHEMA_VERSION,
  TailoringInputV1,
} from "../../../src/tailoring/contract";

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
