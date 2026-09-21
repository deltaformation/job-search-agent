// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DIFF_WORK_BUDGET,
  diffReviewTexts,
  displayReviewLine,
  escapeReviewHtml,
  splitReviewLines,
  type ReviewDiffSegment,
} from "../../../src/domain/reviewDiff";

/**
 * WO-1.3-G (G6): pure bounded production diff. Line/byte behavior,
 * escaping, non-color markers, v2 operation attribution, excluded
 * rendering, and the bounded full-text fallback.
 */

function segment(
  overrides: Partial<ReviewDiffSegment> & { text: string },
): ReviewDiffSegment {
  return {
    segmentId: "seg-1",
    kind: "bullet",
    roleId: "emp-harbor",
    provenance: "VERIFIED_SOURCE",
    sourceOperationId: null,
    ...overrides,
  };
}

describe("G6 pure diff", () => {
  it("preserves blank lines and interior spaces verbatim", () => {
    const master = "line one\n\n   indented   \nlast";
    const tailored = "line one\n\n   indented   \nlast!";
    const result = diffReviewTexts({
      masterText: master,
      tailoredText: tailored,
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    expect(result.rows.map((row) => row.left ?? row.right)).toContain("");
    expect(result.rows.map((row) => row.right ?? row.left)).toContain("   indented   ");
    const changed = result.rows.filter((row) => row.kind === "change");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.left).toBe("last");
    expect(changed[0]?.right).toBe("last!");
  });

  it("normalizes CRLF and drops exactly one trailing artifact line", () => {
    expect(splitReviewLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitReviewLines("a\n\n")).toEqual(["a", ""]);
    const result = diffReviewTexts({
      masterText: "a\n",
      tailoredText: "a\r\n",
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.kind).toBe("same");
  });

  it("escapes hostile HTML without executing or dropping it", () => {
    const hostile = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    expect(escapeReviewHtml(hostile)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeReviewHtml("a & b 'q'")).toBe("a &amp; b &#39;q&#39;");
    const result = diffReviewTexts({
      masterText: "safe",
      tailoredText: hostile,
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    // The hostile bytes stay intact in the model (renderers escape).
    expect(result.rows.some((row) => row.right === hostile)).toBe(true);
  });

  it("marks every row kind with a non-color text marker", () => {
    const result = diffReviewTexts({
      masterText: "same\nold\nswap-a",
      tailoredText: "same\nnew\nswap-b",
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    const byKind = new Map(result.rows.map((row) => [row.kind, row.marker]));
    expect(byKind.get("same")).toBe(" ");
    expect(byKind.get("del") ?? byKind.get("change")).toBeDefined();
    for (const row of result.rows) {
      expect([" ", "-", "+", "~"]).toContain(row.marker);
    }
    expect(result.removals).toBeGreaterThan(0);
    expect(result.additions).toBeGreaterThan(0);
  });

  it("attributes v2 tailored lines to source operations with provenance tags", () => {
    const accepted = segment({
      segmentId: "seg-acc",
      text: "Accepted AI bullet text.",
      provenance: "USER_ACCEPTED_AI",
      sourceOperationId: "op-acc",
    });
    const edited = segment({
      segmentId: "seg-ed",
      text: "User-edited bullet text.",
      provenance: "USER_EDITED",
      sourceOperationId: "op-ed",
    });
    const summary = segment({
      segmentId: "seg-sum",
      kind: "summary",
      roleId: null,
      text: "Tailored summary line.",
      provenance: "VERIFIED_SOURCE",
      sourceOperationId: null,
    });
    const result = diffReviewTexts({
      masterText: "# Name\n\n## Summary\n\nMaster summary.\n",
      tailoredText:
        "# Name\n\n## Summary\n\nTailored summary line.\n\n## Professional Experience\n\n- Accepted AI bullet text.\n- User-edited bullet text.\n",
      segments: [summary, accepted, edited],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    const byRight = new Map(
      result.rows
        .filter((row) => row.right !== null)
        .map((row) => [row.right as string, row]),
    );
    const accRow = byRight.get("- Accepted AI bullet text.");
    expect(accRow?.attribution).toMatchObject({
      segmentId: "seg-acc",
      provenance: "USER_ACCEPTED_AI",
      sourceOperationId: "op-acc",
    });
    expect(accRow?.provenanceTag).toBe("A");
    const edRow = byRight.get("- User-edited bullet text.");
    expect(edRow?.attribution).toMatchObject({
      segmentId: "seg-ed",
      provenance: "USER_EDITED",
      sourceOperationId: "op-ed",
    });
    expect(edRow?.provenanceTag).toBe("E");
    const sumRow = byRight.get("Tailored summary line.");
    expect(sumRow?.attribution).toMatchObject({
      segmentId: "seg-sum",
      provenance: "VERIFIED_SOURCE",
    });
    expect(sumRow?.provenanceTag).toBe("V");
  });

  it("consumes duplicate bullet texts in order and never misattributes", () => {
    const first = segment({ segmentId: "seg-1", text: "Same words." });
    const second = segment({
      segmentId: "seg-2",
      text: "Same words.",
      provenance: "USER_EDITED",
      sourceOperationId: "op-2",
    });
    const result = diffReviewTexts({
      masterText: "x",
      tailoredText: "- Same words.\n- Same words.\n- Same words.\n",
      segments: [first, second],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    const bullets = result.rows.filter((row) => row.right?.startsWith("- "));
    expect(bullets).toHaveLength(3);
    expect(bullets[0]?.attribution?.segmentId).toBe("seg-1");
    expect(bullets[1]?.attribution?.segmentId).toBe("seg-2");
    // Third occurrence has no frozen segment: unattributed, never guessed.
    expect(bullets[2]?.attribution).toBeNull();
    expect(bullets[2]?.provenanceTag).toBeNull();
  });

  it("renders excluded master content as excluded, never resurrected", () => {
    const result = diffReviewTexts({
      masterText:
        "## Experience\n\n- Kept bullet `[f1 · APPROVED]`\n- Dropped bullet `[f2 · APPROVED]`\n",
      tailoredText: "## Experience\n\n- Kept bullet `[f1 · APPROVED]`\n",
      segments: [],
      excludedMasterTexts: ["Dropped bullet"],
    });
    expect(result.diffAvailable).toBe(true);
    const dropped = result.rows.find((row) => row.left?.includes("Dropped bullet"));
    expect(dropped?.kind).toBe("del");
    expect(dropped?.leftExcluded).toBe(true);
    const kept = result.rows.find((row) => row.left?.includes("Kept bullet"));
    expect(kept?.leftExcluded).toBe(false);
    // The tailored side carries no resurrected excluded bytes.
    expect(result.rows.some((row) => row.right?.includes("Dropped bullet"))).toBe(false);
  });

  it("falls back to full text when diff work exceeds 1,000,000 units", () => {
    const side = (prefix: string): string =>
      Array.from({ length: 1200 }, (_, index) => `${prefix} line ${index}`).join("\n");
    const masterText = side("master");
    const tailoredText = side("tailored");
    const result = diffReviewTexts({
      masterText,
      tailoredText,
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.workUnits).toBeGreaterThan(DIFF_WORK_BUDGET);
    expect(result.diffAvailable).toBe(false);
    expect(result.reason).toBe("over-work-budget");
    expect(result.rows).toEqual([]);
    // Fallback keeps both complete texts (asserted by the caller
    // rendering the inputs, never truncated model output).
    expect(masterText.length).toBeGreaterThan(0);
    expect(tailoredText.length).toBeGreaterThan(0);
  });

  it("falls back over the line cap instead of truncating or hanging", () => {
    const masterText = Array.from({ length: 10_001 }, (_, i) => `m${i}`).join("\n");
    const result = diffReviewTexts({
      masterText,
      tailoredText: "one",
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(false);
    expect(result.reason).toBe("over-line-cap");
  });

  it("groups rows by section for the changed-only filter", () => {
    const result = diffReviewTexts({
      masterText: "## Alpha\n\nsame\n\n## Beta\n\nold\n",
      tailoredText: "## Alpha\n\nsame\n\n## Beta\n\nnew\n",
      segments: [],
      excludedMasterTexts: [],
    });
    expect(result.diffAvailable).toBe(true);
    const titles = result.sections.map((section) => [
      section.title,
      section.changed,
    ]);
    expect(titles).toContainEqual(["Alpha", false]);
    expect(titles).toContainEqual(["Beta", true]);
  });

  it("strips heading markers for display and keeps other text verbatim", () => {
    expect(displayReviewLine("## Summary")).toEqual({ text: "Summary", level: 2 });
    expect(displayReviewLine("### Role · Co")).toEqual({ text: "Role · Co", level: 3 });
    expect(displayReviewLine("- bullet  with  spaces")).toEqual({
      text: "- bullet  with  spaces",
      level: 0,
    });
  });
});
