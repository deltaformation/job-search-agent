import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_SETTINGS_EVENT } from "../../../components/settings/profiles";
import Step2Focus from "../../../components/tailoring/Step2Focus";

/**
 * WO-1.3-S2-C editor acceptance (S2C1–S2C4): captured profile
 * text/preview/Settings edit, priorities/positioning/summary,
 * master-by-employer bullets with ordered ops, CAS autosave with
 * conflict recovery, and exact-text validation states. A fake
 * fetch server records every call; polling uses fake timers.
 */

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXTRACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROFILE_ID = "pm";
const PROFILE_VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLAN_HASH = "ab".repeat(32);
const PREP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BATCH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const T0 = "2026-09-17T12:00:00.000Z";

const P1 = "c1".repeat(32);
const P2 = "c2".repeat(32);
const P3 = "c3".repeat(32);
const P4 = "c4".repeat(32);

function profilePayloadFixture(): Record<string, unknown> {
  return {
    identity: { fullName: "Ada Lovelace" },
    targetTitles: [],
    targetLocations: [],
    summary: "Master summary from Harbor.",
    employment: [
      { id: "emp-harbor", company: "Harbor Analytics", role: "Product Manager", startDate: "2022-01-01", isCurrent: true },
      { id: "emp-lime", company: "Lime Logistics", role: "Associate PM", startDate: "2020-01-01", endDate: "2021-12-31", isCurrent: false },
    ],
    achievements: [
      { factId: "pm-fact-discovery", employmentId: "emp-harbor", category: "delivery", text: "Led customer discovery across 40 interviews.", technologies: [], metrics: [], verification: "APPROVED" },
      { factId: "pm-fact-pricing", employmentId: "emp-harbor", category: "delivery", text: "Shipped pricing experiments lifting conversion.", technologies: [], metrics: [], verification: "APPROVED" },
      { factId: "pm-fact-roadmap", employmentId: "emp-lime", category: "delivery", text: "Owned the Lime roadmap end to end.", technologies: [], metrics: [], verification: "APPROVED" },
      { factId: "pm-fact-side", category: "delivery", text: "Ran a weekend data newsletter.", technologies: [], metrics: [], verification: "APPROVED" },
      { factId: "pm-fact-draft", employmentId: "emp-harbor", category: "delivery", text: "Unapproved draft bullet.", technologies: [], metrics: [], verification: "PENDING" },
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
      { priorityId: P1, quote: { text: "customer discovery", startByte: 10, endByte: 28 }, count: 3, category: "Research", importance: "required", support: "supported", factIds: ["pm-fact-discovery"] },
      { priorityId: P2, quote: { text: "pricing strategy", startByte: 40, endByte: 56 }, count: 2, category: "Growth", importance: "preferred", support: "related", factIds: ["pm-fact-pricing"] },
      { priorityId: P3, quote: { text: "NetSuite ERP", startByte: 70, endByte: 82 }, count: 1, category: "Enterprise", importance: "required", support: "gap", factIds: [] },
      { priorityId: P4, quote: { text: "roadmap planning", startByte: 90, endByte: 106 }, count: 1, category: "Delivery", importance: "unspecified", support: "supported", factIds: ["pm-fact-roadmap"] },
    ],
    featuredPriorityIds: [P1, P2, P3],
    positioning: {
      keepMasterSummary: "Master summary from Harbor.",
      angles: [
        { angleId: "angle-1", title: "Discovery-led growth", summaryText: "Discovery-led PM driving growth.", factIds: ["pm-fact-discovery"] },
        { angleId: "angle-2", title: "Pricing operator", summaryText: "Pricing operator scaling revenue.", factIds: ["pm-fact-pricing"] },
      ],
    },
    suggestions: [
      { suggestionId: "sug-001", roleId: "emp-harbor", text: "Ran 40 discovery interviews shaping the roadmap.", factIds: ["pm-fact-discovery"], usable: true, unusableReason: null },
      { suggestionId: "sug-002", roleId: "emp-lime", text: "Piloted Lime lane analytics with carriers.", factIds: ["pm-fact-roadmap"], usable: true, unusableReason: null },
      { suggestionId: "sug-003", roleId: "emp-harbor", text: "Invented revenue numbers.", factIds: [], usable: false, unusableReason: "NO_EVIDENCE" },
    ],
    rationale: "Fixture plan.",
  };
}

function bindingFixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-intake-binding/v1",
    intakeItemId: "item-1",
    profileId: PROFILE_ID,
    profileVersionId: PROFILE_VERSION_ID,
    profilePayloadHash: "d".repeat(64),
    evidenceHash: "e".repeat(64),
    masterSourceId: null,
    capturedAt: T0,
    batchId: BATCH_ID,
  };
}

function prepFixture(
  state: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "step2-preparation-status/v1",
    preparationId: state === "ABSENT" ? null : PREP_ID,
    jobId: JOB_ID,
    state,
    binding: state === "ABSENT" ? null : bindingFixture(),
    extractionId: state === "ABSENT" ? null : EXTRACTION_ID,
    acceptedPlanId: state === "SUCCEEDED" ? PLAN_ID : null,
    acceptedPlanHash: state === "SUCCEEDED" ? PLAN_HASH : null,
    attemptId: state === "FAILED" ? ATTEMPT_ID : null,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    events: [],
    failure: null,
    retryAllowed: false,
    serverNow: T0,
    ...overrides,
  };
}

function v2WorkspaceFixture(revision: number, draft: Record<string, unknown> | null): Record<string, unknown> {
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
      draft,
    },
    recommendations: null,
    lastRequestId: null,
    lastSubmittedRevision: null,
    updatedAt: T0,
  };
}

function draftFixture(summaryText: string, operations: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: "step2-draft/v1",
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    summaryText,
    summarySource: "edited",
    operations,
  };
}

interface FetchCall {
  method: string;
  url: string;
  body: unknown;
  ifMatch: string | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { ok: false, error: { code, message, action: null, ...extra } };
}

interface FakeOptions {
  prepState?: string;
  prepOverrides?: Record<string, unknown>;
  workspace?: Record<string, unknown> | null;
  planMissing?: boolean;
}

