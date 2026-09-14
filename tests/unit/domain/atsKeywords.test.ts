import { describe, expect, it } from "vitest";
import { extractAtsKeywords } from "../../../src/domain/atsKeywords";

const JD = `We are hiring a Staff Engineer to lead our platform team.
You have deep experience with Kubernetes and PostgreSQL in production.
You will build distributed systems on AWS with Terraform and Docker.
Kubernetes experience required. PostgreSQL required. AWS preferred.
You will mentor engineers and drive system design reviews.`;

describe("extractAtsKeywords", () => {
  it("ranks lexicon hits by frequency with alphabetical tiebreaks", () => {
    const keywords = extractAtsKeywords(JD, 10);
    expect(keywords.slice(0, 3)).toEqual([
      { keyword: "AWS", count: 2, curated: true },
      { keyword: "Kubernetes", count: 2, curated: true },
      { keyword: "PostgreSQL", count: 2, curated: true },
    ]);
    // Single-count hits follow, alphabetical.
    expect(keywords.slice(3).map((entry) => entry.keyword)).toEqual([
      "Distributed Systems",
      "Docker",
      "System Design",
      "Terraform",
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
    expect(keywords.map((entry) => entry.keyword)).toEqual([".NET", "C#", "C++", "CI/CD"]);
  });

  it("backfills with frequent substantive tokens and skips boilerplate", () => {
    const keywords = extractAtsKeywords(
      "We need a billing specialist. The billing lead owns billing reconciliation. Frankly, billing matters.",
      10,
    );
    expect(keywords).toEqual([{ keyword: "billing", count: 4, curated: false }]);
  });

  it("never duplicates a curated hit with a backfill token", () => {
    const keywords = extractAtsKeywords("PostgreSQL postgres tuning. PostgreSQL again.", 10);
    expect(keywords).toEqual([{ keyword: "PostgreSQL", count: 2, curated: true }]);
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
