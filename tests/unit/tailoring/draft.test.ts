// @vitest-environment node
import { describe, expect, it } from "vitest";
import { summarizeChanges } from "../../../src/tailoring/audit";
import { buildTailoredDraft } from "../../../src/tailoring/draft";
import { validateDraft } from "../../../src/tailoring/validator";
import { e2eProfile, e2eProposal } from "./support";

describe("deterministic draft builder", () => {
  const profile = e2eProfile();
  const proposal = e2eProposal("jd-1", "cs-1");
  const built = buildTailoredDraft({
    profile,
    requirements: proposal["requirements"],
    jobId: "job-1",
    jobTitle: "Backend Engineer",
    jobCompany: "Acme",
    asOf: "2024-05-01",
  });

  it("ranks supported facts and composes a derived summary", () => {
    expect(new Set(built.rankedFactIds)).toEqual(new Set(["f_api", "f_auth", "f_scale"]));
    expect(built.summaryStrategy).toBe("derived_template");
    expect(built.summaryFallbackReason).toBeNull();
  });

  it("orders summary first, then employment-grouped claims, renumbered", () => {
    const claims = built.draft.claims;
    expect(claims.map((claim) => claim["claim_id"])).toEqual([
      "claim_001",
      "claim_002",
      "claim_003",
      "claim_004",
      "claim_005",
      "claim_006",
    ]);
    expect(claims[0]?.["section"]).toBe("summary");
    expect(claims[0]?.["generation_strategy"]).toBe("derived_template");
    expect(claims.slice(1, 5).map((claim) => claim["section"])).toEqual([
      "experience",
      "experience",
      "experience",
      "experience",
    ]);
    // Profile employment order (emp-1 before emp-2), rank order within.
    expect(claims.slice(1, 5).map((claim) => claim["entity_id"])).toEqual([
      "emp-1",
      "emp-1",
      "emp-2",
      "emp-2",
    ]);
    // Ranked facts first within a role, then backfilled baseline facts.
    expect(claims.slice(1, 3).map((claim) => (claim["fact_ids"] as string[])[0])).toEqual([
      "f_scale",
      "f_team",
    ]);
    expect(claims[5]?.["section"]).toBe("education");
    expect(built.draft.job_id).toBe("job-1");
    expect(built.draft.target_role).toBe("Backend Engineer");
  });

  it("emits claims that pass the deterministic validator", () => {
    const report = validateDraft({ profile, draft: built.draft });
    expect(report.report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.report.validated_claims).toBe(6);
  });

  it("backfills every role and trims the total budget from the oldest roles", () => {
    const employments = ["e1", "e2", "e3", "e4", "e5"].map((id, index) => ({
      id,
      company: `Company ${id}`,
      role: "Engineer",
      start_date: `20${10 + index}-01-15`,
      end_date: `20${10 + index}-12-15`,
      is_current: false,
    }));
    const verifiedFacts = employments.flatMap((exp, index) =>
      ["a", "b", "c", "d"].map((suffix) => ({
        fact_id: `f${index + 1}${suffix}`,
        work_experience_id: exp.id,
        category: "experience",
        text: `Fact ${index + 1}${suffix} at ${exp.company}.`,
        technologies: ["Go"],
        metrics: ["1x"],
        verification_status: "approved",
      })),
    );
    const many = buildTailoredDraft({
      profile: { ...e2eProfile(), work_experience: employments, verified_facts: verifiedFacts },
      requirements: [],
      jobId: "job-trim",
      jobTitle: "Backend Engineer",
      jobCompany: "Acme",
      asOf: "2024-05-01",
    });
    const expClaims = many.draft.claims.filter((claim) => claim["section"] === "experience");
    // Per-role budget (3) over 5 roles yields 15; the global budget (14)
    // trims one backfilled bullet from the least-recent role.
    expect(expClaims).toHaveLength(14);
    const byRole = new Map<string, string[]>();
    for (const claim of expClaims) {
      const list = byRole.get(String(claim["entity_id"])) ?? [];
      list.push(String((claim["fact_ids"] as string[])[0]));
      byRole.set(String(claim["entity_id"]), list);
    }
    expect([...byRole.keys()].sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(byRole.get("e5")).toHaveLength(3);
    expect(byRole.get("e1")).toEqual(["f1a", "f1b"]);
    // Ranked facts are never trimmed.
    for (const fid of many.rankedFactIds) {
      expect(many.citedFactIds).toContain(fid);
    }
    const report = validateDraft({
      profile: { ...e2eProfile(), work_experience: employments, verified_facts: verifiedFacts },
      draft: many.draft,
    });
    expect(report.valid).toBe(true);
  });
});

describe("change summary", () => {
  it("diffs bullet sets deterministically", () => {
    const summary = summarizeChanges({
      baselineText: "NAME\n  - Alpha fact.\n  - Shared fact.\n",
      tailoredText: "NAME\n  - Shared fact.\n  - Beta fact.\n",
      baselineSummary: "Same summary.",
      tailoredSummary: "Same summary.",
    });
    expect(summary.addedBullets).toEqual(["Beta fact."]);
    expect(summary.removedBullets).toEqual(["Alpha fact."]);
    expect(summary.summaryChanged).toBe(false);
    expect(summary.baselineLines).toBe(4);
    expect(summary.tailoredLines).toBe(4);
  });

  it("detects summary changes", () => {
    const summary = summarizeChanges({
      baselineText: "a",
      tailoredText: "b",
      baselineSummary: "Old.",
      tailoredSummary: "New.",
    });
    expect(summary.summaryChanged).toBe(true);
    expect(summary.addedBullets).toEqual([]);
  });

  it("ignores non-bullet lines", () => {
    const summary = summarizeChanges({
      baselineText: "## Heading\n- dash bullet\n",
      tailoredText: "## Heading\n- dash bullet\n",
      baselineSummary: "",
      tailoredSummary: "",
    });
    expect(summary.addedBullets).toEqual([]);
    expect(summary.removedBullets).toEqual([]);
  });
});
