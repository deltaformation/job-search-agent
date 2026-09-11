// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * R4-B parity fixture envelope: every committed suite file parses and carries
 * the contract the TypeScript port (R4-C) consumes — versioned envelope,
 * unique case ids, named runner functions, and recorded expected outputs.
 * Oracle semantics are pinned by the Python harness, not here.
 */

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "parity");

const KNOWN_FUNCTIONS = new Set([
  "validate_requirements",
  "validate_draft",
  "validate_submission",
  "rank_facts",
  "qualified_skills",
  "keyword_plan",
  "career_months",
  "compose_summary",
  "verify_derivation",
  "build_view_model",
  "render_resume_text",
  "baseline_draft",
  "generate_documents",
]);

interface FixtureCase {
  id: unknown;
  description?: unknown;
  function: unknown;
  input: unknown;
  expected?: unknown;
}

interface FixtureSuite {
  version: unknown;
  suite: unknown;
  cases: unknown;
}

function suiteFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json") && name !== "parity-fixtures.schema.json")
    .sort();
}

describe("parity fixture envelope", () => {
  it("ships the documented six suites", () => {
    expect(suiteFiles()).toEqual([
      "claims.json",
      "keywords.json",
      "ranking.json",
      "stale-inputs.json",
      "summary.json",
      "view-model.json",
    ]);
  });

  it.each(suiteFiles())("%s carries versioned cases with recorded outputs", (file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const suite = JSON.parse(raw) as FixtureSuite;
    expect(suite.version).toBe("parity-fixtures/v1");
    expect(suite.suite).toBe(file.replace(/\.json$/, ""));
    expect(Array.isArray(suite.cases)).toBe(true);
    const cases = suite.cases as FixtureCase[];
    expect(cases.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const entry of cases) {
      expect(typeof entry.id).toBe("string");
      expect(ids.has(entry.id as string)).toBe(false);
      ids.add(entry.id as string);
      expect(KNOWN_FUNCTIONS.has(entry.function as string)).toBe(true);
      expect(typeof entry.input).toBe("object");
      expect(entry.input).not.toBeNull();
      expect("expected" in entry).toBe(true);
    }
  });
});
