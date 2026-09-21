import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockupPage from "@/app/mockup/page";

/**
 * A1: every callback/control in mockup Step 1–4/header/properties/
 * notes/viewers maps to a `docs/tailoring-contracts-v1.3.md` §5
 * production operation (or a recorded gap), and no production code
 * imports mockup fixtures. Each assertion below is one row of
 * `docs/contracts/v1.3-a-mockup-inventory.md`.
 *
 * Gaps pinned here (mockup differs from §5 deliberately):
 * - G-BOARD-1: no board card / back-to-board chrome in the prototype.
 * - G-NOTES-1: Notes & Timeline has no opener (hidden per
 *   MOCKUP-V1-REFINE); production restores it via the notes API.
 */

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...productionFiles(path));
    } else if (/\.(ts|tsx|mjs|cjs)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

describe("A1 production import scan", () => {
  it("imports no mockup fixtures outside app/mockup and tests", () => {
    const roots = ["app", "src", "components"].map((dir) => join(process.cwd(), dir));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of productionFiles(root)) {
        if (file.includes(`${join(process.cwd(), "app", "mockup")}/`)) {
          continue;
        }
        const text = readFileSync(file, "utf8");
        const hits = [...text.matchAll(/(?:from|import)\s*["']([^"']*mockup[^"']*)["']/g)];
        if (hits.length > 0) {
          offenders.push(`${file}: ${hits.map((hit) => hit[1]).join(", ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("A1 header and step indicator (§5: header/navigation rows)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes status, Properties, and the four-step navigator", () => {
    render(<MockupPage />);
    expect(screen.getAllByText("NEW").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: "Open job properties sheet" }),
    ).toBeInTheDocument();
    const nav = within(screen.getByRole("navigation", { name: /Tailoring workflow progress/i }));
    for (const label of ["Review data", "Tailor Resume", "Generate", "Review & approve"]) {
      expect(nav.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
    const current = nav.getByRole("button", { name: /Review data/ });
    expect(current).toHaveAttribute("aria-current", "step");
  });

  it("pins gap G-BOARD-1: the prototype has no board card or back-to-board control", () => {
    render(<MockupPage />);
    expect(screen.queryByRole("button", { name: /back to board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /back to board/i })).not.toBeInTheDocument();
  });

  it("opens Properties (§5: Properties/Notes open-close) and dismisses with Escape", () => {
    render(<MockupPage />);
    fireEvent.click(screen.getByRole("button", { name: "Open job properties sheet" }));
    const dialog = screen.getByRole("dialog", { name: /Properties/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Overview")).toBeInTheDocument();
    expect(within(dialog).getByText("Original posting")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /Properties/i })).not.toBeInTheDocument();
  });

  it("pins gap G-NOTES-1: Notes & Timeline currently has no opener", () => {
    render(<MockupPage />);
    expect(screen.queryByRole("button", { name: /notes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Notes & Timeline/i })).not.toBeInTheDocument();
  });
});

describe("A1 Step 1 (§5: Original posting, Step 1 Tailor Resume)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the full JD with safe external links and the Tailor Resume action", () => {
    render(<MockupPage />);
    expect(screen.getByText(/What You'll Do \(11 items\)/i)).toBeInTheDocument();
    expect(screen.getByText(/About You \(7 items\)/i)).toBeInTheDocument();
    const posting = screen.getByRole("link", { name: /Original posting/ });
    expect(posting).toHaveAttribute("target", "_blank");
    expect(posting).toHaveAttribute("rel", expect.stringContaining("noopener"));
    const ashby = screen.getByRole("link", { name: /View original posting on Ashby/ });
    expect(ashby).toHaveAttribute("target", "_blank");
    fireEvent.click(screen.getByRole("button", { name: /^Tailor Resume$/ }));
    expect(screen.getByRole("heading", { name: /Candidate profile/i })).toBeInTheDocument();
  });
});

describe("A1 Step 2 (§5: profile, cloud/inspector, themes, summary, mappings, guidance, Generate)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function onStep2() {
    render(<MockupPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Tailor Resume$/ }));
  }

  it("maps profile selection, master preview, and editor link", () => {
    onStep2();
    expect(screen.getByRole("combobox", { name: "Candidate profile" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Preview master resume/i }));
    expect(screen.getByRole("dialog", { name: /Master Resume/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("link", { name: /Edit candidate profile/i })).toHaveAttribute(
      "href",
      "/master-resume",
    );
  });

  it("maps cloud category/search/inspector and keyword selection", () => {
    onStep2();
    expect(screen.getByRole("heading", { name: /Keywords/i })).toBeInTheDocument();
    for (const label of ["All Keywords", "Supply Chain & Fleet", "Enterprise & ERP"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText("Filter cloud terms...")).toBeInTheDocument();
    const cloud = screen.getByRole("region", { name: "Keyword Word Cloud" });
    const term = within(cloud).getByRole("button", { name: /Supply Chain Systems/i });
    expect(term).toHaveAttribute("aria-pressed", expect.anything());
    fireEvent.click(term);
    const gap = within(cloud).getByRole("button", { name: /NetSuite ERP/i });
    fireEvent.click(gap);
    expect(screen.getByRole("button", { name: "Select keyword" })).toBeInTheDocument();
  });

  it("maps priority phrases, themes, and the summary editor", () => {
    onStep2();
    expect(screen.getByRole("heading", { name: /Priority phrases/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Strong Match/i).length).toBeGreaterThanOrEqual(1);
    const positioning = screen.getByRole("heading", { name: /Positioning/i });
    expect(positioning).toBeInTheDocument();
    const section = positioning.closest("section");
    expect(section).not.toBeNull();
    expect(
      within(section as HTMLElement).getAllByRole("button", { name: /Use theme|Selected/ }),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.getByRole("button", { name: /^Reset$/ })).toBeInTheDocument();
  });

  it("maps keyboard phrase-role assignment (A6) alongside drag phrases", () => {
    onStep2();
    expect(screen.getByRole("heading", { name: /Experience mapping/i })).toBeInTheDocument();
    const assigners = screen.getAllByRole("combobox", { name: /Assign phrase .* to role/ });
    expect(assigners).toHaveLength(5);
    expect(screen.getAllByTitle("Remove phrase").length).toBeGreaterThanOrEqual(1);
  });

  it("maps guidance starters, textarea, Back, and Generate", () => {
    onStep2();
    expect(screen.getByRole("heading", { name: /Additional direction/i })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Focus on route optimization/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Back$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate resume/i })).toBeInTheDocument();
  });
});

describe("A1 Step 3 (§5: status/timer, retry/back, simulation omit)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function onStep3() {
    render(<MockupPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Tailor Resume$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Generate resume/i }));
  }

  it("maps the running status, elapsed clock, and stage tracker", () => {
    onStep3();
    expect(screen.getByText(/Preparing your resume/i)).toBeInTheDocument();
    expect(screen.getByText(/elapsed/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("maps failure retry, connection check, back-to-focus, and error details", () => {
    onStep3();
    fireEvent.click(screen.getByRole("button", { name: /Simulation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Launch failure" }));
    expect(screen.getByRole("button", { name: /Retry generation/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check connection/i }));
    const dialog = screen.getByRole("dialog", { name: /Connection check/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Retry sample/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: /Back to focus/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Error details/i }));
    expect(screen.getByText(/provider spawn failed/i)).toBeInTheDocument();
  });

  it("maps the omit-from-production simulation controls", () => {
    onStep3();
    fireEvent.click(screen.getByRole("button", { name: /Simulation/ }));
    for (const label of ["Complete now", "Slow response", "Launch failure", "Provider error", "Reset"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });
});

describe("A1 Step 4 (§5: version selector, filters, previews, review commands, card download)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function onStep4() {
    render(<MockupPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Tailor Resume$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Generate resume/i }));
    fireEvent.click(screen.getByRole("button", { name: /Simulation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Complete now" }));
  }

  it("maps comparison, diff filters, and exact previews", () => {
    onStep4();
    expect(screen.getByRole("heading", { name: /Resume comparison/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What changed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All sections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Changed sections only" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Original master \(Preview PDF\)/i }),
    ).toBeInTheDocument();
    const tailored = screen.getByRole("link", { name: /Tailored sample v1 \(Preview PDF\)/i });
    expect(tailored).toHaveAttribute("href", "/mockup/sample-tailored-resume.pdf");
    expect(tailored).toHaveAttribute("target", "_blank");
  });

  it("maps approve, request-changes, and decline commands", () => {
    onStep4();
    expect(screen.getByRole("heading", { name: /Review decision/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve version/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Request changes/i }));
    const revision = screen.getByRole("dialog", { name: /Request changes/i });
    expect(within(revision).getByLabelText(/What should change\?/i)).toBeInTheDocument();
    fireEvent.click(within(revision).getByRole("button", { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Decline version/i }));
    const decline = screen.getByRole("dialog", { name: /Decline version/i });
    expect(within(decline).getByLabelText(/Reason/i)).toBeInTheDocument();
    fireEvent.click(within(decline).getByRole("button", { name: /^Cancel$/ }));
  });

  it("maps the post-approval card preview with exact PDF download", () => {
    onStep4();
    fireEvent.click(screen.getByRole("button", { name: /Approve version/i }));
    const download = screen.getByRole("link", { name: /Download Resume \(PDF\)/i });
    expect(download).toHaveAttribute("href", "/mockup/sample-tailored-resume.pdf");
    expect(screen.getByRole("link", { name: /Open application/i })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  it("maps the multi-version selector after a revision run", () => {
    onStep4();
    fireEvent.click(screen.getByRole("button", { name: /Approve version/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create revision/i }));
    const revision = screen.getByRole("dialog", { name: /Request changes/i });
    fireEvent.click(within(revision).getByRole("button", { name: /^Continue$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Generate resume/i }));
    fireEvent.click(screen.getByRole("button", { name: /Simulation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Complete now" }));
    const group = screen.getByRole("group", { name: /Sample versions/i });
    expect(within(group).getByRole("button", { name: /v1.*Approved/ })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: /v2.*Awaiting review/ })).toBeInTheDocument();
    expect(screen.getByText(/Primary approved: Version 1/i)).toBeInTheDocument();
  });
});
