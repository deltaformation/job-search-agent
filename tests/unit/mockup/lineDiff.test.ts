import { describe, expect, it } from "vitest";
import {
  countChanges,
  diffLines,
  displayLine,
  groupBySection,
  splitLines,
} from "@/app/mockup/utils/lineDiff";
import { MASTER_TEXT, TAILORED_V1_TEXT, TAILORED_V2_TEXT } from "@/app/mockup/fixtures/diffFixtures";

describe("mockup lineDiff", () => {
  it("marks identical lines as same and preserves blank lines", () => {
    const rows = diffLines(["a", "", "b"], ["a", "", "b"]);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.kind === "same")).toBe(true);
    expect(rows[1].left).toBe("");
    expect(rows[1].right).toBe("");
  });

  it("pairs changed runs into aligned change rows with line numbers", () => {
    const rows = diffLines(["a", "old", "b"], ["a", "new", "b"]);
    expect(rows.map((row) => row.kind)).toEqual(["same", "change", "same"]);
    expect(rows[1]).toMatchObject({ leftNo: 2, rightNo: 2, left: "old", right: "new" });
  });

  it("emits pure additions and removals without a counterpart", () => {
    const rows = diffLines(["a", "gone", "b"], ["a", "b", "extra"]);
    expect(rows.map((row) => row.kind)).toEqual(["same", "del", "same", "add"]);
    expect(rows[1]).toMatchObject({ leftNo: 2, rightNo: null });
    expect(rows[3]).toMatchObject({ leftNo: null, rightNo: 3 });
  });

  it("groups fixture rows by section and flags changed sections", () => {
    const rows = diffLines(splitLines(MASTER_TEXT), splitLines(TAILORED_V1_TEXT));
    const sections = groupBySection(rows);
    const titles = sections.map((section) => section.title);
    expect(titles).toContain("SUMMARY");
    expect(titles).toContain("EXPERIENCE");
    expect(titles).toContain("SKILLS");
    const summary = sections.find((section) => section.title === "SUMMARY");
    const skills = sections.find((section) => section.title === "SKILLS");
    expect(summary?.changed).toBe(true);
    expect(skills?.changed).toBe(false);
    const { removals, additions } = countChanges(rows);
    expect(removals).toBeGreaterThan(0);
    expect(additions).toBeGreaterThan(0);
  });

  it("keeps v1 and v2 fixtures distinct with a small real diff", () => {
    const rows = diffLines(splitLines(TAILORED_V1_TEXT), splitLines(TAILORED_V2_TEXT));
    const { removals, additions } = countChanges(rows);
    expect(removals).toBeGreaterThan(0);
    expect(removals).toBeLessThan(10);
    expect(additions).toBe(removals);
  });

  it("strips section markers for display without touching other text", () => {
    expect(displayLine("## SUMMARY")).toEqual({ text: "SUMMARY", level: 2 });
    expect(displayLine("### AOT Technologies — Lead")).toEqual({
      text: "AOT Technologies — Lead",
      level: 3,
    });
    expect(displayLine("  spaced  ")).toEqual({ text: "  spaced  ", level: 0 });
  });
});
