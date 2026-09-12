import { describe, expect, it } from "vitest";
import { formatSalaryBadge, formatSalaryRange } from "../../../../components/board/salaryFormat";

describe("salary formatting", () => {
  it("compacts ranges for the card badge", () => {
    expect(
      formatSalaryBadge({
        salaryText: "$145,900 - $197,400 CAD per year",
        salaryCurrency: "CAD",
        salaryMinMinor: 14590000,
        salaryMaxMinor: 19740000,
      }),
    ).toBe("$146k – $197k CAD");
  });

  it("keeps full precision for the drawer line", () => {
    expect(
      formatSalaryRange({
        salaryText: "$145,900 - $197,400 CAD per year",
        salaryCurrency: "CAD",
        salaryMinMinor: 14590000,
        salaryMaxMinor: 19740000,
      }),
    ).toBe("$145,900 – $197,400 CAD");
  });

  it("handles single-ended and equal ranges", () => {
    const base = { salaryText: null, salaryCurrency: "USD" };
    expect(formatSalaryBadge({ ...base, salaryMinMinor: 10000000, salaryMaxMinor: null })).toBe(
      "$100k+ USD",
    );
    expect(formatSalaryBadge({ ...base, salaryMinMinor: null, salaryMaxMinor: 5000000 })).toBe(
      "up to $50k USD",
    );
    expect(formatSalaryBadge({ ...base, salaryMinMinor: 950000, salaryMaxMinor: 950000 })).toBe(
      "$9,500 USD",
    );
  });

  it("passes hourly and unknown text through verbatim", () => {
    expect(
      formatSalaryBadge({
        salaryText: "$75 - $95 / hr plus bonus",
        salaryCurrency: "USD",
        salaryMinMinor: null,
        salaryMaxMinor: null,
      }),
    ).toBe("$75 - $95 / hr plus bonus");
    expect(
      formatSalaryBadge({
        salaryText: null,
        salaryCurrency: null,
        salaryMinMinor: null,
        salaryMaxMinor: null,
      }),
    ).toBeNull();
  });

  it("truncates long verbatim text", () => {
    const badge = formatSalaryBadge({
      salaryText: `Pay: ${"x".repeat(100)}`,
      salaryCurrency: null,
      salaryMinMinor: null,
      salaryMaxMinor: null,
    });
    expect(badge?.length).toBe(48);
    expect(badge?.endsWith("…")).toBe(true);
  });
});
