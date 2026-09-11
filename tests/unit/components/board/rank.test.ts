import { describe, expect, it } from "vitest";
import { computeDropRank } from "../../../../components/board/rank";

describe("computeDropRank", () => {
  it("starts empty columns at zero", () => {
    expect(computeDropRank([], 0)).toBe(0);
  });

  it("extends whole steps at the ends", () => {
    expect(computeDropRank([1, 2, 3], 0)).toBe(0);
    expect(computeDropRank([1, 2, 3], 3)).toBe(4);
    expect(computeDropRank([1, 2, 3], 99)).toBe(4);
    expect(computeDropRank([1, 2, 3], -2)).toBe(0);
  });

  it("splits gaps in the middle", () => {
    expect(computeDropRank([1, 2, 3], 1)).toBe(1.5);
    expect(computeDropRank([0, 10], 1)).toBe(5);
  });

  it("degrades sanely on tied neighbors", () => {
    expect(computeDropRank([2, 2, 2], 1)).toBe(3);
  });
});
