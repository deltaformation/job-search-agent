import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BatchProgress from "../../../components/BatchProgress";

const VIEW = {
  id: "batch-1",
  createdAt: "2026-09-11T12:00:00.000Z",
  rawLineCount: 2,
  enqueuedCount: 1,
  duplicateCount: 0,
  invalidCount: 1,
  blockedCount: 0,
  items: [
    {
      id: "item-1",
      lineNumber: 1,
      rawInput: "https://example.com/jobs/1",
      outcome: "ENQUEUED",
      reasonCode: null,
      canonicalUrl: "https://example.com/jobs/1",
      jobId: null,
      queue: { workItemId: "work-1", workState: "RUNNING", attemptCount: 1, maxAttempts: 3 },
    },
    {
      id: "item-2",
      lineNumber: 2,
      rawInput: "not a url",
      outcome: "INVALID",
      reasonCode: "INVALID_URL",
      canonicalUrl: null,
      jobId: null,
      queue: null,
    },
  ],
};

describe("BatchProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderWithView(): Promise<void> {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => VIEW }),
    );
    render(<BatchProgress batchId="batch-1" />);
    await screen.findByText(/1 queued, 0 duplicate, 1 invalid, 0 blocked/);
  }

  it("renders per-line outcomes with queue links", async () => {
    await renderWithView();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("(1/3)")).toBeInTheDocument();
    const details = screen.getByRole("link", { name: "details" });
    expect(details.getAttribute("href")).toBe("/attempts/work-1");
    expect(screen.getByText("Invalid")).toBeInTheDocument();
  });

  it("polls on an interval and on manual refresh", async () => {
    // Mounted under fake timers from the start (the interval binds at
    // mount); vi.waitFor instead of RTL findBy because findBy needs
    // real timers.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => VIEW,
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<BatchProgress batchId="batch-1" />);
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: /refresh now/i }));
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces load failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "batch not found" }),
      }),
    );
    render(<BatchProgress batchId="missing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("batch not found");
  });
});
