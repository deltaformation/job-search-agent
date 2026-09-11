import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDetailView } from "../../../../src/server/board";
import CardDrawer from "../../../../components/board/CardDrawer";

function detailView(): JobDetailView {
  return {
    job: {
      id: "job-1",
      status: "TAILORED",
      rank: 0,
      rowVersion: 2,
      title: "Staff Engineer",
      company: "Gamma LLC",
      location: "Remote",
      arrangement: "REMOTE",
      salaryText: "$200k",
      salaryCurrency: null,
      salaryMinMinor: null,
      salaryMaxMinor: null,
      descriptionText: "Lead things.",
      postedAt: null,
      scrapeState: "SUCCEEDED",
      scrapeReasonCode: null,
      tailoringState: "PENDING",
      tailoringReasonCode: null,
      activeExtractionId: "ext-1",
      activeResumeVersionId: null,
      createdAt: "2026-09-11T10:00:00.000Z",
      updatedAt: "2026-09-11T11:00:00.000Z",
    },
    source: {
      submittedUrl: "https://example.com/jobs/1",
      canonicalUrl: "https://example.com/jobs/1",
      finalUrl: null,
      applyUrl: null,
      sourceIdentity: null,
    },
    attempts: [
      {
        id: "att-1",
        startedAt: "2026-09-11T10:00:00.000Z",
        finishedAt: "2026-09-11T10:00:05.000Z",
        outcome: "SUCCEEDED",
        reasonCode: null,
        errorDetail: null,
        workerId: "clip",
        adapter: "generic",
        createdAt: "2026-09-11T10:00:05.000Z",
      },
    ],
    artifacts: [
      { id: "art-1", attemptId: "att-1", kind: "HTML", mediaType: "text/html", byteSize: 99, sha256: "a" },
    ],
    extraction: {
      id: "ext-1",
      adapter: "generic",
      adapterVersion: null,
      confidence: 0.8,
      missingFields: ["postedAt"],
      contentHash: "b",
      fields: { title: "Staff Engineer" },
      provenance: { title: "generic:h1" },
    },
    resumes: [],
    notes: [{ id: "note-1", body: "<b>call back</b>", createdAt: "2026-09-11T11:00:00.000Z", updatedAt: "2026-09-11T11:00:00.000Z" }],
    application: null,
    history: [
      {
        id: "ev-1",
        actor: "human",
        fromStatus: "NEW",
        toStatus: "TAILORED",
        rank: 0,
        rowVersion: 2,
        reason: "approval",
        metadata: {
          schemaVersion: "workflow-event-metadata-v1",
          resumeVersionId: "00000000-0000-0000-0000-000000000001",
          reviewId: "00000000-0000-0000-0000-000000000002",
        },
        createdAt: "2026-09-11T10:30:00.000Z",
      },
    ],
    intake: { batchId: "batch-1", lineNumber: 1, rawInput: "https://example.com/jobs/1" },
  };
}

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe("CardDrawer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderDrawer() {
    const fetchMock = vi.fn().mockResolvedValue(okJson(detailView()));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      jobId: "job-1",
      refreshToken: 0,
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onCorrect: vi.fn(),
      onApplied: vi.fn(),
      onReject: vi.fn(),
    };
    const rendered = render(<CardDrawer {...props} />);
    return { fetchMock, props, container: rendered.container };
  }

  it("renders every section and escapes untrusted markup", async () => {
    const { container } = renderDrawer();
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText("Gamma LLC · Remote")).toBeInTheDocument();
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
    expect(screen.getByText(/postedAt/)).toBeInTheDocument();
    expect(screen.getByText(/html evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/NEW → TAILORED/)).toBeInTheDocument();
    const originals = screen.getAllByRole("link", { name: /open original/i });
    expect(originals).toHaveLength(2);
    expect(originals[0]).toHaveAttribute("href", "https://example.com/jobs/1");
    // The note body renders as text, never as markup.
    expect(screen.getByText("<b>call back</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("moves within the ordinary graph and opens dialogs for the rest", async () => {
    const { fetchMock, props } = renderDrawer();
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    // TAILORED offers APPLIED (modal) and REJECTED (dialog).
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "APPLIED" } });
    fireEvent.click(screen.getByRole("button", { name: /^move$/i }));
    expect(props.onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", rowVersion: 2 }),
      0,
    );
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "REJECTED" } });
    fireEvent.click(screen.getByRole("button", { name: /^move$/i }));
    expect(props.onReject).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /correct \/ reopen/i }));
    expect(props.onCorrect).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts direct moves and notes, then refreshes", async () => {
    const applied = { ...detailView(), job: { ...detailView().job, status: "APPLIED" as const } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(applied))
      .mockResolvedValueOnce(okJson({ ok: true, newRowVersion: 3 }))
      .mockResolvedValueOnce(okJson(applied))
      .mockResolvedValueOnce(okJson({ ok: true, noteId: "note-2" }))
      .mockResolvedValue(okJson(applied));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      jobId: "job-1",
      refreshToken: 0,
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onCorrect: vi.fn(),
      onApplied: vi.fn(),
      onReject: vi.fn(),
    };
    render(<CardDrawer {...props} />);
    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "INTERVIEWED" } });
    fireEvent.click(screen.getByRole("button", { name: /^move$/i }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/jobs/job-1/move");

    fireEvent.change(screen.getByLabelText("Add a note"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^add note$/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/jobs/job-1/notes");
  });
});
