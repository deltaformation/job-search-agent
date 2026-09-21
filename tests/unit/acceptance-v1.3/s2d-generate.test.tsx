import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Step2Focus from "../../../components/tailoring/Step2Focus";
import {
  readPendingGeneration,
  writePendingGeneration,
} from "../../../components/tailoring/focusDraft";

/**
 * WO-1.3-S2-D Generate acceptance (S2D4 UI): explicit submission
 * flushes, validates, and POSTs the frozen bytes; blocked drafts
 * name their segments without POSTing; certain failures surface
 * with recovery affordances; network loss keeps byte-identical
 * replay bytes across reload. A fake fetch server records calls.
 */

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXTRACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROFILE_ID = "pm";
const PROFILE_VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLAN_HASH = "ab".repeat(32);
const PREP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BATCH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ADD_OP = "11111111-1111-4111-8111-111111111111";
const T0 = "2026-09-17T12:00:00.000Z";

function profilePayloadFixture(): Record<string, unknown> {
  return {
    identity: { fullName: "Ada Lovelace" },
    targetTitles: [],
    targetLocations: [],
    summary: "Master summary from Harbor.",
    employment: [
      { id: "emp-harbor", company: "Harbor Analytics", role: "Product Manager", startDate: "2022-01-01", isCurrent: true },
    ],
    achievements: [
      { factId: "pm-fact-discovery", employmentId: "emp-harbor", category: "delivery", text: "Led customer discovery across 40 interviews.", technologies: [], metrics: [], verification: "APPROVED" },
      { factId: "pm-fact-pricing", employmentId: "emp-harbor", category: "delivery", text: "Shipped pricing experiments lifting conversion.", technologies: [], metrics: [], verification: "APPROVED" },
    ],
    skills: [],
    education: [],
    credentials: [],
  };
}

function planFixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-plan/v1",
    planId: PLAN_ID,
    preparationId: PREP_ID,
    extractionId: EXTRACTION_ID,
    jdHash: "a".repeat(64),
    profileVersionId: PROFILE_VERSION_ID,
    evidenceHash: "b".repeat(64),
    masterProjectionHash: "c".repeat(64),
    priorities: [
      { priorityId: "c1".repeat(32), quote: { text: "customer discovery", startByte: 10, endByte: 28 }, count: 3, category: "Research", importance: "required", support: "supported", factIds: ["pm-fact-discovery"] },
    ],
    featuredPriorityIds: ["c1".repeat(32)],
    positioning: {
      keepMasterSummary: "Master summary from Harbor.",
      angles: [
        { angleId: "angle-1", title: "Discovery-led growth", summaryText: "Discovery-led PM driving growth.", factIds: ["pm-fact-discovery"] },
      ],
    },
    suggestions: [
      { suggestionId: "sug-001", roleId: "emp-harbor", text: "Ran 40 discovery interviews shaping the roadmap.", factIds: ["pm-fact-discovery"], usable: true, unusableReason: null },
    ],
    rationale: "Fixture plan.",
  };
}

function draftFixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-draft/v1",
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    summaryText: "Master summary from Harbor.",
    summarySource: "master",
    operations: [
      { op: "add", operationId: ADD_OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
    ],
  };
}

function workspaceFixture(revision: number): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    revision,
    draft: {
      schemaVersion: "tailoring-workspace/v2",
      extractionId: EXTRACTION_ID,
      profileId: PROFILE_ID,
      profileVersionId: PROFILE_VERSION_ID,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      recommendationHash: null,
      draft: draftFixture(),
    },
    recommendations: null,
    lastRequestId: null,
    lastSubmittedRevision: null,
    updatedAt: T0,
  };
}

interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { ok: false, error: { code, message, action: null, ...extra } };
}

type ValidateMode = "ok" | "blocked" | "budget";

interface FakeOptions {
  prepState?: string;
  validateMode?: ValidateMode;
  denseMaster?: boolean;
  generations?: { status: number; body: unknown } | { throw: unknown } | null;
}

