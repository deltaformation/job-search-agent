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
    ]);
    expect(claims[0]?.["section"]).toBe("summary");
    expect(claims[0]?.["generation_strategy"]).toBe("derived_template");
    expect(claims.slice(1, 4).map((claim) => claim["section"])).toEqual([
      "experience",
      "experience",
      "experience",
    ]);
    // Profile employment order (emp-1 before emp-2), rank order within.
    expect(claims.slice(1, 4).map((claim) => claim["entity_id"])).toEqual(["emp-1", "emp-2", "emp-2"]);
    expect(claims[4]?.["section"]).toBe("education");
    expect(built.draft.job_id).toBe("job-1");
    expect(built.draft.target_role).toBe("Backend Engineer");
  });

  it("emits claims that pass the deterministic validator", () => {
    const report = validateDraft({ profile, draft: built.draft });
    expect(report.report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.report.validated_claims).toBe(5);
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