function createFakeServer(options: FakeOptions = {}) {
  const calls: FetchCall[] = [];
  let prep: Record<string, unknown> = prepFixture(options.prepState ?? "SUCCEEDED", options.prepOverrides ?? {});
  let serverWorkspace: Record<string, unknown> | null = options.workspace ?? null;
  let serverRevision = (serverWorkspace?.["revision"] as number | undefined) ?? 0;
  let planMissing = options.planMissing ?? (options.prepState !== undefined && options.prepState !== "SUCCEEDED");
  let failNextPut: { status: number; body: unknown } | null = null;
  let validateDeferred: Array<() => void> = [];

  const segmentFor = (id: string, text: string): Record<string, unknown> => ({
    segmentId: id,
    kind: id === "summary" ? "summary" : "bullet",
    roleId: null,
    textHash: "a".repeat(64),
    normalizedHash: "b".repeat(64),
    verdict: text.includes("UNVERIFIED") ? "needs-evidence" : "supported",
    factIds: text.includes("UNVERIFIED") ? [] : ["pm-fact-discovery"],
    match: text.includes("UNVERIFIED") ? "none" : "exact-fact",
    reason: text.includes("UNVERIFIED") ? "No supporting evidence" : null,
  });

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
    calls.push({ method, url, body, ifMatch: headers["If-Match"] ?? null });

    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation` && method === "GET") {
      return jsonResponse(200, { ok: true, preparation: prep });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation` && method === "POST") {
      prep = prepFixture("QUEUED", { binding: bindingFixture(), extractionId: EXTRACTION_ID });
      return jsonResponse(202, { ok: true, preparationId: PREP_ID, state: "QUEUED", replayed: false });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation/retry` && method === "POST") {
      prep = prepFixture("QUEUED", { binding: bindingFixture(), extractionId: EXTRACTION_ID });
      return jsonResponse(202, { ok: true, preparationId: PREP_ID, state: "QUEUED", replayed: false });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/workspace` && method === "GET") {
      return jsonResponse(200, { ok: true, workspace: serverWorkspace });
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
      const put = body as { planId?: unknown; planHash?: unknown; draft?: unknown };
      serverRevision += 1;
      serverWorkspace = v2WorkspaceFixture(serverRevision, (put.draft ?? null) as Record<string, unknown> | null);
      return jsonResponse(serverRevision === 1 ? 201 : 200, { ok: true, workspace: serverWorkspace });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/plan` && method === "GET") {
      if (planMissing) {
        return jsonResponse(404, errorBody("NOT_FOUND", "no accepted plan"));
      }
      return jsonResponse(200, { ok: true, plan: planFixture(), planHash: PLAN_HASH, validatedAt: T0, supersedesPlanId: null });
    }
    if (url === `/api/settings/profiles/${PROFILE_ID}/versions/${PROFILE_VERSION_ID}` && method === "GET") {
      return jsonResponse(200, {
        profile: { id: PROFILE_ID, name: "pm", displayName: "Product Manager", isDefault: true },
        version: { id: PROFILE_VERSION_ID, version: 3 },
        payload: profilePayloadFixture(),
      });
    }
    if (url === "/api/settings/profiles" && method === "GET") {
      return jsonResponse(200, {
        profiles: [{ id: PROFILE_ID, displayName: "Product Manager", isDefault: true }],
      });
    }
    if (url === `/api/jobs/${JOB_ID}` && method === "GET") {
      return jsonResponse(200, { job: { rowVersion: 2 } });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/draft/validate` && method === "POST") {
      const request = body as { summaryText?: unknown; operations?: Array<Record<string, unknown>> };
      const segments = [segmentFor("summary", String(request.summaryText ?? ""))];
      for (const op of request.operations ?? []) {
        const text =
          op.op === "add" || op.op === "replace"
            ? String((op.editedText as string | null) ?? "")
            : op.op === "edit"
              ? String(op.text ?? "")
              : "";
        segments.push(segmentFor(`op:${String(op.operationId)}`, text));
      }
      const reply = jsonResponse(200, {
        ok: true,
        validationId: "99999999-9999-4999-8999-999999999999",
        validation: {
          schemaVersion: "step2-validation/v1",
          policyVersion: "step2-claims/1",
          planId: PLAN_ID,
          planHash: PLAN_HASH,
          draftHash: "c".repeat(64),
          segments,
          budget: { summaryChars: 10, perRoleCounts: [], totalBullets: 0, exceeded: false },
          validatedAt: T0,
        },
      });
      if (validateDeferred.length > 0 || server.deferValidate) {
        return new Promise<Response>((resolve) => {
          validateDeferred.push(() => resolve(reply));
        });
      }
      return reply;
    }
    return jsonResponse(404, errorBody("NOT_FOUND", `unexpected ${method} ${url}`));
  };

  const server = {
    fetch: fetchImpl,
    calls,
    deferValidate: false,
    puts: () => calls.filter((call) => call.method === "PUT"),
    posts: (suffix: string) => calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix)),
    failNextPutOnce(status: number, body: unknown) {
      failNextPut = { status, body };
    },
    setPrep(next: Record<string, unknown>) {
      prep = next;
    },
    setPlanMissing(missing: boolean) {
      planMissing = missing;
    },
    setWorkspace(next: Record<string, unknown> | null) {
      serverWorkspace = next;
      serverRevision = (next?.["revision"] as number | undefined) ?? 0;
    },
    resolveValidate() {
      const pending = validateDeferred;
      validateDeferred = [];
      for (const resolve of pending) {
        resolve();
      }
    },
    resolveOldestValidate() {
      const oldest = validateDeferred.shift();
      oldest?.();
    },
  };
  return server;
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

