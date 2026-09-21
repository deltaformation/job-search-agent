import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractAtsKeywords } from "../../../src/domain/atsKeywords";

const JD = `We are hiring a Staff Engineer to lead our platform team.
You have deep experience with Kubernetes and PostgreSQL in production.
You will build distributed systems on AWS with Terraform and Docker.
Kubernetes experience required. PostgreSQL required. AWS preferred.
You will mentor engineers and drive system design reviews.`;

describe("extractAtsKeywords", () => {
  it("ranks by frequency, then first JD occurrence (E1 source order)", () => {
    const keywords = extractAtsKeywords(JD, 10);
    expect(keywords.slice(0, 3)).toMatchObject([
      { keyword: "Kubernetes", count: 2, curated: true },
      { keyword: "PostgreSQL", count: 2, curated: true },
      { keyword: "AWS", count: 2, curated: true },
    ]);
    // Single-count hits follow in JD introduction order.
    expect(keywords.slice(3).map((entry) => entry.keyword)).toEqual([
      "Distributed Systems",
      "Terraform",
      "Docker",
      "System Design",
    ]);
  });

  it("matches whole terms only", () => {
    // "Java" must not match inside "JavaScript"; "Go" must not match "Golang".
    const keywords = extractAtsKeywords("JavaScript and Golang experience.", 10);
    const names = keywords.map((entry) => entry.keyword);
    expect(names).toContain("JavaScript");
    expect(names).not.toContain("Java");
    expect(names).not.toContain("Go");
  });

  it("matches symbol-bearing terms at punctuation boundaries", () => {
    const keywords = extractAtsKeywords("C++ and C# on .NET; CI/CD pipelines.", 10);
    expect(keywords.map((entry) => entry.keyword)).toEqual(["C++", "C#", ".NET", "CI/CD"]);
  });

  it("backfills with frequent substantive tokens and skips boilerplate", () => {
    const keywords = extractAtsKeywords(
      "We need a billing specialist. The billing lead owns billing reconciliation. Frankly, billing matters.",
      10,
    );
    expect(keywords).toMatchObject([{ keyword: "billing", count: 4, curated: false }]);
  });

  it("never duplicates a curated hit with a backfill token", () => {
    const keywords = extractAtsKeywords("PostgreSQL postgres tuning. PostgreSQL again.", 10);
    expect(keywords).toMatchObject([{ keyword: "PostgreSQL", count: 2, curated: true }]);
  });

  it("is deterministic and bounded", () => {
    const first = extractAtsKeywords(JD, 5);
    const second = extractAtsKeywords(JD, 5);
    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    expect(extractAtsKeywords("", 10)).toEqual([]);
    expect(extractAtsKeywords("   ", 10)).toEqual([]);
    expect(extractAtsKeywords(JD, 0)).toEqual([]);
  });
});

describe("extractAtsKeywords cross-cutting manifest (E1–E3)", () => {
  const root = join(process.cwd(), "tests", "fixtures", "v1.2", "jd");
  const manifest = JSON.parse(readFileSync(join(root, "keywords.json"), "utf8")) as {
    cases: Record<
      string,
      {
        file: string;
        minSuggestions: number;
        maxSuggestions: number;
        mustInclude: string[];
        mustExclude: string[];
      }
    >;
  };

  for (const [name, contract] of Object.entries(manifest.cases)) {
    it(`${name}: includes required phrases, excludes false positives, respects suggestion bounds`, () => {
      const jdText = readFileSync(join(root, contract.file), "utf8");
      const keywords = extractAtsKeywords(jdText, 10);
      const names = keywords.map((entry) => entry.keyword.toLowerCase());
      for (const required of contract.mustInclude) {
        expect(names).toContain(required.toLowerCase());
      }
      for (const excluded of contract.mustExclude) {
        expect(names).not.toContain(excluded.toLowerCase());
      }
      expect(keywords.length).toBeGreaterThanOrEqual(contract.minSuggestions);
      expect(keywords.length).toBeLessThanOrEqual(contract.maxSuggestions);
    });
  }

  it("excludes Go matched only as a go-to-market prefix (F5)", () => {
    const keywords = extractAtsKeywords("Lead go-to-market launches and pricing.", 10);
    expect(keywords.map((entry) => entry.keyword)).toContain("go-to-market");
    expect(keywords.map((entry) => entry.keyword)).not.toContain("Go");
  });

  it("keeps genuine standalone Go (engineering positive control)", () => {
    const keywords = extractAtsKeywords("Backend Engineer. Build distributed systems in Go and Rust.", 10);
    expect(keywords.map((entry) => entry.keyword)).toContain("Go");
  });

  it("prefers the longest phrase on nested spans (REST APIs over REST)", () => {
    const keywords = extractAtsKeywords("Design REST APIs for partners.", 10);
    expect(keywords.map((entry) => entry.keyword)).toContain("REST APIs");
    expect(keywords.map((entry) => entry.keyword)).not.toContain("REST");
  });

  it("attaches a deterministic source excerpt and offset to every suggestion", () => {
    const jdText = "Own product strategy and roadmap prioritization across the org.";
    const first = extractAtsKeywords(jdText, 10);
    const second = extractAtsKeywords(jdText, 10);
    expect(first).toEqual(second);
    for (const entry of first) {
      expect(entry.offset).toBeGreaterThanOrEqual(0);
      expect(jdText.slice(entry.offset, entry.offset + entry.keyword.length).toLowerCase()).toBe(
        entry.keyword.toLowerCase(),
      );
      expect(entry.excerpt.toLowerCase()).toContain(entry.keyword.toLowerCase());
    }
  });
});
