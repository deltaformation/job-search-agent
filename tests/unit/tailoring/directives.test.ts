// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluateDirectiveOutcomes, extractKpiTokens } from "../../../src/tailoring/directives";

/**
 * Human-directive guard (WO-1.2-D, D6). KPI-shaped tokens in a
 * directive line must appear as standalone tokens in an approved
 * fact; substring accidents ("200" inside "2,000") never count as
 * backing. Pure — no database.
 */

describe("extractKpiTokens", () => {
  it("finds percentages, currency, scaled magnitudes, plus-counts, and bare counts", () => {
    expect(extractKpiTokens("Grew revenue 20% year over year.")).toEqual(["20%"]);
    expect(extractKpiTokens("Added $1.2M in ARR.")).toEqual(["1.2m"]);
    expect(extractKpiTokens("Led teams of 200+ engineers.")).toEqual(["200"]);
    expect(extractKpiTokens("Managed 200 engineers.")).toEqual(["200"]);
    expect(extractKpiTokens("Shipped 3x faster.")).toEqual(["3x"]);
  });

  it("finds nothing in prose without measurable claims", () => {
    expect(extractKpiTokens("Emphasize platform strategy.")).toEqual([]);
    expect(extractKpiTokens("Started in 2020 and still there.")).toEqual([]);
  });

  it("never emits fragments of a longer number", () => {
    expect(extractKpiTokens("Used by 2,000+ teams.")).toEqual(["2000"]);
    expect(extractKpiTokens("Added $1.2M in ARR.")).toEqual(["1.2m"]);
  });
});

describe("evaluateDirectiveOutcomes", () => {
  const FACTS = [
    "Own product strategy for a B2B SaaS analytics suite used by 2,000+ teams.",
    "Added $1.2M in ARR with usage-based pricing.",
    "Grew trial conversion 20 percent in two quarters.",
  ];

  it("returns no outcomes without directives", () => {
    expect(evaluateDirectiveOutcomes(undefined, FACTS)).toEqual([]);
  });

  it("supports lines whose tokens appear as standalone fact tokens", () => {
    const [only = undefined] = evaluateDirectiveOutcomes("Highlight the 2,000+ teams.", FACTS);
    expect(only).toMatchObject({ index: 0, status: "supported", unbackedTokens: [] });
    const [currency = undefined] = evaluateDirectiveOutcomes("Mention the $1.2M ARR win.", FACTS);
    expect(currency?.status).toBe("supported");
    const [percent = undefined] = evaluateDirectiveOutcomes("Cite 20 percent growth.", FACTS);
    expect(percent?.status).toBe("supported");
    const [plain = undefined] = evaluateDirectiveOutcomes("Emphasize platform strategy.", FACTS);
    expect(plain).toMatchObject({ status: "supported", kpiTokens: [] });
  });

  it("marks shorter numbers inside longer fact numbers unsupported", () => {
    // Checkpoint regression: "200" must not back itself from "2,000".
    const [only = undefined] = evaluateDirectiveOutcomes("Led teams of 200+ engineers.", FACTS);
    expect(only).toMatchObject({
      index: 0,
      status: "unsupported",
      kpiTokens: ["200"],
      unbackedTokens: ["200"],
    });
    expect(only?.explanation).toContain('"200"');
    // Bare two-digit counts are not KPI-shaped, so they stay supported.
    const [plain = undefined] = evaluateDirectiveOutcomes("Drove 20 wins.", FACTS);
    expect(plain).toMatchObject({ status: "supported", kpiTokens: [] });
  });

  it("evaluates each line independently and skips blanks", () => {
    const outcomes = evaluateDirectiveOutcomes(
      "Emphasize platform strategy.\n\nLed teams of 200+ engineers.\nHighlight the 2,000+ teams.",
      FACTS,
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "supported",
      "unsupported",
      "supported",
    ]);
    expect(outcomes.map((outcome) => outcome.index)).toEqual([0, 1, 2]);
  });
});
