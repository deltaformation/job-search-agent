// @vitest-environment node
import { describe, expect, it } from "vitest";
import { composeSummary, unionedCareerMonths, verifyDerivation } from "../../../src/tailoring/summary";
import { loadSuite } from "./_loader";

const CASES = loadSuite("summary").cases;

function runFixture(caseId: string, fn: string, input: Record<string, unknown>): unknown {
  switch (fn) {
    case "career_months":
      return unionedCareerMonths({
        workExperiences: input["workExperiences"],
        asOf: input["asOf"] as string,
      });
    case "compose_summary":
      return composeSummary({
        profile: input["profile"],
        rankedFactIds: input["rankedFactIds"],
        jobTitle: input["jobTitle"],
        asOf: input["asOf"] as string,
        maxDomainTerms: input["maxDomainTerms"] as number | undefined,
      });
    case "verify_derivation":
      return verifyDerivation({
        manifest: input["manifest"],
        profile: input["profile"],
      });
    default:
      throw new Error(`case ${caseId}: unexpected function '${fn}'`);
  }
}

describe("summary parity (R4-B fixtures)", () => {
  it.each(CASES.map((entry) => [entry.id, entry.function, entry.input, entry.expected] as const))(
    "%s",
    (id, fn, input, expected) => {
      expect(runFixture(id, fn, input)).toEqual(expected);
    },
  );
});
