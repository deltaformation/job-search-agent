import { describe, expect, it } from "vitest";
import { computeLineDiff } from "@/app/mockup/utils/diff";

describe("computeLineDiff", () => {
  it("computes unchanged lines when texts are identical", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const result = computeLineDiff(text, text);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
    expect(result.totalUnchanged).toBe(3);
    expect(result.sections[0]?.hasChanges).toBe(false);
  });

  it("identifies additions and deletions correctly", () => {
    const orig = "Header\nOld line\nFooter";
    const tail = "Header\nNew line\nFooter";
    const result = computeLineDiff(orig, tail);
    expect(result.totalDeletions).toBe(1);
    expect(result.totalAdditions).toBe(1);
    expect(result.totalUnchanged).toBe(2);
    expect(result.sections[0]?.hasChanges).toBe(true);
  });

  it("partitions sections based on markdown ## headers", () => {
    const orig = "# Title\n\n## Summary\nMaster summary.\n\n## Skills\nOld skills.";
    const tail = "# Title\n\n## Summary\nTailored summary.\n\n## Skills\nOld skills.";
    const result = computeLineDiff(orig, tail);
    expect(result.sections.length).toBeGreaterThan(1);
    const summarySection = result.sections.find((s) => s.title.includes("Summary"));
    const skillsSection = result.sections.find((s) => s.title.includes("Skills"));
    expect(summarySection?.hasChanges).toBe(true);
    expect(skillsSection?.hasChanges).toBe(false);
  });
});
