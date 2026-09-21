import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchPreparationCell from "../../../components/BatchPreparationCell";
import type { BatchItemView } from "../../../src/server/queries";

/**
 * WO-1.3-S2-C batch diagnostics (S2C5): per-line preparation
 * state/failure/retry with on-demand detail, Step 2 deep links,
 * and no fetch before the user acts.
 */

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const PREP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PLAN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-09-17T12:00:00.000Z";

function itemFixture(overrides: Partial<BatchItemView> = {}): BatchItemView {
  return {
    id: "item-1",
    lineNumber: 1,
    rawInput: "https://example.com/jobs/1",
    outcome: "ENQUEUED",
    reasonCode: null,
    canonicalUrl: "https://example.com/jobs/1",
    jobId: JOB_ID,
    queue: null,
    preparation: null,
    ...overrides,
  };
}

function prepBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "SUCCEEDED",
    preparationId: PREP_ID,
    acceptedPlanId: PLAN_ID,
    failureCode: null,
    retryAllowed: false,
    jobId: JOB_ID,
    ...overrides,
  };
}

function prepDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "step2-preparation-status/v1",
    preparationId: PREP_ID,
    jobId: JOB_ID,
    state: "SUCCEEDED",
    binding: null,
    extractionId: null,
    acceptedPlanId: PLAN_ID,
    acceptedPlanHash: "ab".repeat(32),
    attemptId: ATTEMPT_ID,
    startedAt: T0,
    finishedAt: T0,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    events: [
      { seq: 1, stage: "LOADING_INPUTS", source: "provider", recordedAt: T0 },
      { seq: 2, stage: "WAITING_FOR_PROVIDER", source: "provider", recordedAt: T0 },
    ],
    failure: null,
    retryAllowed: false,
    serverNow: T0,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

function createFetch(detail: Record<string, unknown>, retryStatus = 202) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string" && init.body !== "") {
      body = JSON.parse(init.body) as unknown;
    }
    calls.push({ method, url, body });
    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation`) {
      return jsonResponse(200, { ok: true, preparation: detail });
    }
    if (url === `/api/jobs/${JOB_ID}`) {
      return jsonResponse(200, { job: { rowVersion: 2 } });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation/retry`) {
      if (retryStatus !== 202) {
        return jsonResponse(retryStatus, {
          ok: false,
          error: { code: "RETRY_NOT_ALLOWED", message: "Retry is not allowed.", action: null },
        });
      }
      return jsonResponse(202, { ok: true, preparationId: PREP_ID, state: "QUEUED", replayed: false });
    }
    return jsonResponse(404, { ok: false, error: { code: "NOT_FOUND", message: "unexpected", action: null } });
  };
  return { fetch: fetchImpl, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S2C5: batch preparation cell", () => {
  it("shows succeeded state with a Step 2 link and fetches nothing on mount", async () => {
    const server = createFetch(prepDetail());
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
    render(<BatchPreparationCell item={itemFixture({ preparation: prepBlock() as BatchItemView["preparation"] })} onChanged={vi.fn()} />);

    expect(await screen.findByText("Plan ready")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Step 2/ });
    expect(link.getAttribute("href")).toBe(`/jobs/${JOB_ID}/tailor?step=2`);
    expect(server.calls).toEqual([]);
  });

  it("retries failed lines with the observed attempt and row version, then refreshes", async () => {
    const server = createFetch(
      prepDetail({ state: "FAILED", failure: { code: "RATE_LIMIT", stage: "WAITING_FOR_PROVIDER", occurredAt: T0, action: "wait", retryAfterSeconds: null, launchSubcode: null } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
    const onChanged = vi.fn();
    render(
      <BatchPreparationCell
        item={itemFixture({ preparation: prepBlock({ state: "FAILED", failureCode: "RATE_LIMIT", retryAllowed: true }) as BatchItemView["preparation"] })}
        onChanged={onChanged}
      />,
    );

    expect(await screen.findByText("RATE_LIMIT")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    const retry = server.calls.find((call) => call.url.endsWith("/preparation/retry"));
    expect(retry?.method).toBe("POST");
    expect(retry?.body).toMatchObject({
      schemaVersion: "step2-prepare-retry/v1",
      observedAttemptId: ATTEMPT_ID,
      observedRowVersion: 2,
    });
  });

  it("marks non-retryable failures honestly without a retry button", async () => {
    const server = createFetch(prepDetail({ state: "FAILED" }));
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
    render(
      <BatchPreparationCell
        item={itemFixture({ preparation: prepBlock({ state: "FAILED", failureCode: "INPUT_STALE", retryAllowed: false }) as BatchItemView["preparation"] })}
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText("INPUT_STALE")).toBeInTheDocument();
    expect(screen.getByText("cannot retry")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("loads stage detail on demand and toggles without refetching", async () => {
    const server = createFetch(
      prepDetail({
        state: "RUNNING",
        events: [
          { seq: 1, stage: "LOADING_INPUTS", source: "provider", recordedAt: T0 },
          { seq: 2, stage: "WAITING_FOR_PROVIDER", source: "cached", recordedAt: T0 },
        ],
      }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
    render(
      <BatchPreparationCell
        item={itemFixture({ preparation: prepBlock({ state: "RUNNING" }) as BatchItemView["preparation"] })}
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText("Preparing")).toBeInTheDocument();
    expect(server.calls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "details" }));
    expect(await screen.findByText("Loading inputs (live)")).toBeInTheDocument();
    expect(screen.getByText("Waiting for provider (recovered)")).toBeInTheDocument();
    expect(server.calls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(screen.queryByText("Loading inputs (live)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "details" }));
    expect(await screen.findByText("Loading inputs (live)")).toBeInTheDocument();
    expect(server.calls).toHaveLength(1);
  });

  it("covers unbound lines: job without preparation, and lines without jobs", async () => {
    const server = createFetch(prepDetail());
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
    const { unmount } = render(<BatchPreparationCell item={itemFixture({ preparation: null })} onChanged={vi.fn()} />);
    expect(await screen.findByText("Not prepared")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Step 2/ })).toBeInTheDocument();
    unmount();

    render(<BatchPreparationCell item={itemFixture({ jobId: null, preparation: null })} onChanged={vi.fn()} />);
    expect(await screen.findByText("—")).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it("surfaces retry refusals as status text without leaking internals", async () => {
    const server = createFetch(prepDetail({ state: "FAILED" }), 422);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
    render(
      <BatchPreparationCell
        item={itemFixture({ preparation: prepBlock({ state: "FAILED", failureCode: "RATE_LIMIT", retryAllowed: true }) as BatchItemView["preparation"] })}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Retry is not allowed.");
  });
});
