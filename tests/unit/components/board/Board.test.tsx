import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardCardView, BoardView } from "../../../../src/server/board";
import Board from "../../../../components/board/Board";

function card(overrides: Partial<BoardCardView> & { id: string; status: BoardCardView["status"] }): BoardCardView {
  return {
    rank: 0,
    rowVersion: 1,
    title: "Staff Engineer",
    company: "Gamma LLC",
    location: "Remote",
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
    sourceUrl: "https://example.com/jobs/1",
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
    ...overrides,
  };
}

function boardView(): BoardView {
  return {
    columns: [
      { status: "NEW", total: 1, cards: [card({ id: "job-new", status: "NEW" })] },
      {
        status: "TAILORED",
        total: 1,
        cards: [card({ id: "job-tailored", status: "TAILORED", title: "Designer" })],
      },
      { status: "APPLIED", total: 0, cards: [] },
      { status: "INTERVIEWED", total: 0, cards: [] },
      { status: "REJECTED", total: 0, cards: [] },
    ],
  };
}

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe("Board", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders five columns with cards and counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(boardView())));
    render(<Board />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText("Designer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /new \(1 of 1\)/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /applied \(0 of 0\)/i })).toBeInTheDocument();
  });

  it("announces load failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "database unavailable" }),
      }),
    );
    render(<Board />);
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
  });

  it("searches and sorts through the board API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(boardView()));
    vi.stubGlobal("fetch", fetchMock);
    render(<Board />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search cards"), { target: { value: "designer" } });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calls.some((url) => url.includes("q=designer"))).toBe(true);
    });

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "updated" } });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calls.some((url) => url.includes("sort=updated"))).toBe(true);
    });
  });

  it("opens the detail drawer from a card", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/jobs/job-new") {
        return Promise.resolve(
          okJson({
            job: {
              id: "job-new",
              status: "NEW",
              rank: 0,
              rowVersion: 1,
              title: "Staff Engineer",
              company: null,
              location: null,
              arrangement: null,
              salaryText: null,
              salaryCurrency: null,
              salaryMinMinor: null,
              salaryMaxMinor: null,
              descriptionText: null,
              postedAt: null,
              scrapeState: "SUCCEEDED",
              scrapeReasonCode: null,
              tailoringState: "PENDING",
              tailoringReasonCode: null,
              activeExtractionId: null,
              activeResumeVersionId: null,
              createdAt: "2026-09-11T10:00:00.000Z",
              updatedAt: "2026-09-11T10:00:00.000Z",
            },
            source: null,
            attempts: [],
            tailoringAttempt: null,
            artifacts: [],
            extraction: null,
            compensationHighlights: [],
            topKeywords: [],
            resumes: [],
            notes: [],
            application: null,
            history: [],
            intake: null,
          }),
        );
      }
      return Promise.resolve(okJson(boardView()));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Board />);
    fireEvent.click(await screen.findByRole("button", { name: /open details for staff engineer/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("Facts")).toBeInTheDocument();
  });

  it("shows the prominent salary range badge on cards", async () => {
    const view = boardView();
    view.columns[0]!.cards = [
      card({
        id: "job-paid",
        status: "NEW",
        salaryText: "$145,900 - $197,400 CAD per year",
        salaryCurrency: "CAD",
        salaryMinMinor: 14590000,
        salaryMaxMinor: 19740000,
      }),
      card({
        id: "job-hourly",
        status: "NEW",
        title: "Hourly Role",
        salaryText: "$75 - $95 / hr",
        salaryCurrency: "USD",
        salaryMinMinor: null,
        salaryMaxMinor: null,
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(view)));
    render(<Board />);
    expect(await screen.findByText("$146k – $197k CAD")).toBeInTheDocument();
    expect(screen.getByText("$75 - $95 / hr")).toBeInTheDocument();
  });

  it("shows tailoring progress and failure badges on cards", async () => {
    const view = boardView();
    view.columns[0]!.cards = [
      card({ id: "job-running", status: "NEW", title: "Running Role", tailoringState: "RUNNING" }),
      card({ id: "job-failed", status: "NEW", title: "Failed Role", tailoringState: "FAILED" }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson(view)));
    render(<Board />);
    expect(await screen.findByText("Running Role")).toBeInTheDocument();
    expect(screen.getByText("Tailoring in progress…")).toBeInTheDocument();
    expect(screen.getByText("Tailoring failed (open to retry)")).toBeInTheDocument();
  });

  it("polls while a card is RUNNING and stops once settled", async () => {
    vi.useFakeTimers();
    try {
      const running = boardView();
      running.columns[0]!.cards = [
        card({ id: "job-running", status: "NEW", tailoringState: "RUNNING" }),
      ];
      const settled = boardView();
      settled.columns[0]!.cards = [
        card({
          id: "job-running",
          status: "NEW",
          tailoringState: "AWAITING_REVIEW",
          resume: { versionId: "ver-1", version: 1, reviewState: "AWAITING_REVIEW" },
        }),
      ];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson(running))
        .mockResolvedValue(okJson(settled));
      vi.stubGlobal("fetch", fetchMock);
      render(<Board />);
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(screen.getByText("Tailoring in progress…")).toBeInTheDocument();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.getByText("Resume v1: Awaiting review")).toBeInTheDocument();
      expect(screen.queryByText("Tailoring in progress…")).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll when nothing is running", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(okJson(boardView()));
      vi.stubGlobal("fetch", fetchMock);
      render(<Board />);
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
