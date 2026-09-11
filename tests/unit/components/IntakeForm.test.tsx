import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import IntakeForm from "../../../components/IntakeForm";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function mockJsonOnce(value: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce({ ok, status, json: async () => value }),
  );
}

describe("IntakeForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pushMock.mockReset();
  });

  it("disables validation until a URL is pasted", () => {
    render(<IntakeForm />);
    const validate = screen.getByRole("button", { name: /validate/i });
    expect(validate).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/one per line/i), {
      target: { value: "https://example.com/jobs/1\n\n" },
    });
    expect(screen.getByText(/1 url \(at most 100\)/i)).toBeInTheDocument();
    expect(validate).toBeEnabled();
  });

  it("previews per-line validation and focuses the preview", async () => {
    render(<IntakeForm />);
    fireEvent.change(screen.getByLabelText(/one per line/i), {
      target: { value: "https://example.com/jobs/1\nnot a url" },
    });
    mockJsonOnce({
      results: [
        { lineNumber: 1, rawInput: "https://example.com/jobs/1", outcome: "ENQUEUED", reasonCode: null, detail: null },
        { lineNumber: 2, rawInput: "not a url", outcome: "INVALID", reasonCode: "INVALID_URL", detail: "unsupported scheme" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    expect(await screen.findByText("Validation preview")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText(/unsupported scheme/)).toBeInTheDocument();
    expect(document.activeElement?.textContent).toBe("Validation preview");
    expect(
      screen.getByRole("button", { name: /queue batch/i }),
    ).toBeInTheDocument();
  });

  it("queues the batch and navigates to its progress page", async () => {
    render(<IntakeForm />);
    fireEvent.change(screen.getByLabelText(/one per line/i), {
      target: { value: "https://example.com/jobs/1" },
    });
    mockJsonOnce({
      results: [
        { lineNumber: 1, rawInput: "https://example.com/jobs/1", outcome: "ENQUEUED", reasonCode: null, detail: null },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    await screen.findByText("Validation preview");
    mockJsonOnce({ batchId: "batch-1" });
    fireEvent.click(screen.getByRole("button", { name: /queue batch/i }));
    await screen.findByText("Validation preview");
    expect(pushMock).toHaveBeenCalledWith("/intake/batches/batch-1");
  });

  it("announces server errors", async () => {
    render(<IntakeForm />);
    fireEvent.change(screen.getByLabelText(/one per line/i), {
      target: { value: "https://example.com/jobs/1" },
    });
    mockJsonOnce({ error: "batch rejected", reason: "too many" }, false, 400);
    fireEvent.click(screen.getByRole("button", { name: /validate/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "batch rejected: too many",
    );
  });
});
