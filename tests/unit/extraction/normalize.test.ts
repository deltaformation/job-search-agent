// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyArrangement,
  cleanText,
  findSalaryLine,
  generateContentHash,
  parsePostedDate,
  parseSalaryLine,
  resolveApplyUrl,
} from "../../../src/extraction/normalize";

const FIXTURES = "tests/unit/extraction/fixtures";
const inputs = JSON.parse(
  readFileSync(`${FIXTURES}/oracle-inputs.json`, "utf8"),
) as {
  contentHashCases: Array<{ company: string; title: string; description: string }>;
  arrangementCases: Array<{ location: string; isRemote: boolean }>;
  titleCases: string[];
};
const goldens = JSON.parse(
  readFileSync(`${FIXTURES}/oracle-goldens.json`, "utf8"),
) as {
  contentHash: string[];
  arrangement: Array<{ legacy: [string, string] }>;
  title: string[];
};

describe("oracle parity: content hash", () => {
  it("matches the legacy digest byte-for-byte", () => {
    inputs.contentHashCases.forEach((c, index) => {
      expect(generateContentHash(c.company, c.title, c.description)).toBe(
        goldens.contentHash[index],
      );
    });
  });
});

describe("oracle parity: arrangement", () => {
  it("matches the legacy remote-type mapping exactly", () => {
    inputs.arrangementCases.forEach((c, index) => {
      expect(classifyArrangement(cleanText(c.location), c.isRemote)).toBe(
        goldens.arrangement[index].legacy[1].toUpperCase(),
      );
    });
  });

  it("classifies edges deterministically", () => {
    expect(classifyArrangement(null, true)).toBe("REMOTE");
    expect(classifyArrangement(null, false)).toBe("UNKNOWN");
    expect(classifyArrangement("hybrid-remote mix", false)).toBe("REMOTE");
    expect(classifyArrangement("  ", false)).toBe("UNKNOWN");
  });
});

describe("deliberate fixes vs the oracle", () => {
  it("trims titles without inventing seniority or placeholders", () => {
    // Trim-only cases match the oracle.
    expect(cleanText(inputs.titleCases[0])).toBe(goldens.title[0]);
    expect(cleanText(inputs.titleCases[2])).toBe(goldens.title[2]);
    expect(cleanText(inputs.titleCases[4])).toBe(goldens.title[4]);
    // Invention cases differ by design: no "sr"-substring seniority
    // inference, no "Unknown Role" placeholder.
    expect(cleanText(inputs.titleCases[1])).toBe("sr product manager");
    expect(cleanText(inputs.titleCases[3])).toBeNull();
  });

  it("trims locations without geographic expansion", () => {
    expect(cleanText("Hybrid - New York")).toBe("Hybrid - New York");
    expect(cleanText("Toronto, ON")).toBe("Toronto, ON");
    expect(cleanText("")).toBeNull();
  });
});

describe("salary parsing", () => {
  it("parses annual ranges and singles into minors", () => {
    expect(parseSalaryLine("Pay Range: $150,000 - $180,000 per year.")).toMatchObject({
      currency: "USD",
      minMinor: 15_000_000,
      maxMinor: 18_000_000,
    });
    expect(parseSalaryLine("Salary: $140k-$160k CAD.")).toMatchObject({
      currency: "CAD",
      minMinor: 14_000_000,
      maxMinor: 16_000_000,
    });
    expect(parseSalaryLine("Compensation: $95,000 per year plus bonus.")).toMatchObject({
      currency: "USD",
      minMinor: 9_500_000,
      maxMinor: 9_500_000,
    });
    expect(parseSalaryLine("£50,000 per annum")).toMatchObject({
      currency: "GBP",
      minMinor: 5_000_000,
      maxMinor: 5_000_000,
    });
  });

  it("swaps reversed ranges to preserve the ordering invariant", () => {
    expect(parseSalaryLine("$180k - $150k")).toMatchObject({
      minMinor: 15_000_000,
      maxMinor: 18_000_000,
    });
  });

  it("keeps hourly rates and unknown currencies as text only", () => {
    const hourly = parseSalaryLine("Rate: $50/hr, long term.");
    expect(hourly).toMatchObject({ currency: "USD", minMinor: null, maxMinor: null });
    expect(hourly?.text).toContain("$50/hr");
    expect(parseSalaryLine("¥500000 per month")).toBeNull();
    expect(parseSalaryLine("great benefits, apply now")).toBeNull();
    expect(parseSalaryLine("")).toBeNull();
  });

  it("finds the first salary line in captured text", () => {
    expect(
      findSalaryLine("About us\nPay: $120,000 base.\nNice office."),
    ).toBe("Pay: $120,000 base.");
    expect(findSalaryLine("no money here")).toBeNull();
  });
});

describe("posted dates", () => {
  it("passes ISO dates through and normalizes datetimes", () => {
    expect(parsePostedDate("2026-08-20")).toBe("2026-08-20");
    expect(parsePostedDate("2026-09-01T09:00:00Z")).toBe("2026-09-01T09:00:00.000Z");
    expect(parsePostedDate("not a date")).toBeNull();
    expect(parsePostedDate("2026-13-45")).toBeNull();
    expect(parsePostedDate(null)).toBeNull();
    expect(parsePostedDate(12345)).toBeNull();
  });
});

describe("apply urls", () => {
  it("resolves relative hrefs and rejects hostile targets", () => {
    expect(
      resolveApplyUrl("/careers/x/apply", "https://example.com/careers/x"),
    ).toBe("https://example.com/careers/x/apply");
    expect(
      resolveApplyUrl("https://boards.test/jobs/1/apply", "https://jobs.test/1"),
    ).toBe("https://boards.test/jobs/1/apply");
    expect(resolveApplyUrl("javascript:alert(1)", "https://example.com/")).toBeNull();
    expect(resolveApplyUrl("mailto:a@b.c", "https://example.com/")).toBeNull();
    expect(resolveApplyUrl(null, "https://example.com/")).toBeNull();
    expect(resolveApplyUrl("", "https://example.com/")).toBeNull();
  });
});
