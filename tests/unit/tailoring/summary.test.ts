// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BASELINE_FORMULA_VERSION,
  composeSummary,
  FORMULA_VERSION,
  verifyDerivation,
} from "../../../src/tailoring/summary";
import { e2eProfile } from "./support";

const NARRATIVE = "Product leader with 15 years of experience.";

function profileWithSummary() {
  return { ...e2eProfile(), summary: NARRATIVE };
}

describe("baseline summary (summary/v2)", () => {
  it("preserves the narrative and appends evidence focus terms", () => {
    const result = composeSummary({
      profile: profileWithSummary(),
      rankedFactIds: ["f_api", "f_auth", "f_scale"],
      jobTitle: "Backend Engineer",
      asOf: "2024-05-01",
    });
    expect(result.strategy).toBe("derived_template");
    expect(result.fallback_reason).toBeNull();
    expect(result.fact_ids).toEqual(["f_api", "f_auth", "f_scale"]);
    expect(result.text).toBe(
      `${NARRATIVE} Specializing in TypeScript, SAML, and Redis. Targeting Backend Engineer roles.`,
    );
    expect(result.derivation?.formula_version).toBe(BASELINE_FORMULA_VERSION);
    expect(verifyDerivation({ manifest: result.derivation, profile: profileWithSummary() })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("omits the targeting line for non-allowlisted titles", () => {
    const result = composeSummary({
      profile: profileWithSummary(),
      rankedFactIds: ["f_api"],
      jobTitle: "Astronaut",
      asOf: "2024-05-01",
    });
    expect(result.text).toBe(`${NARRATIVE} Specializing in TypeScript.`);
    expect(verifyDerivation({ manifest: result.derivation, profile: profileWithSummary() }).valid).toBe(true);
  });

  it("falls back to the v1 path when ranked facts carry no usable terms", () => {
    const result = composeSummary({
      profile: profileWithSummary(),
      rankedFactIds: ["f_team"],
      jobTitle: "Backend Engineer",
      asOf: "2024-05-01",
    });
    expect(result.strategy).toBe("verbatim");
    expect(result.fallback_reason).toBe("NO_DOMAINS");
    expect(result.derivation).toBeNull();
  });

  it("reports no evidence when nothing ranked, even with a narrative", () => {
    const result = composeSummary({
      profile: profileWithSummary(),
      rankedFactIds: [],
      jobTitle: "Backend Engineer",
      asOf: "2024-05-01",
    });
    expect(result.strategy).toBe("none");
    expect(result.fallback_reason).toBe("NO_EVIDENCE");
  });

  it("keeps profiles without a summary on the v1 formula", () => {
    const result = composeSummary({
      profile: e2eProfile(),
      rankedFactIds: ["f_api", "f_auth", "f_scale"],
      jobTitle: "Backend Engineer",
      asOf: "2024-05-01",
    });
    expect(result.strategy).toBe("derived_template");
    expect(result.derivation?.formula_version).toBe(FORMULA_VERSION);
    expect(result.text.startsWith("Backend Engineer with")).toBe(true);
  });
});

describe("baseline derivation verification", () => {
  function manifest() {
    const result = composeSummary({
      profile: profileWithSummary(),
      rankedFactIds: ["f_api", "f_auth", "f_scale"],
      jobTitle: "Backend Engineer",
      asOf: "2024-05-01",
    });
    return JSON.parse(JSON.stringify(result.derivation)) as Record<string, unknown>;
  }

  it("rejects a narrative that differs from the profile summary", () => {
    const tampered = manifest();
    (tampered["slot_values"] as Record<string, unknown>)["narrative"] = "Embellished narrative.";
    const verdict = verifyDerivation({ manifest: tampered, profile: profileWithSummary() });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join(" ")).toContain("verbatim");
  });

  it("rejects unevidenced focus terms and unapproved facts", () => {
    const tampered = manifest();
    (tampered["slot_values"] as Record<string, unknown>)["domains_techs"] = "TypeScript, COBOL";
    const terms = verifyDerivation({ manifest: tampered, profile: profileWithSummary() });
    expect(terms.valid).toBe(false);
    expect(terms.errors.join(" ")).toContain("not verbatim fact evidence");

    const badFacts = manifest();
    badFacts["fact_ids"] = ["f_api", "f_nope"];
    const facts = verifyDerivation({ manifest: badFacts, profile: profileWithSummary() });
    expect(facts.valid).toBe(false);
    expect(facts.errors.join(" ")).toContain("unknown or unapproved");
  });

  it("rejects a final_text that is not byte-reconstructable", () => {
    const tampered = manifest();
    tampered["final_text"] = `${String(tampered["final_text"] ?? "")} Extra sentence.`;
    const verdict = verifyDerivation({ manifest: tampered, profile: profileWithSummary() });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors).toEqual(["Derivation final_text is not byte-for-byte reconstructable."]);
  });

  it("requires the profile to carry the baseline summary", () => {
    const verdict = verifyDerivation({ manifest: manifest(), profile: e2eProfile() });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join(" ")).toContain("requires a profile baseline summary");
  });
});
