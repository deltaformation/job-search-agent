// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evidenceQualifiedSkills, planKeywords } from "../../../src/tailoring/keywords";
import { rankFacts } from "../../../src/tailoring/ranking";
import { loadSuite } from "./_loader";

describe("ranking parity (R4-B fixtures)", () => {
  const cases = loadSuite("ranking").cases;
  it.each(cases.map((entry) => [entry.id, entry.input, entry.expected] as const))(
    "%s",
    (id, input, expected) => {
      expect(id).toBeTruthy();
      expect(
        rankFacts({
          profile: input["profile"],
          requirements: input["requirements"],
          config: input["config"] as
            | { maxPerRole?: number; maxPriorRole?: number; maxTotal?: number }
            | undefined,
        }),
      ).toEqual(expected);
    },
  );
});

describe("keywords parity (R4-B fixtures)", () => {
  const cases = loadSuite("keywords").cases;
  it.each(cases.map((entry) => [entry.id, entry.function, entry.input, entry.expected] as const))(
    "%s",
    (id, fn, input, expected) => {
      if (fn === "qualified_skills") {
        expect(
          evidenceQualifiedSkills({ profile: input["profile"], citedFactIds: input["citedFactIds"] }),
        ).toEqual(expected);
      } else if (fn === "keyword_plan") {
        expect(
          planKeywords({
            profile: input["profile"],
            requirements: input["requirements"],
            rankedFactIds: input["rankedFactIds"],
            skillTerms: input["skillTerms"],
          }),
        ).toEqual(expected);
      } else {
        throw new Error(`case ${id}: unexpected function '${fn}'`);
      }
    },
  );
});
