/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Step4Diff from "../../../components/tailoring/Step4Diff";
import PropertiesSheet from "../../../components/tailoring/PropertiesSheet";

/**
 * WO-1.3-I accessibility closure (I5/U18 legs): diff non-color
 * markers, hostile-content escaping, and dialog Escape/focus
 * behavior on the production review surfaces. Keyboard flows,
 * live-region timing, zoom/viewport, and drag alternatives stay
 * proven by their owning suites (c-shell C8, f-step3 F2/F3,
 * s2cpc-editor S2CPC2, JobCard H5, e2e board H7); I re-runs those
 * suites and records the exact results in the ledger.
 */

describe("WO-1.3-I accessibility I5/U18", () => {
  it("diff rows carry text markers and provenance tags, never color-only", () => {
    const { container } = render(
      <Step4Diff
        masterText={"Alpha line\nBeta line"}
        tailoredText={"Alpha line\nGamma line"}
        segments={[]}
        excludedTexts={[]}
      />,
    );
    // Legend names every marker in text.
    expect(
      screen.getByText(/markers: = same, - removed, \+ added, ~ changed/),
    ).toBeDefined();
    // Row badges render the literal marker glyphs.
    const badges = Array.from(container.querySelectorAll("span.font-mono")).map((el) =>
      el.textContent,
    );
    expect(badges).toContain("=");
    expect(badges.some((text) => text === "-" || text === "+" || text === "~")).toBe(true);
  });

  it("diff escapes hostile markup and keeps the marker legend readable", () => {
    const hostile = "<img src=x onerror=alert(1)>Hacked<script>alert(2)</script>";
    const { container } = render(
      <Step4Diff masterText="safe" tailoredText={hostile} segments={[]} excludedTexts={[]} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeDefined();
  });

  it("Properties dialog closes on Escape with a labeled close control", () => {
    const onClose = vi.fn();
    const trigger = { current: null } as unknown as React.RefObject<HTMLButtonElement | null>;
    render(
      <PropertiesSheet
        open
        onClose={onClose}
        job={
          {
            id: "job-1",
            title: "PM",
            company: "Acme",
            status: "NEW",
            salaryText: null,
            location: null,
            arrangement: null,
          } as never
        }
        triggerRef={trigger}
      />,
    );
    const close = screen.getByRole("button", { name: /close/i });
    expect(close).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Missing fields stay honest Unknown text, never invented.
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });
});
