import { describe, expect, it } from "vitest";
import { JD_WORD_CLOUD_KEYWORDS } from "@/app/mockup/fixtures/keywordAnalytics";
import { LIME_JOB_FIXTURE } from "@/app/mockup/fixtures/jobDescription";
import { MASTER_RESUME_FIXTURE } from "@/app/mockup/fixtures/masterResume";
import {
  TAILORED_RESUME_V1_FIXTURE,
  TAILORED_RESUME_V2_FIXTURE,
} from "@/app/mockup/fixtures/tailoredResume";

describe("Mockup Fixtures Integrity", () => {
  it("preserves authentic Lime Job details", () => {
    expect(LIME_JOB_FIXTURE.company).toBe("Lime");
    expect(LIME_JOB_FIXTURE.title).toBe("Lead Product Manager, Supply Chain Systems");
    expect(LIME_JOB_FIXTURE.location).toBe("Canada");
    expect(LIME_JOB_FIXTURE.arrangement).toBe("Remote");
    expect(LIME_JOB_FIXTURE.salaryMinCAD).toBe(126000);
    expect(LIME_JOB_FIXTURE.salaryMaxCAD).toBe(174000);
    expect(LIME_JOB_FIXTURE.residenceRequirement).toContain("reside in Canada");
    expect(LIME_JOB_FIXTURE.applyUrl).toContain("jobs.ashbyhq.com/lime");
  });

  it("preserves all 6 employment positions in Mouad Atfi master resume", () => {
    expect(MASTER_RESUME_FIXTURE.identity.fullName).toBe("Mouad Atfi");
    expect(MASTER_RESUME_FIXTURE.identity.location).toBe("Pickering, ON, Canada");
    expect(MASTER_RESUME_FIXTURE.employment).toHaveLength(6);

    const companies = MASTER_RESUME_FIXTURE.employment.map((e) => e.company);
    expect(companies).toEqual([
      "AOT Technologies",
      "IBM",
      "Odotrack",
      "MYR POS",
      "Allagma Technologies",
      "Freelance",
    ]);

    // Check Odotrack fleet details
    const odo = MASTER_RESUME_FIXTURE.employment.find((e) => e.company === "Odotrack");
    expect(odo?.bullets.some((b) => b.includes("route optimization"))).toBe(true);
    expect(odo?.bullets.some((b) => b.includes("proof-of-delivery"))).toBe(true);

    // Check Concordia education
    expect(MASTER_RESUME_FIXTURE.education[0]?.institution).toBe("Concordia University");
    expect(MASTER_RESUME_FIXTURE.education[0]?.degree).toBe("Bachelor's");
    expect(MASTER_RESUME_FIXTURE.education[0]?.fieldOfStudy).toBe("Information Science");
  });

  it("strictly enforces truthfulness rules in tailored drafts", () => {
    // V1 checks
    expect(TAILORED_RESUME_V1_FIXTURE.summary).toContain("logistics");
    expect(TAILORED_RESUME_V1_FIXTURE.summary).toContain("Odotrack");
    expect(TAILORED_RESUME_V1_FIXTURE.markdownText).not.toContain("NetSuite");
    expect(TAILORED_RESUME_V1_FIXTURE.markdownText).not.toContain("Anaplan");
    expect(TAILORED_RESUME_V1_FIXTURE.markdownText).not.toContain("Oracle TMS");

    // Check gaps are explicitly reported
    const gapTools = TAILORED_RESUME_V1_FIXTURE.remainingGaps.map((g) => g.tool);
    expect(gapTools.some((t) => t.includes("NetSuite"))).toBe(true);
    expect(gapTools.some((t) => t.includes("Anaplan"))).toBe(true);
    expect(gapTools.some((t) => t.includes("Oracle TMS"))).toBe(true);

    // V2 checks
    expect(TAILORED_RESUME_V2_FIXTURE.summary).toContain("logistics systems");
    expect(TAILORED_RESUME_V2_FIXTURE.summary).toContain("Odotrack");
    expect(TAILORED_RESUME_V2_FIXTURE.markdownText).not.toContain("NetSuite");
    expect(TAILORED_RESUME_V2_FIXTURE.markdownText).not.toContain("Anaplan");
    expect(TAILORED_RESUME_V2_FIXTURE.markdownText).not.toContain("Oracle TMS");
  });

  it("validates authentic keyword analytics fixture data for word cloud", () => {
    expect(JD_WORD_CLOUD_KEYWORDS).toHaveLength(28);

    // Top mention
    const topKeyword = JD_WORD_CLOUD_KEYWORDS[0];
    expect(topKeyword.term).toBe("Supply Chain Systems");
    expect(topKeyword.count).toBe(12);

    // Flagged gaps
    const gaps = JD_WORD_CLOUD_KEYWORDS.filter((k) => k.status === "gap");
    expect(gaps.length).toBe(4); // NetSuite ERP, NetSuite WMS, Anaplan, Oracle TMS
    expect(gaps.some((g) => g.term === "NetSuite ERP")).toBe(true);
    expect(gaps.some((g) => g.term === "NetSuite WMS")).toBe(true);

    // Categories
    const categories = new Set(JD_WORD_CLOUD_KEYWORDS.map((k) => k.category));
    expect(categories.has("logistics")).toBe(true);
    expect(categories.has("erp")).toBe(true);
    expect(categories.has("product")).toBe(true);
    expect(categories.has("tech")).toBe(true);
  });
});
