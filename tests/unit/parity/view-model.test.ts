// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ResumeViewModel,
  buildCanonicalBaselineDraft,
  buildViewModel,
  renderPlainText,
} from "../../../src/resumes/viewModel";
import { loadSuite } from "./_loader";

const CASES = loadSuite("view-model").cases;

function runFixture(id: string, fn: string, input: Record<string, unknown>): unknown {
  switch (fn) {
    case "build_view_model":
      return buildViewModel({
        profile: input["profile"],
        draft: input["draft"],
        maxDetailedRoles:
          typeof input["maxDetailedRoles"] === "number"
            ? (input["maxDetailedRoles"] as number)
            : undefined,
      });
    case "render_resume_text":
      return {
        text: renderPlainText(
          buildViewModel({
            profile: input["profile"],
            draft: input["draft"],
            maxDetailedRoles:
              typeof input["maxDetailedRoles"] === "number"
                ? (input["maxDetailedRoles"] as number)
                : undefined,
          }),
        ),
      };
    case "baseline_draft":
      return buildCanonicalBaselineDraft(input["profile"]);
    default:
      throw new Error(`unknown view-model function for ${id}: ${fn}`);
  }
}

describe("view-model parity (R4-B fixtures)", () => {
  it.each(CASES.map((entry) => [entry.id, entry.function, entry.input, entry.expected] as const))(
    "%s",
    (id, fn, input, expected) => {
      const actual = runFixture(id, fn, input);
      if (fn === "build_view_model") {
        // Builder output must satisfy the renderer input contract.
        expect(() => ResumeViewModel.parse(actual)).not.toThrow();
      }
      expect(actual).toEqual(expected);
    },
  );
});