async function settleMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("S2C1: captured profile, preview, Settings edit, batch link", () => {
  it("shows name/version text with preview, Settings edit, and batch diagnostics link", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    expect(screen.getByText("Product Manager · v3")).toBeInTheDocument();
    const profileCard = screen.getByText("Captured profile").closest("div") as HTMLElement;
    expect(within(profileCard).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(profileCard).queryByRole("button", { name: /select profile/i })).not.toBeInTheDocument();

    const seen: Array<{ tab: string; profileId?: string }> = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent).detail as { tab: string; profileId?: string });
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, listener);
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
    expect(seen).toEqual([{ tab: "profile", profileId: PROFILE_ID }]);

    expect(
      screen.getByText(/Settings edits apply to future intake only/),
    ).toBeInTheDocument();

    const batchLink = screen.getByRole("link", { name: /Batch diagnostics/ });
    expect(batchLink.getAttribute("href")).toBe(`/intake/batches/${BATCH_ID}`);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await advance(100);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Ada Lovelace");
    expect(dialog).toHaveTextContent("Harbor Analytics");
  });

  it("mount performs GETs only; legacy jobs prepare explicitly", async () => {
    const server = createFakeServer({ prepState: "ABSENT" });
    renderStep2(server);
    await settleMount();

    expect(screen.getByText("Run preparation")).toBeInTheDocument();
    const mutations = server.calls.filter((call) => call.method !== "GET");
    expect(mutations).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Run preparation" }));
    await advance(100);

    const posts = server.posts("/tailoring/preparation");
    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as Record<string, unknown>;
    expect(body["schemaVersion"]).toBe("step2-prepare/v1");
    expect(body["profileId"]).toBe(PROFILE_ID);
    expect(body["observedRowVersion"]).toBe(2);
    expect(typeof body["operationId"]).toBe("string");
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("failed preparation links to batch diagnostics instead of inline retry", async () => {
    const server = createFakeServer({
      prepState: "FAILED",
      prepOverrides: {
        failure: {
          code: "RATE_LIMIT",
          stage: "WAITING_FOR_PROVIDER",
          occurredAt: T0,
          action: "wait",
          retryAfterSeconds: 30,
          launchSubcode: null,
        },
        retryAllowed: true,
      },
    });
    renderStep2(server);
    await settleMount();

    expect(screen.getByText(/Failed: RATE_LIMIT/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open batch diagnostics/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry preparation" })).not.toBeInTheDocument();
  });
});

describe("S2C2: priorities, positioning, editable summary", () => {
  it("shows featured phrases with badges; gaps have no actions; the rest disclose", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    expect(screen.getByText("customer discovery")).toBeInTheDocument();
    expect(screen.getByText("customer discovery").closest("li")).toHaveTextContent("Supported");
    expect(screen.getByText("pricing strategy").closest("li")).toHaveTextContent("Related experience");
    expect(screen.getByText("NetSuite ERP").closest("li")).toHaveTextContent("Gap");

    expect(screen.getByText(/description bytes 10–28/)).toBeInTheDocument();

    const gapItem = screen.getByText("NetSuite ERP").closest("li") as HTMLElement;
    expect(gapItem.querySelector("button")).toBeNull();

    expect(screen.getByText("All requirements (4)")).toBeInTheDocument();
    const hidden = screen.getByText("roadmap planning").closest("details") as HTMLDetailsElement;
    expect(hidden.open).toBe(false);
  });

  it("theme switches fill the summary; dirty switches confirm and cancel writes nothing", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    const angles = screen.getAllByRole("button", { name: "Use this angle" });
    fireEvent.click(angles[0] as HTMLElement);
    const summary = screen.getByLabelText(/Summary \(/) as HTMLTextAreaElement;
    expect(summary.value).toBe("Discovery-led PM driving growth.");

    fireEvent.change(summary, { target: { value: "Discovery-led PM driving growth, UNVERIFIED wings." } });
    fireEvent.click(screen.getByRole("button", { name: "Use master summary" }));
    expect(screen.getByText(/Replace your unsaved summary edits/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(summary.value).toBe("Discovery-led PM driving growth, UNVERIFIED wings.");
    await advance(800);
    // The dirty summary autosaves, but the cancelled theme switch adds no second write.
    const puts = server.puts();
    expect(puts.length).toBeGreaterThanOrEqual(1);
    const last = puts[puts.length - 1]?.body as { draft?: { summaryText?: unknown } };
    expect(last.draft?.summaryText).toBe("Discovery-led PM driving growth, UNVERIFIED wings.");

    // After the autosave the buffers are clean, so the theme applies directly.
    fireEvent.click(screen.getByRole("button", { name: "Use master summary" }));
    expect(screen.queryByRole("button", { name: "Replace my edits" })).not.toBeInTheDocument();
    expect((screen.getByLabelText(/Summary \(/) as HTMLTextAreaElement).value).toBe(
      "Master summary from Harbor.",
    );
  });
});

describe("S2C3: master bullets, suggestions, ordered operations", () => {
  it("groups master bullets by employer; Use adds once and repeated Use does not duplicate", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    expect(screen.getByRole("heading", { name: "Harbor Analytics — Product Manager" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lime Logistics — Associate PM" })).toBeInTheDocument();
    expect(screen.getByText("Led customer discovery across 40 interviews.")).toBeInTheDocument();
    expect(screen.queryByText("Unapproved draft bullet.")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Use" })[0] as HTMLElement);
    await advance(800);

    expect(screen.getByText("Added")).toBeInTheDocument();
    const puts = server.puts();
    expect(puts).toHaveLength(1);
    const draft = (puts[0]?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations).toHaveLength(1);
    expect(draft?.operations?.[0]).toMatchObject({ op: "add", suggestionId: "sug-001", roleId: "emp-harbor" });

    // The default-role Use is now an Added badge; adding elsewhere still works.
    expect(screen.getAllByRole("button", { name: "Use" })).toHaveLength(1);
  });

  it("Replace targets one bullet; X excludes; Undo removes the operation", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    fireEvent.click(screen.getAllByRole("button", { name: "Replace…" })[0] as HTMLElement);
    const targets = screen.getAllByRole("button", { name: "Replace this bullet" });
    fireEvent.click(targets[1] as HTMLElement);
    await advance(800);

    let draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations?.[0]).toMatchObject({
      op: "replace",
      targetFactId: "pm-fact-pricing",
      suggestionId: "sug-001",
      roleId: "emp-harbor",
    });
    expect(screen.getByText("Replaces pm-fact-pricing")).toBeInTheDocument();
    expect(screen.queryByText("Shipped pricing experiments lifting conversion.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Exclude Led customer discovery/ }));
    await advance(800);
    draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations).toHaveLength(2);
    expect(screen.getByText("Excluded")).toBeInTheDocument();
    // Excluded master text stays visible (struck), never erased.
    expect(screen.getByText("Led customer discovery across 40 interviews.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Undo exclusion of/ }));
    await advance(800);
    draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations).toHaveLength(1);
    expect(screen.queryByText("Excluded")).not.toBeInTheDocument();
  });

  it("keyboard move and role change persist the same ordered operations as drops", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    // Keyboard path: add sug-002 to Harbor through the role chooser.
    const choosers = screen.getAllByLabelText("Add to role");
    fireEvent.change(choosers[1] as HTMLElement, { target: { value: "emp-harbor" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[1] as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "Use" })[0] as HTMLElement);
    await advance(800);

    let draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations?.map((op) => op["suggestionId"])).toEqual(["sug-002", "sug-001"]);

    // Move the first Harbor instance down; the op order swaps.
    const downs = screen.getAllByRole("button", { name: "Move down within role" });
    fireEvent.click(downs[0] as HTMLElement);
    await advance(800);
    draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations?.map((op) => op["suggestionId"])).toEqual(["sug-001", "sug-002"]);

    // Drop path: drop sug-001 onto the Lime group appends an identical add op.
    const group = screen.getByRole("heading", { name: "Lime Logistics — Associate PM" })
      .parentElement as HTMLElement;
    fireEvent.drop(group, { dataTransfer: { getData: () => "suggestion:sug-001" } });
    await advance(800);
    draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations?.at(-1)).toMatchObject({
      op: "add",
      suggestionId: "sug-001",
      roleId: "emp-lime",
    });
  });

  it("foreign drops are refused client-side with honest guidance", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    expect(screen.getByRole("heading", { name: "Unlinked experience" })).toBeInTheDocument();
    const group = screen.getByRole("heading", { name: "Unlinked experience" })
      .parentElement as HTMLElement;
    fireEvent.dragEnter(group);
    expect(screen.getByRole("status")).toHaveTextContent("cannot take suggestions");
    fireEvent.drop(group, { dataTransfer: { getData: () => "suggestion:sug-001" } });
    await advance(800);
    expect(server.puts()).toHaveLength(0);
  });

  it("edits persist as add-with-text or edit ops; focus moves into the buffer", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    // Suggestion edit before adding: buffer saves as add-with-editedText.
    const card = screen.getByText("Ran 40 discovery interviews shaping the roadmap.").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const buffer = screen.getByLabelText("Edit suggestion text") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(buffer);
    fireEvent.change(buffer, { target: { value: "Edited discovery wording." } });
    fireEvent.click(screen.getByRole("button", { name: "Add edited text" }));
    await advance(800);
    let draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations?.[0]).toMatchObject({
      op: "add",
      suggestionId: "sug-001",
      editedText: "Edited discovery wording.",
    });

    // Master reword: buffer saves as a bullet edit op.
    const harbor = screen.getByRole("heading", { name: "Harbor Analytics — Product Manager" })
      .parentElement as HTMLElement;
    const masterEdit = within(harbor).getAllByRole("button", { name: "Edit" })[0] as HTMLElement;
    fireEvent.click(masterEdit);
    const reword = screen.getByLabelText("Reword bullet") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(reword);
    fireEvent.change(reword, { target: { value: "Reworded discovery bullet." } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await advance(800);
    draft = (server.puts().at(-1)?.body as { draft?: { operations?: Array<Record<string, unknown>> } }).draft;
    expect(draft?.operations?.at(-1)).toMatchObject({
      op: "edit",
      target: { kind: "bullet", factId: "pm-fact-discovery" },
      text: "Reworded discovery bullet.",
    });
    expect(screen.getByText("Reworded discovery bullet.")).toBeInTheDocument();
  });

  it("unusable suggestions render with reasons and no actions", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    expect(screen.getByText("Invented revenue numbers.")).toBeInTheDocument();
    expect(screen.getByText("Needs evidence")).toBeInTheDocument();
    const row = screen.getByText("Invented revenue numbers.").closest("li") as HTMLElement;
    expect(row.querySelector("button")).toBeNull();
  });
});

describe("S2C4: persistence, conflicts, validation states", () => {
  it("saved drafts survive reload (Continue removed; Generate resume is the sole exit)", async () => {
    const addOp = {
      op: "add",
      operationId: "22222222-2222-4222-8222-222222222222",
      suggestionId: "sug-001",
      roleId: "emp-harbor",
      editedText: null,
    };
    const server = createFakeServer({
      workspace: v2WorkspaceFixture(2, draftFixture("Saved summary.", [addOp])),
    });
    const { onNavigateStep } = renderStep2(server);
    await settleMount();

    expect((screen.getByLabelText(/Summary \(/) as HTMLTextAreaElement).value).toBe("Saved summary.");
    // The added instance renders in its role group; the suggestion card keeps the source text.
    expect(screen.getAllByText("Ran 40 discovery interviews shaping the roadmap.")).toHaveLength(2);
    expect(screen.getByText("Saved · revision 2")).toBeInTheDocument();

    // S2-CP-C removed the navigation-only Continue exit; the
    // sole exit is Generate resume (pinned in s2cpa-exit).
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(onNavigateStep).not.toHaveBeenCalled();
  });

  it("412 keeps local input and offers explicit reload or overwrite", async () => {
    const server = createFakeServer();
    server.failNextPutOnce(412, errorBody("WORKSPACE_CONFLICT", "revision moved", { currentWorkspaceRevision: 4 }));
    renderStep2(server);
    await settleMount();

    fireEvent.change(screen.getByLabelText(/Summary \(/), { target: { value: "My unsaved summary." } });
    await advance(800);

    expect(screen.getByText(/Another session saved first/)).toBeInTheDocument();
    expect((screen.getByLabelText(/Summary \(/) as HTMLTextAreaElement).value).toBe("My unsaved summary.");

    server.setWorkspace(v2WorkspaceFixture(4, draftFixture("Server summary.", [])));
    fireEvent.click(screen.getByRole("button", { name: "Reload saved draft" }));
    await advance(100);
    expect((screen.getByLabelText(/Summary \(/) as HTMLTextAreaElement).value).toBe("Server summary.");
    expect(screen.getByText("Saved · revision 4")).toBeInTheDocument();
  });

  it("edits invalidate verdicts; stale async verdicts never apply", async () => {
    const server = createFakeServer();
    server.deferValidate = true;
    renderStep2(server);
    await settleMount();

    fireEvent.change(screen.getByLabelText(/Summary \(/), { target: { value: "First text." } });
    await advance(800);
    expect(screen.getByText("Checking…")).toBeInTheDocument();

    // A second edit starts a second check; resolving the first must not bless the new text.
    fireEvent.change(screen.getByLabelText(/Summary \(/), { target: { value: "Second text." } });
    await advance(800);
    await act(async () => {
      server.resolveOldestValidate();
    });
    await advance(100);
    expect(screen.queryByText(/Checked 1 segment/)).not.toBeInTheDocument();
    expect(screen.getByText("Checking…")).toBeInTheDocument();

    await act(async () => {
      server.resolveValidate();
    });
    await advance(100);
    const summaryRow = screen.getByText("Summary (edited)").closest("p") as HTMLElement;
    expect(within(summaryRow).getByText(/Supported/)).toBeInTheDocument();
    expect(screen.getByText(/Checked 1 segment/)).toBeInTheDocument();
  });

  it("needs-evidence verdicts name their segments; budgets stay visible", async () => {
    const server = createFakeServer();
    renderStep2(server);
    await settleMount();

    fireEvent.change(screen.getByLabelText(/Summary \(/), {
      target: { value: "Summary with UNVERIFIED claims." },
    });
    await advance(800);

    const badges = screen.getAllByText("Needs evidence");
    expect(badges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Summary characters: 31 \/ 4000/)).toBeInTheDocument();
    expect(screen.getByText(/Total bullets: 4 \/ 14/)).toBeInTheDocument();
  });

  it("preparation polls while running and stops at terminal states", async () => {
    const server = createFakeServer({ prepState: "RUNNING" });
    renderStep2(server);
    await settleMount();
    const baseline = server.calls.filter(
      (call) => call.url === `/api/jobs/${JOB_ID}/tailoring/preparation`,
    ).length;

    await advance(2100);
    const polled = server.calls.filter(
      (call) => call.url === `/api/jobs/${JOB_ID}/tailoring/preparation`,
    ).length;
    expect(polled).toBeGreaterThan(baseline);

    server.setPrep(prepFixture("SUCCEEDED", { acceptedPlanId: PLAN_ID, acceptedPlanHash: PLAN_HASH }));
    server.setPlanMissing(false);
    await advance(2100);
    const planCalls = server.calls.filter((call) => call.url === `/api/jobs/${JOB_ID}/tailoring/plan`);
    expect(planCalls.length).toBeGreaterThan(1);
    expect(screen.getByText("customer discovery")).toBeInTheDocument();

    const settled = server.calls.length;
    await advance(5000);
    expect(server.calls.length).toBe(settled);
  });
});
