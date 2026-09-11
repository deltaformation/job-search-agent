import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureCase {
  id: string;
  description: string;
  function: string;
  input: Record<string, unknown>;
  expected: unknown;
}

export interface FixtureSuite {
  version: string;
  suite: string;
  cases: FixtureCase[];
}

/** Load a committed R4-B parity suite (inputs only; expected compared by tests). */
export function loadSuite(stem: string): FixtureSuite {
  const path = join(process.cwd(), "tests", "fixtures", "parity", `${stem}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as FixtureSuite;
}
