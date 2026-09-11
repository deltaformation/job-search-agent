// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalText } from "../../../src/domain/canonical";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { evidenceQualifiedSkills, planKeywords } from "../../../src/tailoring/keywords";
import { rankFacts } from "../../../src/tailoring/ranking";
import { checkGenerationInputs } from "../../../src/tailoring/staleness";
import { composeSummary, unionedCareerMonths, verifyDerivation } from "../../../src/tailoring/summary";
import {
  validateClaim,
  validateDraft,
  validateRequirements,
  validateSubmission,
} from "../../../src/tailoring/validator";

/**
 * Adversarial tests for new MVP inputs (R4-C). Parity suites prove the port
 * matches the oracle on R4-B fixtures; these tests prove the fail-closed
 * contract on hostile or malformed inputs the fixtures do not cover: no
 * invented facts, no smuggled unsupported claims, no silent coercions, and
 * structured errors instead of crashes for agent-supplied data.
 */
const PROFILE = {
  id: "cand-adv-001",
  verified_facts: [
    {
      fact_id: "f1",
      work_experience_id: "exp1",
      category: "experience",
      text: "Led API migration to TypeScript",
      technologies: ["TypeScript"],
      metrics: ["40% faster"],
      verification_status: "approved",
    },
    {
      fact_id: "f2",
      work_experience_id: "exp1",
      category: "experience",
      text: "Unreviewed draft claim",
      technologies: [],
      metrics: [],
      verification_status: "proposed",
    },
  ],
  work_experience: [
    {
      id: "exp1",
      company: "Acme",
      role: "Engineer",
      start_date: "2020-01-15",
      end_date: "2022-06-30",
      is_current: false,
    },
  ],
  skills: [
    { name: "TypeScript", verified: true },
    { name: "COBOL", verified: true },
    { name: "Rust", verified: false },
  ],
  education: [],
};

const JD = "We need TypeScript API experience. COBOL familiarity is a plus.";
const JD_TEXTS = { quote: "We need TypeScript API experience." };

function experienceClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim_id: "c1",
    section: "experience",
    text: "Led API migration to TypeScript",
    fact_ids: ["f1"],
    company: "Acme",
    role: "Engineer",
    entity_id: "exp1",
    dates: { start: "2020-01-15", end: "2022-06-30" },
    ...overrides,
  };
}

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement_id: "req_ts",
    jd_quote: JD_TEXTS.quote,
    match_status: "matched",
    importance: "required",
    category: "skill",
    review_status: "confirmed",
    evidence_fact_ids: ["f1"],
    evidence_quotes: ["Led API migration to TypeScript"],
    ...overrides,
  };
}

