// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSiteAdapter } from "../../../src/extraction/adapters/index";
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

describe("site adapter registry", () => {
  it("resolves Greenhouse and Lever, nothing else", () => {
    expect(getSiteAdapter("Greenhouse")?.id).toBe("greenhouse");
    expect(getSiteAdapter("Lever")?.id).toBe("lever");
    expect(getSiteAdapter("Ashby")).toBeNull();
    expect(getSiteAdapter(null)).toBeNull();
  });
});

describe("greenhouse adapter", () => {
  it("extracts a posting and beats the embedded json-ld", () => {
    const html = readFixture("greenhouse-posting.html");
    const outcome = runExtraction(
      inputFor(html, {
        finalUrl: "https://boards.greenhouse.io/acme/jobs/123",
        canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123",
        canonicalKey: "url:https://boards.greenhouse.io/acme/jobs/123",
        atsType: "Greenhouse",
        // The JSON-LD block is also captured; adapter precedence wins.
        jsonLdBlocks: [
          '{"@type":"JobPosting","title":"Wrong Title From JSON-LD"}',
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.adapterId).toBe("greenhouse");
    expect(outcome.fields).toMatchObject({
      title: "Senior Product Manager",
      company: null,
      location: "San Francisco, CA",
      arrangement: "ONSITE",
      salaryCurrency: "USD",
      salaryMinMinor: 15_000_000,
      salaryMaxMinor: 18_000_000,
      postedAt: null,
      applyUrl: "https://boards.greenhouse.io/acme/jobs/123/apply",
    });
    expect(outcome.fields.salaryText).toContain("$150,000 - $180,000");
    expect(outcome.fields.descriptionText).toContain("own the roadmap");
    expect(outcome.provenance.title).toBe("greenhouse:h1.app-title");
    expect(outcome.missingFields).toEqual(
      expect.arrayContaining(["company", "postedAt"]),
    );
    expect(outcome.missingFields).not.toContain("title");
    expect(outcome.confidence).toBe(0.95);
    expect(outcome.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("lever adapter", () => {
  it("extracts a posting with cad salary", () => {
    const html = readFixture("lever-posting.html");
    const outcome = runExtraction(
      inputFor(html, {
        finalUrl: "https://lever.co/beta/abc123",
        canonicalUrl: "https://lever.co/beta/abc123",
        canonicalKey: "url:https://lever.co/beta/abc123",
        atsType: "Lever",
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("unreachable");
    }
    expect(outcome.adapterId).toBe("lever");
    expect(outcome.fields).toMatchObject({
      title: "Technical Product Manager",
      company: null,
      location: "Toronto, ON",
      arrangement: "ONSITE",
      salaryCurrency: "CAD",
      salaryMinMinor: 14_000_000,
      salaryMaxMinor: 16_000_000,
      postedAt: null,
      applyUrl: "https://lever.co/beta/abc123/apply",
    });
    expect(outcome.confidence).toBe(0.95);
  });
});
