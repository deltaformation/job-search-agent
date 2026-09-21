import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Step3Progress, { elapsedSecondsFor } from "../../../components/tailoring/Step3Progress";
import {
  ProgressReply,
  type ProgressReply as ProgressReplyType,
  type TailoringFailure as TailoringFailureType,
} from "../../../src/domain/tailoringWorkspace";

/**
 * WO-1.3-F Step 3 acceptance (F1–F3, F5-UI, retry, diagnostics):
 * persisted-attempt elapsed time, navigation-safe clocks, frozen
 * completions, degraded polling, lease-aware liveness, typed safe
 * failures, and attempt-specific retry. The component only ever
 * issues GETs until the human presses Retry.
 */

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATTEMPT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ATTEMPT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-09-16T12:00:00.000Z";
const T0_PLUS_17 = "2026-09-16T12:00:17.000Z";
const SECONDS = 1000;

function replyFixture(overrides: Partial<ProgressReplyType> = {}): ProgressReplyType {
  return ProgressReply.parse({
    ok: true,
    requestId: REQUEST_ID,
    state: "RUNNING",
    serverNow: T0_PLUS_17,
    attemptId: ATTEMPT_A,
    startedAt: T0,
    finishedAt: null,
    leaseExpiresAt: "2026-09-16T12:05:00.000Z",
    lastHeartbeatAt: "2026-09-16T12:00:15.000Z",
    events: [
      {
        seq: 1,
        stage: "PREPARING_INPUTS",
        source: "provider",
        recordedAt: "2026-09-16T12:00:01.000Z",
      },
      {
        seq: 2,
        stage: "WAITING_FOR_PROVIDER",
        source: "provider",
        recordedAt: "2026-09-16T12:00:02.000Z",
      },
    ],
    failure: null,
    resumeVersionId: null,
    retryAllowed: false,
    ...overrides,
  });
}

