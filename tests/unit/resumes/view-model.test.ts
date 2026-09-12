// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildCanonicalBaselineDraft,
  buildContactParts,
  buildViewModel,
  formatDateRange,
  formatLinkedinDisplay,
  formatMonthYear,
  renderPlainText,
} from "../../../src/resumes/viewModel";

/** Edge cases for the canonical view model beyond the R4-B fixtures. */
describe("view-model formatting", () => {
  it("formats month-year with oracle edge semantics", () => {
    expect(formatMonthYear("2021-03-15")).toBe("Mar 2021");
    expect(formatMonthYear("2021-13-01")).toBe("2021-13-01");
    expect(formatMonthYear("2021-3")).toBe("2021-3");
    expect(formatMonthYear("March 2021")).toBe("March 2021");
    expect(formatMonthYear("")).toBe("");
    expect(formatMonthYear(null)).toBe("");
    expect(formatMonthYear(0)).toBe("");
  });

  it("renders Present only for current roles without an end date", () => {
    expect(formatDateRange({ start_date: "2020-01-01", is_current: true })).toBe("Jan 2020 - Present");
    expect(formatDateRange({ start_date: "2020-01-01", end_date: "2021-05-31" })).toBe(
      "Jan 2020 - May 2021",
    );
    expect(formatDateRange({ start_date: "2020-01-01" })).toBe("Jan 2020");
    expect(formatDateRange({})).toBe("");
  });

  it("strips scheme and trailing slashes from LinkedIn display text", () => {
    expect(formatLinkedinDisplay("https://linkedin.com/in/example/")).toBe("linkedin.com/in/example");
    expect(formatLinkedinDisplay("http://x.test/a//")).toBe("x.test/a");
    expect(formatLinkedinDisplay("  plain  ")).toBe("plain");
  });

  it("omits missing contact fields without stray separators", () => {
    expect(buildContactParts({})).toEqual([]);
    expect(buildContactParts({ email: "a@b.c", preferences: {} })).toEqual([
      { text: "a@b.c", href: "mailto:a@b.c" },
    ]);
    const parts = buildContactParts({
      location: "Toronto",
      preferences: { linkedin_url: "https://linkedin.com/in/example/" },
    });
    expect(parts).toEqual([
      { text: "Toronto" },
      { text: "linkedin.com/in/example", href: "https://linkedin.com/in/example/" },
    ]);
  });
});

describe("view-model structure", () => {
  const profile = {
    full_name: "Case Candidate",
    work_experience: [
      { id: "old", company: "Old Co", role: "Dev", start_date: "2018-01-01", end_date: "2019-01-01" },
      { id: "new", company: "New Co", role: "Senior", start_date: "2020-01-01", is_current: true },
    ],
    verified_facts: [],
    skills: [],
    education: [],
  };

  it("orders current roles first regardless of input order", () => {
    const model = buildViewModel({
      profile,
      draft: {
        claims: [
          { section: "experience", entity_id: "old", text: "Old bullet." },
          { section: "experience", entity_id: "new", text: "New bullet." },
        ],
      },
    });
    expect(model.professional_experience.map((job) => job.company)).toEqual(["New Co", "Old Co"]);
  });

  it("drops empty job headers and splits earlier career by role budget", () => {
    const model = buildViewModel({
      profile,
      draft: { claims: [{ section: "experience", entity_id: "old", text: "Old bullet." }] },
      maxDetailedRoles: 1,
    });
    expect(model.professional_experience).toEqual([]);
    expect(model.earlier_career.map((job) => job.company)).toEqual(["Old Co"]);
  });

  it("renders malformed profile/draft input as an empty model, never throwing", () => {
    const model = buildViewModel({ profile: null, draft: "not-an-object" });
    expect(model.header.full_name).toBe("Candidate");
    expect(model.professional_experience).toEqual([]);
    expect(model.summary_copy).toBe("");
    expect(renderPlainText(model)).toContain("CANDIDATE");
  });

  it("builds a stable chronological baseline draft", () => {
    const source = {
      headline: "Engineer",
      work_experience: profile.work_experience,
      verified_facts: [
        {
          fact_id: "f_old",
          work_experience_id: "old",
          text: "Old fact.",
          technologies: [],
          metrics: [],
          verification_status: "approved",
        },
        {
          fact_id: "f_new",
          work_experience_id: "new",
          text: "New fact.",
          technologies: [],
          metrics: [],
          verification_status: "approved",
        },
        {
          fact_id: "f_draft",
          work_experience_id: "new",
          text: "Draft fact.",
          verification_status: "proposed",
        },
      ],
      education: [],
    };
    const first = buildCanonicalBaselineDraft(source);
    const second = buildCanonicalBaselineDraft(source);
    expect(first).toEqual(second);
    expect(first.job_id).toBe("canonical-baseline");
    expect(first.claims.map((claim) => claim["claim_id"])).toEqual([
      "claim_001",
      "claim_002",
      "claim_003",
    ]);
    expect(first.claims[0]?.["text"]).toBe("Engineer");
    expect(first.claims[1]?.["fact_ids"]).toEqual(["f_old"]);
    expect(first.claims[2]?.["fact_ids"]).toEqual(["f_new"]);
  });
});
