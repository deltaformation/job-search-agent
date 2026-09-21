import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardCardView } from "../../../../src/server/board";
import JobCard from "../../../../components/board/JobCard";

const DAY_MS = 86_400_000;

function card(overrides: Partial<BoardCardView> = {}): BoardCardView {
  return {
    id: "job-1",
    status: "APPLIED",
    rank: 0,
    rowVersion: 1,
    title: "Staff Engineer",
    company: "Gamma LLC",
    location: null,
    arrangement: null,
    salaryText: null,
    salaryCurrency: null,
    salaryMinMinor: null,
    salaryMaxMinor: null,
    scrapeState: "SUCCEEDED",
    scrapeReasonCode: null,
    tailoringState: "PENDING",
    tailoringReasonCode: null,
    resume: null,
    selectedApprovedPdfArtifactId: null,
    selectedApprovedPdfSha256: null,
    notesCount: 0,
    sourceUrl: null,
    appliedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function appliedDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function setup(entry: BoardCardView) {
  const onOpen = vi.fn();
  render(
    <DndContext>
      <JobCard card={entry} onOpen={onOpen} />
    </DndContext>,
  );
  return { onOpen };
}

describe("JobCard follow-up badge", () => {
  it.each([
    ["Follow-up suggested (7d)", 7],
    ["Follow-up suggested (7d)", 13],
    ["Follow-up suggested (14d)", 14],
    ["Follow-up suggested (14d)", 29],
    ["Follow-up suggested (30d+)", 30],
    ["Follow-up suggested (30d+)", 90],
  ])("shows %s on applied cards %d days old", (label, days) => {
    setup(card({ appliedAt: appliedDaysAgo(days) }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("omits the badge for recent applications", () => {
    setup(card({ appliedAt: appliedDaysAgo(6) }));
    expect(screen.queryByText(/follow-up suggested/i)).toBeNull();
  });

  it("omits the badge without a timestamp or outside APPLIED", () => {
    const { unmount } = render(
      <DndContext>
        <JobCard card={card({ appliedAt: null })} onOpen={() => {}} />
      </DndContext>,
    );
    expect(screen.queryByText(/follow-up suggested/i)).toBeNull();
    unmount();
    setup(card({ status: "INTERVIEWED", appliedAt: appliedDaysAgo(45) }));
    expect(screen.queryByText(/follow-up suggested/i)).toBeNull();
  });

  it("omits the badge for unparseable or future timestamps", () => {
    const { unmount } = render(
      <DndContext>
        <JobCard card={card({ appliedAt: "not-a-date" })} onOpen={() => {}} />
      </DndContext>,
    );
    expect(screen.queryByText(/follow-up suggested/i)).toBeNull();
    unmount();
    setup(card({ appliedAt: new Date(Date.now() + DAY_MS).toISOString() }));
    expect(screen.queryByText(/follow-up suggested/i)).toBeNull();
  });
});

describe("JobCard Download Resume (H3/H4/H5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const approved = () =>
    card({
      status: "TAILORED",
      tailoringState: "AWAITING_REVIEW",
      resume: { versionId: "ver-1", version: 1, reviewState: "APPROVED" },
      selectedApprovedPdfArtifactId: "art-pdf-1",
      selectedApprovedPdfSha256: "a".repeat(64),
    });

  it("links the exact batched artifact with download semantics", () => {
    setup(approved());
    const link = screen.getByRole("link", { name: "Download approved resume for Staff Engineer" });
    expect(link).toHaveAttribute("href", "/api/resumes/artifacts/art-pdf-1?download=1");
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("click and Enter on Download never open the card (H5)", () => {
    const { onOpen } = setup(approved());
    const link = screen.getByRole("link", { name: "Download approved resume for Staff Engineer" });
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    // A plain anchor: not a button, not the drag handle.
    expect(link.tagName).toBe("A");
    expect(link).not.toHaveAttribute("aria-describedby", "board-dnd-context");
  });

  it("Space/drag on Download neither opens the card nor issues board queries (H5)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { onOpen } = setup(approved());
    const link = screen.getByRole("link", { name: "Download approved resume for Staff Engineer" });
    fireEvent.keyDown(link, { key: " " });
    fireEvent.keyUp(link, { key: " " });
    fireEvent.dragStart(link);
    fireEvent.mouseDown(link, { button: 0 });
    expect(onOpen).not.toHaveBeenCalled();
    // No app fetch: activation is exactly one browser artifact GET, so Q1/Q4 are untouched.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(link).toHaveAttribute("href", "/api/resumes/artifacts/art-pdf-1?download=1");
  });

  it("renders explicit unavailable state with versions but no selection (H4)", () => {
    setup(
      card({
        status: "NEW",
        tailoringState: "AWAITING_REVIEW",
        resume: { versionId: "ver-1", version: 1, reviewState: "AWAITING_REVIEW" },
      }),
    );
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /download approved resume/i }),
    ).toBeNull();
  });

  it("renders no download UI before any version exists", () => {
    setup(card({}));
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByText("Resume")).toBeNull();
  });
});
