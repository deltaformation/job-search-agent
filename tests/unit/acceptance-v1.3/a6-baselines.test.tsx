import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MockupPage from "@/app/mockup/page";
import JobCard from "@/components/board/JobCard";
import {
  createTestDatabase,
  jobs,
  newId,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getBoardView, getJobDetail } from "../../../src/server/board";
import { getResumeReviewView } from "../../../src/server/review";
import type { BoardCardView } from "../../../src/server/board";
import { runWithWorld, seedCrossProfileWorld } from "../acceptance-v1.2/world";

/**
 * A6: actual query baselines and accessible names. Query counts are
 * pinned exactly — an order that legitimately changes a read (e.g.
 * H's +1 batch artifact query) must update the pin and
 * `docs/contracts/v1.3-a-baseline.md` together. Role/name
 * assertions cover the mockup keyboard phrase-role path and the
 * production card drag/activation separation.
 */

function withDatabase(fn: (t: TestDatabase) => void): void {
  const t = createTestDatabase("job-tracker-v13-a6-");
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

/** Count SQLite statements through the single Drizzle prepare choke point. */
function countQueries(handle: DatabaseHandle, fn: () => void): number {
  const sqlite = handle.sqlite;
  const originalPrepare = sqlite.prepare;
  let queryCount = 0;
  sqlite.prepare = ((source: string) => {
    queryCount += 1;
    return originalPrepare.call(sqlite, source);
  }) as typeof sqlite.prepare;
  try {
    fn();
  } finally {
    sqlite.prepare = originalPrepare;
  }
  return queryCount;
}

describe("A6 query baselines (2026-09-16 tree, migrations 0000–0007)", () => {
  it("reads the board in exactly 6 statements empty, 7 with cards (H adds 1 batch artifact query)", () => {
    withDatabase((t) => {
      expect(countQueries(t.handle, () => getBoardView(t.handle, {}))).toBe(6);
      seedCrossProfileWorld(t);
      // H: 1 totals + 5 columns + 1 batch selected-approved PDF query (Q7).
      expect(countQueries(t.handle, () => getBoardView(t.handle, {}))).toBe(7);
    });
  });

  it("reads a bare NEW job detail in exactly 9 statements", () => {
    withDatabase((t) => {
      const bareId = newId();
      t.handle.db
        .insert(jobs)
        .values({ id: bareId, status: "NEW", rowVersion: 1, tailoringState: "READY" })
        .run();
      expect(countQueries(t.handle, () => getJobDetail(t.handle, bareId))).toBe(9);
      expect(getJobDetail(t.handle, bareId)?.job.id).toBe(bareId);
    });
  });

  it("reads a rich job detail in exactly 15 statements", () => {
    runWithWorld((t, world) => {
      expect(countQueries(t.handle, () => getJobDetail(t.handle, world.jobId))).toBe(15);
    });
  });

  // G: the workflowReview extension rides one batched statement
  // (13 + 1 = 14, within the §8 full-review budget of baseline+3).
  it("reads the review view with workflow extension in exactly 14 statements", () => {
    runWithWorld((t, world) => {
      expect(countQueries(t.handle, () => getResumeReviewView(t.handle, world.v1Id))).toBe(14);
    });
  });
});

describe("A6 mockup keyboard phrase-role assignment", () => {
  it("pairs every draggable phrase with a named keyboard assigner", () => {
    render(<MockupPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Tailor Resume$/ }));
    const assigners = screen.getAllByRole("combobox", { name: /Assign phrase .* to role/ });
    expect(assigners).toHaveLength(5);
    const draggables = document.querySelectorAll('[draggable="true"]');
    expect(draggables.length).toBe(5);
    for (const assigner of assigners) {
      expect(assigner).toHaveAccessibleName(expect.stringMatching(/^Assign phrase ".+" to role$/));
    }
  });
});

describe("A6 production card drag/activation separation", () => {
  const card: BoardCardView = {
    id: "job-1",
    status: "NEW",
    rank: 0,
    rowVersion: 1,
    title: "Lead Product Manager, Supply Chain Systems",
    company: "Lime",
    location: "Canada",
    arrangement: "Remote",
    salaryText: "CA$126,000–CA$174,000",
    salaryCurrency: "CAD",
    salaryMinMinor: 12600000,
    salaryMaxMinor: 17400000,
    scrapeState: "SUCCEEDED",
    scrapeReasonCode: null,
    tailoringState: "READY",
    tailoringReasonCode: null,
    resume: null,
    selectedApprovedPdfArtifactId: null,
    selectedApprovedPdfSha256: null,
    notesCount: 0,
    sourceUrl: "https://example.com/jobs/lime",
    appliedAt: null,
    createdAt: "2026-09-16T12:00:00.000Z",
    updatedAt: "2026-09-16T12:00:00.000Z",
  };

  it("labels the card, drag handle, and open control distinctly", () => {
    const onOpen = vi.fn();
    render(
      <DndContext id="board-dnd-context">
        <JobCard card={card} onOpen={onOpen} />,
      </DndContext>,
    );
    const headline = "Lead Product Manager, Supply Chain Systems";
    expect(document.querySelector(`li[aria-label="${headline}, New"]`)).not.toBeNull();
    const drag = screen.getByRole("button", { name: `Drag ${headline} to move it` });
    expect(drag).toHaveAttribute("aria-describedby", "board-dnd-context");
    const open = screen.getByRole("button", { name: `Open details for ${headline}` });
    expect(open).not.toBe(drag);
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith("job-1");
    fireEvent.click(drag);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
