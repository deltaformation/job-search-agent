import { DndContext } from "@dnd-kit/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
