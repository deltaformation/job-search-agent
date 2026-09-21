import { describe, expect, it } from "vitest";
import {
  groupIssuesByPath,
  issuePathLabel,
  profileReadiness,
  type SettingsProfileSummary,
} from "../../../../components/settings/profiles";

/** WO-1.2-C: readiness states and issue grouping are pure and exact. */

function summary(overrides: Partial<SettingsProfileSummary>): SettingsProfileSummary {
  return {
    id: "p1",
    name: "pm",
    displayName: "Product Manager",
    isDefault: false,
    workPreferences: null,
    executiveNarrative: null,
    versionCount: 0,
    latestVersion: null,
    latestVersionAt: null,
    activeVersion: null,
    approvedFacts: 0,
    activeSource: null,
    ...overrides,
  };
}

describe("profileReadiness", () => {
  it("reports ready only with an active version", () => {
    const ready = profileReadiness(
      summary({ activeVersion: 2, latestVersion: 2, versionCount: 2, approvedFacts: 6 }),
    );
    expect(ready.state).toBe("ready");
    expect(ready.detail).toContain("v2");
    expect(ready.detail).toContain("6 approved facts");
  });

  it("reports staged versions as needing explicit activation", () => {
    const staged = profileReadiness(summary({ latestVersion: 1, versionCount: 1 }));
    expect(staged.state).toBe("staged");
    if (staged.state === "staged") {
      expect(staged.version).toBe(1);
    }
    expect(staged.detail).toMatch(/not active|activate/i);
  });

  it("reports empty profiles with the onboarding action", () => {
    const empty = profileReadiness(summary({}));
    expect(empty.state).toBe("empty");
    expect(empty.detail).toMatch(/upload|paste|example/i);
  });
});

describe("issue paths", () => {
  it("labels and groups issues by dotted path", () => {
    expect(issuePathLabel(["employment", 0, "endDate"])).toBe("employment.0.endDate");
    expect(issuePathLabel([])).toBe("");
    const grouped = groupIssuesByPath([
      { path: ["identity", "email"], message: "bad" },
      { path: ["identity", "email"], message: "worse" },
      { path: ["summary"], message: "long" },
    ]);
    expect(grouped.get("identity.email")).toHaveLength(2);
    expect(grouped.get("summary")).toHaveLength(1);
  });
});