describe("adversarial: requirement validation", () => {
  it("rejects smuggled evidence on unsupported requirements", () => {
    const result = validateRequirements({
      profile: PROFILE,
      requirements: [
        requirement({ match_status: "unsupported", evidence_fact_ids: ["f1"], evidence_quotes: [] }),
      ],
      jdText: JD,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("contains evidence fact IDs"))).toBe(true);
  });

  it("rejects smuggled evidence quotes on gap requirements", () => {
    const result = validateRequirements({
      profile: PROFILE,
      requirements: [
        requirement({
          match_status: "gap",
          evidence_fact_ids: [],
          evidence_quotes: ["Led API migration to TypeScript"],
        }),
      ],
      jdText: JD,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("contains evidence quotes"))).toBe(true);
  });

  it("rejects citations of unapproved facts", () => {
    const result = validateRequirements({
      profile: PROFILE,
      requirements: [
        requirement({ evidence_fact_ids: ["f2"], evidence_quotes: ["Unreviewed draft claim"] }),
      ],
      jdText: JD,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("unknown or unapproved fact_id 'f2'"))).toBe(
      true,
    );
  });

  it("returns a structured error, not a crash, for mistyped agent inputs", () => {
    expect(validateRequirements({ profile: PROFILE, requirements: { not: "a list" } })).toEqual({
      valid: false,
      errors: ["Requirements must be a list."],
    });
    const mixed = validateRequirements({
      profile: PROFILE,
      requirements: [requirement({ evidence_fact_ids: ["f1", 42] })],
      jdText: JD,
    });
    expect(mixed.valid).toBe(false);
    expect(mixed.errors).toContain("Requirement 'req_ts' requires a list of fact IDs.");
  });

  it("rejects duplicate requirement ids", () => {
    const result = validateRequirements({
      profile: PROFILE,
      requirements: [requirement(), requirement()],
      jdText: JD,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Requirement IDs must be nonempty and unique.");
  });

  it("fails closed with ZodError on a corrupt candidate profile", () => {
    expect(() =>
      validateRequirements({ profile: { verified_facts: "corrupt" }, requirements: [requirement()] }),
    ).toThrow(z.ZodError);
  });

  it("rejects fabricated JD quotes", () => {
    const result = validateRequirements({
      profile: PROFILE,
      requirements: [requirement({ jd_quote: "Ten years of COBOL required" })],
      jdText: JD,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Requirement 'req_ts' must quote exact JD text.");
  });
});

describe("adversarial: claim validation", () => {
  it("accepts the honest baseline claim", () => {
    expect(validateClaim({ profile: PROFILE, claim: experienceClaim() })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects reworded text under the verbatim strategy", () => {
    const result = validateClaim({
      profile: PROFILE,
      claim: experienceClaim({ text: "Single-handedly reinvented the API in TypeScript" }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Text differs from approved fact text under verbatim strategy.");
  });

  it("rejects invented metrics and technologies", () => {
    const metrics = validateClaim({
      profile: PROFILE,
      claim: experienceClaim({ claimed_metrics: ["40% faster", "saved $10M"] }),
    });
    expect(metrics.valid).toBe(false);
    expect(metrics.errors).toContain("Metric tampering 'saved $10M' is not present in the cited fact.");
    const techs = validateClaim({
      profile: PROFILE,
      claim: experienceClaim({ claimed_technologies: ["TypeScript", "COBOL"] }),
    });
    expect(techs.valid).toBe(false);
    expect(techs.errors).toContain("Unverified technology 'COBOL' is not present in the cited fact.");
  });

  it("rejects misattributed employers and roles", () => {
    const employer = validateClaim({ profile: PROFILE, claim: experienceClaim({ company: "Globex" }) });
    expect(employer.valid).toBe(false);
    expect(employer.errors).toContain("Misattributed employer.");
    const role = validateClaim({ profile: PROFILE, claim: experienceClaim({ role: "CTO" }) });
    expect(role.valid).toBe(false);
    expect(role.errors).toContain("Role or employment identity does not match the cited fact.");
  });

  it("rejects stretched employment dates", () => {
    const result = validateClaim({
      profile: PROFILE,
      claim: experienceClaim({ dates: { start: "2018-01-01", end: "Present" } }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Employment dates do not match canonical evidence.");
  });

  it("rejects derived_template outside the summary", () => {
    const result = validateClaim({
      profile: PROFILE,
      claim: experienceClaim({ generation_strategy: "derived_template", derivation: {} }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("derived_template is allowed only for the summary.");
  });

  it("rejects unapproved and tampered wording variants", () => {
    const variant = {
      id: "v1",
      review_status: "proposed",
      variant_text: "Led API migration to TypeScript",
      content_hash: sha256HexUtf8("Led API migration to TypeScript"),
      candidate_id: "cand-adv-001",
      fact_ids: ["f1"],
    };
    const unapproved = validateClaim({
      profile: PROFILE,
      claim: {
        claim_id: "c1",
        section: "summary",
        text: "Led API migration to TypeScript",
        fact_ids: ["f1"],
        generation_strategy: "approved_variant",
        variant_id: "v1",
      },
      variants: [variant],
    });
    expect(unapproved.valid).toBe(false);
    expect(unapproved.errors).toContain("Wording variant 'v1' is not human-approved.");

    const tampered = validateClaim({
      profile: PROFILE,
      claim: {
        claim_id: "c1",
        section: "summary",
        text: "Led API migration to TypeScript",
        fact_ids: ["f1"],
        generation_strategy: "approved_variant",
        variant_id: "v1",
      },
      variants: [{ ...variant, review_status: "approved", content_hash: "0".repeat(64) }],
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.errors).toContain("Wording variant 'v1' hash mismatch.");
  });

  it("rejects unknown claim sections", () => {
    const result = validateClaim({
      profile: PROFILE,
      claim: { claim_id: "c1", section: "certifications", text: "AWS Hero", fact_ids: ["f1"] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported claim section: certifications.");
  });
});

describe("adversarial: drafts and submissions", () => {
  it("rejects empty drafts and duplicate claim ids", () => {
    const empty = validateDraft({ profile: PROFILE, draft: { claims: [] } });
    expect(empty.valid).toBe(false);
    expect(empty.report.errors).toContain("Draft must contain a nonempty claims list.");
    const duplicate = validateDraft({
      profile: PROFILE,
      draft: { claims: [experienceClaim(), experienceClaim()] },
    });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.report.errors).toContain("Claim IDs must be nonempty and unique.");
  });

  it("rejects submissions bound to stale snapshots", () => {
    const result = validateSubmission({
      profile: PROFILE,
      analysisData: {
        jd_snapshot_id: "jd-old",
        candidate_snapshot_id: "cand-old",
        requirements: [requirement()],
      },
      jdSnapshot: { id: "jd-new", cleaned_text: JD },
      candidateSnapshot: { id: "cand-new" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes("Stale or mismatched jd_snapshot_id"))).toBe(
      true,
    );
    expect(
      result.errors.some((message) => message.includes("Stale or mismatched candidate_snapshot_id")),
    ).toBe(true);
  });
});

describe("adversarial: ranking and keywords", () => {
  it("never ranks unapproved facts, even when they are the only cited evidence", () => {
    const result = rankFacts({
      profile: PROFILE,
      requirements: [
        requirement({ match_status: "unsupported", evidence_fact_ids: [], evidence_quotes: [] }),
        requirement({
          requirement_id: "req_draft",
          match_status: "matched",
          evidence_fact_ids: ["f2"],
          evidence_quotes: ["Unreviewed draft claim"],
        }),
      ],
    });
    expect(result.factIds).not.toContain("f2");
    const nothingApproved = rankFacts({
      profile: { ...PROFILE, verified_facts: [PROFILE.verified_facts[1]] },
      requirements: [requirement()],
    });
    expect(nothingApproved.factIds).toEqual([]);
  });

  it("caps per-role selections under adversarial config", () => {
    const result = rankFacts({
      profile: PROFILE,
      requirements: [requirement()],
      config: { maxPerRole: 0, maxPriorRole: 0, maxTotal: 14 },
    });
    expect(result.factIds).toEqual([]);
  });

  it("qualifies skills only from cited evidence, never from the name alone", () => {
    const qualified = evidenceQualifiedSkills({ profile: PROFILE, citedFactIds: ["f1"] });
    expect(qualified.skills).toContain("TypeScript");
    expect(qualified.skills).not.toContain("COBOL");
    expect(qualified.skills).not.toContain("Rust");
    const uncited = evidenceQualifiedSkills({ profile: PROFILE, citedFactIds: [] });
    expect(uncited.skills).toEqual([]);
  });

  it("reports but never renders unsupported terms", () => {
    const plan = planKeywords({
      profile: PROFILE,
      requirements: [requirement({ match_status: "unsupported", evidence_fact_ids: [] })],
      rankedFactIds: ["f1"],
    });
    expect(plan.terms).toHaveLength(1);
    expect(plan.terms[0]?.decision).toBe("omit_unsupported");
    expect(plan.terms[0]?.rendered_phrase).toBe("");
    expect(plan.terms[0]?.evidence_fact_ids).toEqual([]);
    expect(plan.omitted_unsupported).toContain(JD_TEXTS.quote);
    expect(plan.coverage_report.covered_supported_requirements).toBe(0);
  });
});

describe("adversarial: summary derivation", () => {
  it("counts overlapping employment once and clamps future dates", () => {
    const months = unionedCareerMonths({
      workExperiences: [
        { id: "a", start_date: "2020-01-01", end_date: "2021-12-31" },
        { id: "b", start_date: "2021-06-01", end_date: "" },
        { id: "c", start_date: "2030-01-01", end_date: "" },
      ],
      asOf: "2022-06-15",
    });
    expect(months.total_months).toBe(30);
    expect(months.intervals.map((entry) => entry.work_experience_id).sort()).toEqual(["a", "b"]);
  });

  it("skips malformed employment rows instead of crashing", () => {
    const months = unionedCareerMonths({
      workExperiences: ["not-an-object", { id: "bad", start_date: "whenever" }, null],
      asOf: "2022-06-15",
    });
    expect(months).toEqual({ total_months: 0, intervals: [] });
  });

  it("rejects a derivation that inflates tenure", () => {
    const profile = { ...PROFILE, headline: "Software Engineer" };
    const honest = composeSummary({
      profile,
      rankedFactIds: ["f1"],
      jobTitle: "Software Engineer",
      asOf: "2024-01-01",
    });
    expect(honest.strategy).toBe("derived_template");
    expect(honest.derivation?.slot_values["completed_years"]).toBe(2);
    const tampered = verifyDerivation({
      manifest: {
        ...honest.derivation,
        slot_values: { ...honest.derivation?.slot_values, completed_years: 10 },
      },
      profile,
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.errors).toContain(
      "Derivation completed_years is inconsistent with unioned months.",
    );
  });

  it("falls back to verbatim facts when title or tenure is missing", () => {
    const noTitle = composeSummary({
      profile: PROFILE,
      rankedFactIds: ["f1"],
      jobTitle: "Engineer",
      asOf: "2024-01-01",
    });
    expect(noTitle.strategy).toBe("verbatim");
    expect(noTitle.fallback_reason).toBe("NO_TITLE");
    const noEvidence = composeSummary({
      profile: PROFILE,
      rankedFactIds: ["f2"],
      jobTitle: "Engineer",
      asOf: "2024-01-01",
    });
    expect(noEvidence.strategy).toBe("none");
    expect(noEvidence.fallback_reason).toBe("NO_EVIDENCE");
  });

  it("rejects invented domain terms and proof points", () => {
    const profile = { ...PROFILE, headline: "Software Engineer" };
    const honest = composeSummary({
      profile,
      rankedFactIds: ["f1"],
      jobTitle: "Staff Engineer",
      asOf: "2024-01-01",
    });
    const invented = verifyDerivation({
      manifest: {
        ...honest.derivation,
        slot_values: { ...honest.derivation?.slot_values, domains_techs: "COBOL" },
      },
      profile,
    });
    expect(invented.valid).toBe(false);
    expect(invented.errors).toContain("Derivation domain term 'COBOL' is not verbatim fact evidence.");
  });
});

describe("adversarial: stale-input gate", () => {
  const gateProfile = {
    ...PROFILE,
    id: "cand-adv-001",
    verified_facts: PROFILE.verified_facts,
  };
  const snapshotHash = sha256HexUtf8(JSON.stringify(gateProfile));

  function gateInputs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const hash = sha256HexUtf8(canonicalText(JD));
    return {
      job: { description: JD },
      profile: gateProfile,
      analysis: {
        id: "an-1",
        jd_snapshot_id: "jd-snap-1",
        candidate_snapshot_id: "cand-snap-1",
        requirements: [
          {
            requirement_id: "req_ts",
            jd_quote: JD_TEXTS.quote,
            match_status: "matched",
            importance: "required",
            category: "skill",
            review_status: "confirmed",
            evidence_fact_ids: ["f1"],
            evidence_quotes: ["Led API migration to TypeScript"],
          },
        ],
      },
      jdSnapshotsByHash: { [hash]: { id: "jd-snap-1", cleaned_text: JD } },
      candidateSnapshot: {
        id: "cand-snap-1",
        candidate_id: "cand-adv-001",
        snapshot_hash: snapshotHash,
        profile_data: gateProfile,
      },
      currentProfileHash: snapshotHash,
      candidateId: "cand-adv-001",
      ...overrides,
    };
  }

  it("passes the honest end-to-end gate", () => {
    const result = checkGenerationInputs(
      gateInputs() as unknown as Parameters<typeof checkGenerationInputs>[0],
    );
    expect(result.status).toBe("ok");
  });

  it("throws when the job or profile is missing", () => {
    expect(() =>
      checkGenerationInputs(
        gateInputs({ job: null }) as unknown as Parameters<typeof checkGenerationInputs>[0],
      ),
    ).toThrow("Job or candidate profile not found.");
  });

  it("blocks changed JD text with the new hash for persistence", () => {
    const result = checkGenerationInputs(
      gateInputs({ job: { description: "Brand new description here." } }) as unknown as Parameters<
        typeof checkGenerationInputs
      >[0],
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blockers).toContain("STALE_ANALYSIS_JD");
      expect(result.new_jd_snapshot_hash).toBe(
        sha256HexUtf8(canonicalText("Brand new description here.")),
      );
    }
  });

  it("blocks profile drift and cross-candidate snapshots", () => {
    const drifted = checkGenerationInputs(
      gateInputs({ currentProfileHash: "0".repeat(64) }) as unknown as Parameters<
        typeof checkGenerationInputs
      >[0],
    );
    expect(drifted.status).toBe("blocked");
    if (drifted.status === "blocked") {
      expect(drifted.blockers).toContain("STALE_ANALYSIS_PROFILE");
    }
    const crossCandidate = checkGenerationInputs(
      gateInputs({ candidateId: "cand-other" }) as unknown as Parameters<
        typeof checkGenerationInputs
      >[0],
    );
    expect(crossCandidate.status).toBe("blocked");
    if (crossCandidate.status === "blocked") {
      expect(crossCandidate.blockers).toContain("CANDIDATE_SNAPSHOT_MISMATCH");
    }
  });

  it("blocks analyses citing facts unapproved in the bound snapshot", () => {
    const inputs = gateInputs();
    const analysis = inputs["analysis"] as Record<string, unknown>;
    const requirements = analysis["requirements"] as Array<Record<string, unknown>>;
    requirements[0] = { ...requirements[0], evidence_fact_ids: ["f2"] };
    const result = checkGenerationInputs(inputs as unknown as Parameters<typeof checkGenerationInputs>[0]);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.blockers).toContain("UNAPPROVED_OR_UNKNOWN_FACT");
    }
  });
});