function createFakeServer(options: FakeOptions = {}) {
  const calls: FetchCall[] = [];
  let serverRevision = 1;
  const validateMode = options.validateMode ?? "ok";
  let generations = options.generations ?? null;
  let failNextPut: { status: number; body: unknown } | null = null;

  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = null;
    if (typeof init?.body === "string" && init.body !== "") {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation` && method === "GET") {
      const state = options.prepState ?? "SUCCEEDED";
      return jsonResponse(200, {
        ok: true,
        preparation: {
          schemaVersion: "step2-preparation-status/v1",
          preparationId: state === "ABSENT" ? null : PREP_ID,
          jobId: JOB_ID,
          state,
          binding: state === "ABSENT" ? null : { profileId: PROFILE_ID, profileVersionId: PROFILE_VERSION_ID, batchId: BATCH_ID },
          extractionId: state === "ABSENT" ? null : EXTRACTION_ID,
          acceptedPlanId: state === "SUCCEEDED" ? PLAN_ID : null,
          acceptedPlanHash: state === "SUCCEEDED" ? PLAN_HASH : null,
          attemptId: null,
          startedAt: null,
          finishedAt: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          events: [],
          failure: null,
          retryAllowed: false,
          serverNow: T0,
        },
      });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/workspace` && method === "GET") {
      return jsonResponse(200, { ok: true, workspace: workspaceFixture(serverRevision) });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/workspace` && method === "PUT") {
      if (failNextPut !== null) {
        const failed = failNextPut;
        failNextPut = null;
        return jsonResponse(failed.status, failed.body);
      }
      const match = /^"tw:[^"]+:(\d+)"$/.exec(headers["If-Match"] ?? "");
      if (match === null || Number(match[1]) !== serverRevision) {
        return jsonResponse(
          412,
          errorBody("WORKSPACE_CONFLICT", "revision moved", { currentWorkspaceRevision: serverRevision }),
        );
      }
      serverRevision += 1;
      return jsonResponse(200, { ok: true, workspace: workspaceFixture(serverRevision) });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/plan` && method === "GET") {
      if ((options.prepState ?? "SUCCEEDED") !== "SUCCEEDED") {
        return jsonResponse(404, errorBody("NOT_FOUND", "no accepted plan"));
      }
      return jsonResponse(200, { ok: true, plan: planFixture(), planHash: PLAN_HASH, validatedAt: T0, supersedesPlanId: null });
    }
    if (url === `/api/settings/profiles/${PROFILE_ID}/versions/${PROFILE_VERSION_ID}` && method === "GET") {
      const payload = profilePayloadFixture();
      if (options.denseMaster === true) {
        // 5 Harbor master bullets + the saved add = 6 projected
        // bullets: over the 3/role guidance, under none of the
        // genuine blockers.
        (payload["achievements"] as Array<Record<string, unknown>>).push(
          { factId: "pm-fact-cadence", employmentId: "emp-harbor", category: "delivery", text: "Ran the weekly planning cadence.", technologies: [], metrics: [], verification: "APPROVED" },
          { factId: "pm-fact-roadmap", employmentId: "emp-harbor", category: "delivery", text: "Owned the quarterly roadmap.", technologies: [], metrics: [], verification: "APPROVED" },
          { factId: "pm-fact-gtm", employmentId: "emp-harbor", category: "delivery", text: "Led go-to-market launches.", technologies: [], metrics: [], verification: "APPROVED" },
        );
      }
      return jsonResponse(200, {
        profile: { id: PROFILE_ID, name: "pm", displayName: "Product Manager", isDefault: true },
        version: { id: PROFILE_VERSION_ID, version: 3 },
        payload,
      });
    }
    if (url === "/api/settings/profiles" && method === "GET") {
      return jsonResponse(200, { profiles: [{ id: PROFILE_ID, displayName: "Product Manager", isDefault: true }] });
    }
    if (url === `/api/jobs/${JOB_ID}` && method === "GET") {
      return jsonResponse(200, { job: { rowVersion: 2 } });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/draft/validate` && method === "POST") {
      const blocked = validateMode === "blocked";
      return jsonResponse(200, {
        ok: true,
        validationId: "99999999-9999-4999-8999-999999999999",
        validation: {
          schemaVersion: "step2-validation/v1",
          policyVersion: "step2-claims/1",
          planId: PLAN_ID,
          planHash: PLAN_HASH,
          draftHash: "c".repeat(64),
          segments: [
            {
              segmentId: "summary",
              kind: "summary",
              roleId: null,
              textHash: "a".repeat(64),
              normalizedHash: "b".repeat(64),
              verdict: "supported",
              factIds: ["pm-fact-discovery"],
              match: "exact-plan",
              reason: null,
            },
            {
              segmentId: `op:${ADD_OP}`,
              kind: "bullet",
              roleId: "emp-harbor",
              textHash: "a".repeat(64),
              normalizedHash: "b".repeat(64),
              verdict: blocked ? "needs-evidence" : "supported",
              factIds: blocked ? ["pm-fact-discovery"] : ["pm-fact-discovery"],
              match: blocked ? "none" : "exact-fact",
              reason: blocked ? "REWORDED" : null,
            },
          ],
          budget:
            validateMode === "budget"
              ? { summaryChars: 10, perRoleCounts: [{ roleId: "emp-harbor", bullets: 5 }], totalBullets: 5, exceeded: true }
              : { summaryChars: 10, perRoleCounts: [{ roleId: "emp-harbor", bullets: 2 }], totalBullets: 2, exceeded: false },
          validatedAt: T0,
        },
      });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/generations` && method === "POST") {
      if (generations !== null && "throw" in generations) {
        throw generations.throw;
      }
      if (generations !== null) {
        return jsonResponse(generations.status, generations.body);
      }
      return jsonResponse(202, {
        schemaVersion: "tailoring-generation/v1",
        requestId: (body as Record<string, unknown>)["requestId"],
        status: "QUEUED",
        replayed: false,
        workItemId: "work-1",
        jobRowVersion: 3,
        workspaceRevision: 3,
      });
    }
    return jsonResponse(404, errorBody("NOT_FOUND", `unexpected ${method} ${url}`));
  };

  return {
    fetch: fetchImpl,
    calls,
    posts: (suffix: string) => calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix)),
    puts: () => calls.filter((call) => call.method === "PUT"),
    failNextPutOnce(status: number, body: unknown) {
      failNextPut = { status, body };
    },
    setGenerations(next: { status: number; body: unknown } | { throw: unknown } | null) {
      generations = next;
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

function renderStep2(server: FakeServer, props: Record<string, unknown> = {}) {
  const onNavigateStep = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch as typeof fetch);
  const utils = render(
    <Step2Focus
      jobId={JOB_ID}
      activeExtractionId={EXTRACTION_ID}
      initialJobRowVersion={2}
      initialWorkspace={null}
      canGenerate
      onNavigateStep={onNavigateStep}
      {...(props as Record<string, never>)}
    />,
  );
  return { onNavigateStep, ...utils };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

function stubLocation(): { assign: ReturnType<typeof vi.fn> } {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    href: `http://127.0.0.1:3000/jobs/${JOB_ID}/tailor?step=2`,
    assign,
  });
  return { assign };
}

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("S2D Generate", () => {
  it("flushes, validates, and submits the frozen bytes, then follows Step 3", async () => {
    const server = createFakeServer();
    const { assign } = stubLocation();
    const { onNavigateStep } = renderStep2(server);
    await settle();

    // Dirty the summary, then generate before autosave fires: the
    // click must flush the edit itself.
    fireEvent.change(screen.getByLabelText(/Summary \(/), {
      target: { value: "Master summary from Harbor, tightened." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    expect(server.puts()).toHaveLength(1);
    expect(server.posts("/tailoring/draft/validate").length).toBeGreaterThan(0);
    const posts = server.posts("/tailoring/generations");
    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as Record<string, unknown>;
    expect(body["schemaVersion"]).toBe("tailoring-submit/v1");
    expect(typeof body["requestId"]).toBe("string");
    expect(body["workspaceRevision"]).toBe(2);
    expect(body["observedRowVersion"]).toBe(2);
    expect(readPendingGeneration(JOB_ID)).toBeNull();
    expect(onNavigateStep).toHaveBeenCalledWith(3);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toContain("step=3");
  });

  it("blocks unresolved drafts without POSTing and names the segments", async () => {
    const server = createFakeServer({ validateMode: "blocked" });
    renderStep2(server);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    expect(server.posts("/tailoring/generations")).toHaveLength(0);
    expect(screen.getByText(new RegExp(`Resolve 1 unsupported segment first: op:${ADD_OP}`))).toBeInTheDocument();
    expect(screen.getByText(/REWORDED/)).toBeInTheDocument();
  });

  it("submits over-guidance drafts and shows the Resume length notice", async () => {
    const server = createFakeServer({ validateMode: "budget", denseMaster: true });
    renderStep2(server);
    await settle();

    // Advisory notice is visible before submission: the total
    // plus the dense role, in warning styling — never an
    // "over budget" error.
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Resume length:");
    expect(notice).toHaveTextContent(
      /This draft has 6 bullets and may produce a resume longer than two pages\./,
    );
    expect(notice).toHaveTextContent(
      /You can generate it as is, or remove a few bullets for a more concise resume\./,
    );
    expect(notice).toHaveTextContent(
      /Harbor Analytics — Product Manager has 6 bullets\. Consider keeping the 3–4 most relevant to this job\./,
    );
    expect(screen.getByText(/above the 3 guideline/)).toBeInTheDocument();
    expect(screen.queryByText(/over budget/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^generate resume$/i })).toBeEnabled();

    // The server's advisory exceeded:true does not stop submission.
    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    expect(server.posts("/tailoring/generations")).toHaveLength(1);
    expect(screen.queryByText(/over budget/)).not.toBeInTheDocument();
  });

  it("maps a 409 PLAN_STALE to the rebind banner", async () => {
    const server = createFakeServer({
      generations: { status: 409, body: errorBody("PLAN_STALE", "a newer plan was accepted; rebind the draft before submitting") },
    });
    const { onNavigateStep } = renderStep2(server);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    expect(server.posts("/tailoring/generations")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Rebind to the new plan and save/ })).toBeInTheDocument();
    expect(onNavigateStep).not.toHaveBeenCalled();
  });

  it("keeps byte-identical replay bytes across network loss, then replays", async () => {
    const server = createFakeServer({ generations: { throw: new TypeError("network down") } });
    const { assign } = stubLocation();
    const { onNavigateStep } = renderStep2(server);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    expect(server.posts("/tailoring/generations")).toHaveLength(1);
    expect(screen.getByText(/may not have reached the server/)).toBeInTheDocument();
    const pending = readPendingGeneration(JOB_ID);
    expect(pending).not.toBeNull();
    expect(onNavigateStep).not.toHaveBeenCalled();

    server.setGenerations(null);
    fireEvent.click(screen.getByRole("button", { name: /Replay same submission/ }));
    await settle();

    const posts = server.posts("/tailoring/generations");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(readPendingGeneration(JOB_ID)).toBeNull();
    expect(onNavigateStep).toHaveBeenCalledWith(3);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("discards an uncertain submission without navigating", async () => {
    const server = createFakeServer({ generations: { throw: new TypeError("network down") } });
    const { onNavigateStep } = renderStep2(server);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();
    expect(readPendingGeneration(JOB_ID)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    await settle();

    expect(readPendingGeneration(JOB_ID)).toBeNull();
    expect(screen.queryByRole("button", { name: /Replay same submission/ })).not.toBeInTheDocument();
    expect(onNavigateStep).not.toHaveBeenCalled();
  });

  it("resurfaces an uncertain submission after reload", async () => {
    writePendingGeneration(JOB_ID, {
      schemaVersion: "tailoring-submit/v1",
      requestId: "12345678-1234-4123-8123-123456789012",
      workspaceRevision: 2,
      observedRowVersion: 2,
    });
    const server = createFakeServer();
    renderStep2(server);
    await settle();

    expect(screen.getByRole("button", { name: /Replay same submission/ })).toBeInTheDocument();
    expect(screen.getByText(/12345678-1234-4123-8123-123456789012/)).toBeInTheDocument();
    expect(server.posts("/tailoring/generations")).toHaveLength(0);
  });

  it("disables Generate while a run is live or no plan is ready", async () => {
    const server = createFakeServer();
    const { unmount } = renderStep2(server, { canGenerate: false });
    await settle();
    const live = screen.getByRole("button", { name: /^generate resume$/i });
    expect(live).toBeDisabled();
    expect(live).toHaveAttribute("title", "Generation is unavailable while a run is live.");
    unmount();

    const absent = createFakeServer({ prepState: "ABSENT" });
    renderStep2(absent);
    await settle();
    const unplanned = screen.getByRole("button", { name: /^generate resume$/i });
    expect(unplanned).toBeDisabled();
    expect(unplanned).toHaveAttribute("title", "Prepare a plan first.");
  });

  it("a flush conflict stops submission before any POST", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settle();

    fireEvent.change(screen.getByLabelText(/Summary \(/), {
      target: { value: "Master summary from Harbor, tightened." },
    });
    server.failNextPutOnce(412, errorBody("WORKSPACE_CONFLICT", "revision moved", { currentWorkspaceRevision: 9 }));
    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    expect(server.posts("/tailoring/generations")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Reload saved draft/ })).toBeInTheDocument();
  });
});
