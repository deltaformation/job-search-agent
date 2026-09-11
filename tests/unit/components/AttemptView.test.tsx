import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AttemptView from "../../../components/AttemptView";

function viewFor(state: string) {
  return {
    workItem: {
      id: "work-1",
      kind: "SCRAPE",
      state,
      attemptCount: 1,
      maxAttempts: 3,
      nextRunAt: null,
      updatedAt: "2026-09-11T12:00:00.000Z",
    },
    intakeItem: {
      id: "item-1",
      batchId: "batch-1",
      lineNumber: 1,
      rawInput: "https://example.com/jobs/1",
      outcome: "ENQUEUED",
      reasonCode: null,
      canonicalUrl: "https://example.com/jobs/1",
    },
    attempts: [
      {
        attemptNumber: 1,
        workerId: "worker-a",
        startedAt: "2026-09-11T12:00:00.000Z",
        finishedAt: "2026-09-11T12:00:05.000Z",
        result: state === "FAILED" ? "FAILED" : "SUCCEEDED",
        errorCode: state === "FAILED" ? "TIMEOUT" : null,
        errorDetail: state === "FAILED" ? "navigation failed" : null,
      },
    ],
    scrapeOutcome: state === "FAILED" ? "FAILED" : "SUCCEEDED",
    scrapeReasonCode: state === "FAILED" ? "TIMEOUT" : null,
    scrapeDetail: null,
    job:
      state === "FAILED"
        ? null
        : {
          id: "job-1",
          status: "NEW",
          scrapeState: "SUCCEEDED",
          scrapeReasonCode: null,
          title: "Engineer",
          company: "Acme",
          location: "Remote",
          arrangement: "REMOTE",
          salaryText: "$150,000",
          descriptionText: "Do things.",
          postedAt: null,
          submittedUrl: "https://example.com/jobs/1",
          finalUrl: "https://example.com/jobs/1",
          applyUrl: "https://example.com/jobs/1/apply",
          adapter: "generic",
          confidence: 0.7,
          missingFields: ["postedAt"],
        },
    artifacts: [
      { id: "art-1", kind: "HTML", mediaType: "text/html", byteSize: 42, sha256: "a".repeat(64) },
    ],
  };
}

describe("AttemptView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders failure detail with a working retry action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => viewFor("FAILED"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: "QUEUED" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...viewFor("QUEUED"), attempts: viewFor("FAILED").attempts }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<AttemptView workItemId="work-1" />);
    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/navigation failed/)).toBeInTheDocument();
    const viewLink = screen.getByRole("link", { name: "view" });
    expect(viewLink.getAttribute("href")).toBe("/api/evidence/art-1");
    fireEvent.click(screen.getByRole("button", { name: /retry this item/i }));
    expect(await screen.findByText(/requeued with a fresh attempt budget/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/attempts/work-1/retry");
  });

  it("shows extracted jobs and hides retry while queued", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => viewFor("SUCCEEDED"),
      }),
    );
    render(<AttemptView workItemId="work-1" />);
    expect(await screen.findByText("Engineer")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText(/missing: postedAt/)).toBeInTheDocument();
    const apply = screen.getByRole("link", { name: /apply manually/i });
    expect(apply.getAttribute("href")).toBe("https://example.com/jobs/1/apply");
    expect(apply.getAttribute("target")).toBe("_blank");
    expect(
      screen.queryByRole("button", { name: /retry this item/i }),
    ).not.toBeInTheDocument();
  });

  it("announces load failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "work item not found" }),
      }),
    );
    render(<AttemptView workItemId="missing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "work item not found",
    );
  });
});
