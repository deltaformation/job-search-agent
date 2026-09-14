import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardCardView } from "../../../../src/server/board";
import AppliedModal from "../../../../components/board/AppliedModal";
import CorrectDialog from "../../../../components/board/CorrectDialog";
import RejectDialog from "../../../../components/board/RejectDialog";

function card(): BoardCardView {
  return {
    id: "job-1",
    status: "TAILORED",
    rank: 1.5,
    rowVersion: 2,
    title: "Staff Engineer",
    company: null,
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
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
  };
}

describe("board dialogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates and submits the Applied modal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<AppliedModal card={card()} rank={3} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Applied at"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /record application/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter when you applied");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Applied at"), {
      target: { value: "2026-09-11T09:30" },
    });
    fireEvent.change(screen.getByLabelText(/confirmation number/i), {
      target: { value: "CONF-9" },
    });
    fireEvent.click(screen.getByRole("button", { name: /record application/i }));
    expect(await screen.findByRole("button", { name: /record application/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/jobs/job-1/move");
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({
      to: "APPLIED",
      rank: 3,
      observedRowVersion: 2,
      confirmationNumber: "CONF-9",
    });
    expect(new Date(sent.appliedAt).getTime()).not.toBeNaN();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("reports Applied failures without closing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: "conflict", reason: "stale" }),
      }),
    );
    const onClose = vi.fn();
    render(<AppliedModal card={card()} rank={0} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /record application/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("conflict");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("excludes the current status and TAILORED from corrections", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CorrectDialog
        card={{ ...card(), status: "APPLIED" }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const options = [...screen.getByLabelText("Move to").querySelectorAll("option")].map(
      (option) => option.value,
    );
    expect(options).toEqual(["NEW", "INTERVIEWED", "REJECTED"]);
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs a note");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "NEW" } });
    fireEvent.change(screen.getByLabelText(/note \(required\)/i), { target: { value: "oops" } });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/jobs/job-1/correct");
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({ to: "NEW", note: "oops", observedRowVersion: 2 });
  });

  it("requires the timestamp for corrections into APPLIED", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CorrectDialog card={{ ...card(), status: "NEW" }} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "APPLIED" } });
    fireEvent.change(screen.getByLabelText(/note \(required\)/i), { target: { value: "late entry" } });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("timestamp");
    fireEvent.change(screen.getByLabelText("Applied at"), {
      target: { value: "2026-09-10T08:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent.to).toBe("APPLIED");
    expect(new Date(sent.appliedAt).getTime()).not.toBeNaN();
  });

  it("requires a rejection reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RejectDialog card={card()} rank={0} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^reject card$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs a reason");
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), {
      target: { value: "onsite-only" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^reject card$/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({ to: "REJECTED", reason: "onsite-only" });
  });
});
