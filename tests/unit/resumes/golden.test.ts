// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../../src/resumes/markdown";
import { renderHtml } from "../../../src/resumes/template";
import {
  buildViewModel,
  renderPlainText,
  type ResumeViewModel,
} from "../../../src/resumes/viewModel";

/**
 * Byte-golden visual fixtures for the standard template. Regenerate with
 * UPDATE_GOLDENS=1, inspect the diff for review, then commit: any later
 * template drift fails loudly.
 */
const GOLDEN_DIR = join(process.cwd(), "tests", "fixtures", "resumes");

function fixtureModel(): ResumeViewModel {
  const suite = JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "parity", "view-model.json"), "utf8"),
  ) as { cases: Array<{ id: string; input: { profile: unknown; draft: unknown } }> };
  const ordering = suite.cases.find((entry) => entry.id === "vm-ordering");
  if (!ordering) {
    throw new Error("vm-ordering fixture case missing");
  }
  return buildViewModel({ profile: ordering.input.profile, draft: ordering.input.draft });
}

const GOLDENS: Array<{ file: string; render: (model: ResumeViewModel) => string }> = [
  { file: "standard.html", render: renderHtml },
  { file: "standard.md", render: renderMarkdown },
  { file: "standard.txt", render: renderPlainText },
];

describe("resume golden fixtures", () => {
  it.each(GOLDENS.map((entry) => [entry.file] as const))("%s matches the pinned bytes", (file) => {
    const golden = GOLDENS.find((entry) => entry.file === file);
    if (!golden) {
      throw new Error(`unknown golden ${file}`);
    }
    const actual = golden.render(fixtureModel());
    if (process.env["UPDATE_GOLDENS"] === "1") {
      writeFileSync(join(GOLDEN_DIR, file), actual, "utf8");
      return;
    }
    expect(actual).toBe(readFileSync(join(GOLDEN_DIR, file), "utf8"));
  });
});
