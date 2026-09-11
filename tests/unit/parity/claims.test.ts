// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  validateDraft,
  validateRequirements,
  validateSubmission,
} from "../../../src/tailoring/validator";
import { loadSuite } from "./_loader";

const CASES = loadSuite("claims").cases;

function runFixture(caseId: string, fn: string, input: Record<string, unknown>): unknown {
  switch (fn) {
    case "validate_requirements":
      return validateRequirements({
        profile: input["profile"],
        requirements: input["requirements"],
        jdText: input["jdText"] as string | undefined,
      });
    case "validate_draft":
      return validateDraft({
        profile: input["profile"],
        draft: input["draft"],
        variants: input["variants"],
      });
    case "validate_submission":
      return validateSubmission({
        profile: input["profile"],
        analysisData: input["analysisData"],
        jdSnapshot: input["jdSnapshot"],
        candidateSnapshot: input["candidateSnapshot"],
      });
    default:
      throw new Error(`case ${caseId}: unexpected function '${fn}'`);
  }
}

describe("claims parity (R4-B fixtures)", () => {
  it.each(CASES.map((entry) => [entry.id, entry.function, entry.input, entry.expected] as const))(
    "%s",
    (id, fn, input, expected) => {
      expect(runFixture(id, fn, input)).toEqual(expected);
    },
  );
});
