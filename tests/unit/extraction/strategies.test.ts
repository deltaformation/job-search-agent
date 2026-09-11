// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runExtraction } from "../../../src/extraction/extract";
import type { ExtractionInput } from "../../../src/extraction/types";

const FIXTURES = "tests/unit/extraction/fixtures";

function readFixture(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function inputFor(
  html: string,
  overrides: Partial<ExtractionInput> = {},
): ExtractionInput {
  return {
    html,
    text: "",
    jsonLdBlocks: [],
    finalUrl: "https://example.com/posting",
    canonicalUrl: "https://example.com/posting",
    canonicalKey: "url:https://example.com/posting",
    atsType: null,
    ...overrides,
  };
}

function jsonLdFrom(html: string): string[] {
  const blocks: string[] = [];
  const pattern =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe("json-ld strategy", () => {
  it("extracts a full posting without annualizing hourly pay", () => {
    const html = readFixture("jobposting-jsonld.html");
    const outcome = runExtraction(inputFor(html, { jsonLdBlocks: jsonLdFrom(html) }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.adapterId).toBe("jsonld");
    expect(outcome.fields).toMatchObject({
      title: "Staff Engineer",
      company: "Gamma LLC",
      location: "US",
      arrangement: "REMOTE",
      salaryText: "USD 50 per HOUR",
      salaryCurrency: "USD",
      salaryMinMinor: null,
      salaryMaxMinor: null,
      postedAt: "2026-09-01T09:00:00.000Z",
      applyUrl: "https://example.com/posting",
    });
    expect(outcome.fields.descriptionText).toBe(
      "Lead our infrastructure group. Remote-first.",
    );
    expect(outcome.provenance.company).toBe("jsonld:hiringOrganization");
    expect(outcome.missingFields).toEqual([]);
    expect(outcome.confidence).toBe(0.95);
  });

  it("skips malformed blocks and falls through to generic", () => {
    const html = readFixture("malformed-jsonld.html");
    const outcome = runExtraction(inputFor(html, {
      finalUrl: "https://example.com/support",
      jsonLdBlocks: jsonLdFrom(html),
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.adapterId).toBe("generic");
    expect(outcome.fields.title).toBe("Support Specialist");
  });
});

describe("generic strategy", () => {
  it("extracts from meta and semantic markup", () => {
    const html = readFixture("generic-meta.html");
    const outcome = runExtraction(
      inputFor(html, {
        finalUrl: "https://example.com/careers/data-analyst",
        text: [
          "Data Analyst",
          "Hybrid - Toronto",
          "Delta Co seeks a Data Analyst for our hybrid Toronto team.",
          "Compensation: $95,000 per year plus bonus.",
          "Apply for this position",
        ].join("\n"),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.adapterId).toBe("generic");
    expect(outcome.fields).toMatchObject({
      title: "Data Analyst",
      company: null,
      location: null,
      arrangement: "UNKNOWN",
      salaryCurrency: "USD",
      salaryMinMinor: 9_500_000,
      salaryMaxMinor: 9_500_000,
      postedAt: null,
      applyUrl: "https://example.com/careers/data-analyst/apply",
    });
    expect(outcome.fields.descriptionText).toContain("hybrid Toronto team");
    expect(outcome.missingFields).toEqual(
      expect.arrayContaining(["company", "location", "postedAt"]),
    );
    expect(outcome.confidence).toBe(0.7);
  });

  it("reports thin pages as usable with visible gaps", () => {
    const html = readFixture("partial-thin.html");
    const outcome = runExtraction(inputFor(html));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.fields.title).toBe("Mystery Role");
    expect(outcome.missingFields).toEqual(
      expect.arrayContaining([
        "company",
        "location",
        "salary",
        "description",
        "postedAt",
      ]),
    );
    expect(outcome.confidence).toBe(0.6);
  });
});

describe("extraction completeness", () => {
  it("fails empty captures without inventing fields", () => {
    const outcome = runExtraction(inputFor("", { text: "" }));
    expect(outcome).toMatchObject({
      ok: false,
      reason: "EXTRACTION_INCOMPLETE",
    });
    if (outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.missingFields).toEqual([
      "title",
      "company",
      "location",
      "salary",
      "description",
      "postedAt",
    ]);
  });

  it("is deterministic across runs", () => {
    const html = readFixture("greenhouse-posting.html");
    const input = inputFor(html, {
      finalUrl: "https://boards.greenhouse.io/acme/jobs/123",
      atsType: "Greenhouse",
    });
    const first = runExtraction(input);
    const second = runExtraction(inputFor(html, {
      finalUrl: "https://boards.greenhouse.io/acme/jobs/123",
      atsType: "Greenhouse",
    }));
    expect(second).toEqual(first);
  });
});