function failureFixture(overrides: Partial<TailoringFailureType> = {}): TailoringFailureType {
  return {
    code: "NETWORK",
    stage: "WAITING_FOR_PROVIDER",
    occurredAt: "2026-09-16T12:00:09.000Z",
    action: "retry",
    retryAfterSeconds: null,
    launchSubcode: null,
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

type ScriptedResponse =
  | { status: number; json: unknown }
  | { throws: Error };

function createFetchScript(responses: ScriptedResponse[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl = async (url: unknown, init?: { method?: string; body?: string }) => {
    const next = queue.length > 0 ? (queue.shift() as ScriptedResponse) : responses[responses.length - 1];
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? null : (JSON.parse(init.body) as unknown),
    });
    if (next === undefined) {
      throw new Error("fetch script exhausted");
    }
    if ("throws" in next) {
      throw next.throws;
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json,
    };
  };
  return { calls, fetchImpl };
}

let nowPerf = 1000;
let visibility: "visible" | "hidden" = "visible";

function renderStep3() {
  const onNavigateStep = vi.fn();
  const utils = render(
    <Step3Progress jobId={JOB_ID} requestId={REQUEST_ID} onNavigateStep={onNavigateStep} />,
  );
  return { onNavigateStep, ...utils };
}

async function settleTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function setVisibility(state: "visible" | "hidden"): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  nowPerf = 1000;
  visibility = "visible";
  vi.spyOn(performance, "now").mockImplementation(() => nowPerf);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("F1/F2: attempt clock and navigation safety", () => {
  it("shows 17s elapsed from the persisted attempt start", async () => {
    const script = createFetchScript([{ status: 200, json: replyFixture() }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("17s elapsed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for AI response" })).toBeInTheDocument();
    rendered.unmount();
  });

  it("catches up across hidden tabs and remounts without accumulating ticks", async () => {
    // The server clock advances between polls, as in production.
    const script = createFetchScript([
      { status: 200, json: replyFixture() },
      { status: 200, json: replyFixture({ serverNow: "2026-09-16T12:00:22.000Z" }) },
      { status: 200, json: replyFixture({ serverNow: "2026-09-16T12:00:22.000Z" }) },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const first = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("17s elapsed")).toBeInTheDocument();

    // Five throttled seconds hidden, then visible again: the clock
    // resyncs from the server instead of counting missed ticks.
    await act(async () => {
      setVisibility("hidden");
    });
    nowPerf += 5 * SECONDS;
    await settleTimers(5000);
    await act(async () => {
      setVisibility("visible");
    });
    await flush();
    await settleTimers(600);
    expect(screen.getByText("22s elapsed")).toBeInTheDocument();
    first.unmount();

    // Remount starts from the same persisted timestamps, not zero.
    const second = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("22s elapsed")).toBeInTheDocument();
    second.unmount();

    // Reads only: every request in the whole scenario is a GET.
    expect(script.calls.length).toBeGreaterThan(0);
    for (const call of script.calls) {
      expect(call.method).toBe("GET");
      expect(call.url).toContain(`/api/jobs/${JOB_ID}/tailoring/generations/${REQUEST_ID}`);
    }
  });
});

describe("F3: attempt boundaries and frozen completion", () => {
  it("resets the clock when a new attempt starts", async () => {
    const first = replyFixture();
    const second = replyFixture({
      attemptId: ATTEMPT_B,
      startedAt: "2026-09-16T12:10:00.000Z",
      serverNow: "2026-09-16T12:10:04.000Z",
      events: [
        {
          seq: 1,
          stage: "PREPARING_INPUTS",
          source: "provider",
          recordedAt: "2026-09-16T12:10:01.000Z",
        },
      ],
    });
    const script = createFetchScript([
      { status: 200, json: first },
      { status: 200, json: second },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("17s elapsed")).toBeInTheDocument();
    nowPerf += 2000;
    await settleTimers(2000);
    await flush();
    expect(screen.getByText("4s elapsed")).toBeInTheDocument();
    rendered.unmount();
  });

  it("freezes the duration when finishedAt arrives and stops polling", async () => {
    const finished = replyFixture({
      state: "SUCCEEDED",
      serverNow: "2026-09-16T12:00:42.000Z",
      finishedAt: "2026-09-16T12:00:40.000Z",
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      resumeVersionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      events: [
        {
          seq: 5,
          stage: "PUBLISHING_RESULT",
          source: "provider",
          recordedAt: "2026-09-16T12:00:40.000Z",
        },
      ],
    });
    const script = createFetchScript([{ status: 200, json: finished }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("Resume ready for review")).toBeInTheDocument();
    expect(screen.getByText(/Generation finished in 40s\./)).toBeInTheDocument();
    const polls = script.calls.length;
    nowPerf += 10000;
    await settleTimers(10000);
    await flush();
    expect(screen.getByText(/Generation finished in 40s\./)).toBeInTheDocument();
    expect(script.calls.length).toBe(polls);
    rendered.unmount();
  });

  it("shows no numeric duration for invalid, future, or missing starts", () => {
    expect(
      elapsedSecondsFor({ startedAt: "not-a-date", finishedAt: null, estimatedServerNowMs: 1000 }),
    ).toBeNull();
    expect(
      elapsedSecondsFor({ startedAt: null, finishedAt: null, estimatedServerNowMs: 1000 }),
    ).toBeNull();
    expect(
      elapsedSecondsFor({
        startedAt: "2026-09-16T12:01:00.000Z",
        finishedAt: null,
        estimatedServerNowMs: Date.parse(T0),
      }),
    ).toBeNull();
    expect(
      elapsedSecondsFor({
        startedAt: "not-a-date",
        finishedAt: "2026-09-16T12:00:40.000Z",
        estimatedServerNowMs: Date.parse(T0),
      }),
    ).toBeNull();
    expect(
      elapsedSecondsFor({
        startedAt: T0,
        finishedAt: "2026-09-16T12:00:40.000Z",
        estimatedServerNowMs: Date.parse(T0) + 999_000,
      }),
    ).toBe(40);
  });

  it("renders 'in progress' without digits for a future start", async () => {
    const script = createFetchScript([
      { status: 200, json: replyFixture({ startedAt: "2026-09-16T12:01:00.000Z" }) },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.queryByText(/\d+s elapsed/)).not.toBeInTheDocument();
    rendered.unmount();
  });

  it("treats a malformed reply as a failed poll, never a failure panel", async () => {
    const script = createFetchScript([
      { status: 200, json: { ok: true, state: "RUNNING", startedAt: "not-a-date" } },
      { status: 200, json: { ok: true, state: "RUNNING", startedAt: "not-a-date" } },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    // First malformed poll: still loading, no numeric, no crash.
    expect(screen.getByText("Loading generation status…")).toBeInTheDocument();
    expect(screen.queryByText(/\d+s elapsed/)).not.toBeInTheDocument();
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();
    nowPerf += 2000;
    await settleTimers(2000);
    await flush();
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();
    rendered.unmount();
  });
});

describe("F5: degraded polling and lease-aware liveness", () => {
  it("keeps the last stage and reports unavailable after two failed polls", async () => {
    const script = createFetchScript([
      { status: 200, json: replyFixture() },
      { throws: new Error("network down") },
      { throws: new Error("network down") },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByRole("heading", { name: "Waiting for AI response" })).toBeInTheDocument();
    nowPerf += 2000;
    await settleTimers(2000);
    await flush();
    nowPerf += 2000;
    await settleTimers(2000);
    await flush();
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for AI response" })).toBeInTheDocument();
    rendered.unmount();
  });

  it("reports recovery-pending when the server passes the lease expiry", async () => {
    const expired = replyFixture({
      serverNow: "2026-09-16T12:05:01.000Z",
      leaseExpiresAt: "2026-09-16T12:05:00.000Z",
    });
    const script = createFetchScript([{ status: 200, json: expired }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("Waiting for worker recovery")).toBeInTheDocument();
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();
    rendered.unmount();
  });

  it("notes a long stage 2 without failing the run", async () => {
    const slow = replyFixture({
      serverNow: "2026-09-16T12:00:45.000Z",
      leaseExpiresAt: "2026-09-16T12:05:00.000Z",
    });
    const script = createFetchScript([{ status: 200, json: slow }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText(/Waiting for the AI response/)).toBeInTheDocument();
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();
    rendered.unmount();
  });

  it("labels a cached stage 2 as loading the saved proposal", async () => {
    const cached = replyFixture({
      events: [
        {
          seq: 1,
          stage: "PREPARING_INPUTS",
          source: "cached",
          recordedAt: "2026-09-16T12:00:01.000Z",
        },
        {
          seq: 2,
          stage: "WAITING_FOR_PROVIDER",
          source: "cached",
          recordedAt: "2026-09-16T12:00:02.000Z",
        },
      ],
    });
    const script = createFetchScript([{ status: 200, json: cached }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(
      screen.getByText("Loading the saved proposal from the previous attempt."),
    ).toBeInTheDocument();
    rendered.unmount();
  });
});

describe("F7/F8: failure actions, retry, and diagnostics", () => {
  it("retries with the observed attempt and resets onto the new run", async () => {
    const failed = replyFixture({
      state: "FAILED",
      serverNow: "2026-09-16T12:00:20.000Z",
      finishedAt: "2026-09-16T12:00:19.000Z",
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      failure: failureFixture(),
      retryAllowed: true,
    });
    const running = replyFixture({
      attemptId: ATTEMPT_B,
      startedAt: "2026-09-16T12:05:00.000Z",
      serverNow: "2026-09-16T12:05:03.000Z",
      events: [
        {
          seq: 1,
          stage: "PREPARING_INPUTS",
          source: "provider",
          recordedAt: "2026-09-16T12:05:01.000Z",
        },
      ],
    });
    const script = createFetchScript([
      { status: 200, json: failed },
      { status: 200, json: { ok: true, job: { rowVersion: 7 } } },
      {
        status: 202,
        json: {
          ok: true,
          requestId: REQUEST_ID,
          workItemId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          status: "QUEUED",
          replayed: false,
          jobRowVersion: 8,
          workspaceRevision: 2,
        },
      },
      { status: 200, json: running },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
    await flush();
    await settleTimers(600);
    await flush();
    const posts = script.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain(`/generations/${REQUEST_ID}/retry`);
    expect(posts[0]?.body).toEqual({
      schemaVersion: "tailoring-retry/v1",
      observedAttemptId: ATTEMPT_A,
      observedRowVersion: 7,
    });
    expect(screen.getByText("3s elapsed")).toBeInTheDocument();
    rendered.unmount();
  });

  it("opens real settings for launch failures with allowlisted diagnostics", async () => {
    const failed = replyFixture({
      state: "FAILED",
      finishedAt: "2026-09-16T12:00:19.000Z",
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      failure: failureFixture({
        code: "LOCAL_LAUNCH",
        action: "open_settings",
        launchSubcode: "ENOENT",
      }),
      retryAllowed: true,
    });
    const script = createFetchScript([{ status: 200, json: failed }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const opened: Array<{ tab: string }> = [];
    const listener = (event: Event) => {
      opened.push((event as CustomEvent<{ tab: string }>).detail);
    };
    window.addEventListener("job-tracker:open-settings", listener);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const rendered = renderStep3();
    try {
      await flush();
      await settleTimers(600);
      expect(
        screen.getByText("The app couldn't start the AI connection process."),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
      expect(opened).toEqual([{ tab: "ai" }]);
      fireEvent.click(screen.getByRole("button", { name: "Error details" }));
      const details = screen.getByText(/code: LOCAL_LAUNCH/);
      expect(details.textContent).toBe(
        [
          "code: LOCAL_LAUNCH",
          "stage: WAITING_FOR_PROVIDER",
          "occurred at: 2026-09-16T12:00:09.000Z",
          `request: ${REQUEST_ID}`,
          `attempt: ${ATTEMPT_A}`,
          "launch: ENOENT",
        ].join("\n"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
      await flush();
      expect(writeText).toHaveBeenCalledWith(details.textContent);
    } finally {
      window.removeEventListener("job-tracker:open-settings", listener);
      rendered.unmount();
    }
  });

  it("routes profile failures to the profile and focus failures back to Step 2", async () => {
    const failed = replyFixture({
      state: "FAILED",
      finishedAt: "2026-09-16T12:00:19.000Z",
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      failure: failureFixture({ code: "PROFILE_UNAVAILABLE", action: "edit_profile" }),
      retryAllowed: false,
    });
    const script = createFetchScript([{ status: 200, json: failed }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    const section = screen.getByLabelText("Generation status");
    expect(
      within(section).getByRole("link", { name: "Open candidate profile" }),
    ).toHaveAttribute("href", "/master-resume");
    expect(screen.queryByRole("button", { name: "Retry generation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to focus" }));
    expect(rendered.onNavigateStep).toHaveBeenCalledWith(2);
    rendered.unmount();
  });

  it("surfaces retry rejections and reconciles by repolling", async () => {
    const retryable = replyFixture({
      state: "FAILED",
      finishedAt: "2026-09-16T12:00:19.000Z",
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      failure: failureFixture(),
      retryAllowed: true,
    });
    const script = createFetchScript([
      { status: 200, json: retryable },
      { status: 200, json: { ok: true, job: { rowVersion: 7 } } },
      {
        status: 409,
        json: { error: { code: "GENERATION_BUSY", message: "Another run is live." } },
      },
      { status: 200, json: retryable },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(script.fetchImpl as typeof fetch);
    const rendered = renderStep3();
    await flush();
    await settleTimers(600);
    fireEvent.click(screen.getByRole("button", { name: "Retry generation" }));
    await flush();
    await settleTimers(600);
    await flush();
    expect(screen.getByText("Another run is live.")).toBeInTheDocument();
    rendered.unmount();
  });
});
