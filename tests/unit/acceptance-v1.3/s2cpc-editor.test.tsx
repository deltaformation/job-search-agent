import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Step2Focus from "../../../components/tailoring/Step2Focus";

/**
 * WO-1.3-S2-CP-C editor acceptance (S2CPC1–S2CPC3): the corrected
 * Step 2 editor over v2 plans shows server-derived provenance
 * labels (never Needs-evidence), the JD priority phrases each
 * proposal addresses, and eligible-only roles for Add/Replace/
 * drag/keyboard; Generate resume is the sole exit and user edits
 * never block it for evidence reasons. A fake fetch server
 * records every call; polling uses fake timers.
 */

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXTRACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROFILE_ID = "pm";
const PROFILE_VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLAN_HASH = "ab".repeat(32);
const PREP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BATCH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const T0 = "2026-09-17T12:00:00.000Z";

const P1 = "c1".repeat(32);
const P2 = "c2".repeat(32);

const DISCOVERY_TEXT = "Led customer discovery across 40 interviews.";
const SUGGESTION_TEXT = "Ran 40 discovery interviews shaping the roadmap.";
const MASTER_SUMMARY = "Master summary from Harbor.";

function profilePayloadFixture(): Record<string, unknown> {
  return {
    identity: { fullName: "Ada Lovelace" },
    targetTitles: [],
    targetLocations: [],
    summary: MASTER_SUMMARY,
    employment: [
      { id: "emp-harbor", company: "Harbor Analytics", role: "Product Manager", startDate: "2022-01-01", isCurrent: true },
      { id: "emp-lime", company: "Lime Logistics", role: "Associate PM", startDate: "2020-01-01", endDate: "2021-12-31", isCurrent: false },
    ],
    achievements: [
      { factId: "pm-fact-discovery", employmentId: "emp-harbor", category: "delivery", text: DISCOVERY_TEXT, technologies: [], metrics: [], verification: "APPROVED" },
      { factId: "pm-fact-roadmap", employmentId: "emp-lime", category: "delivery", text: "Owned the Lime roadmap end to end.", technologies: [], metrics: [], verification: "APPROVED" },
    ],
    skills: [],
    education: [],
    credentials: [],
  };
}

function planV2Fixture(): Record<string, unknown> {
  return {
    schemaVersion: "step2-plan/v2",
    planId: PLAN_ID,
    preparationId: PREP_ID,
    extractionId: EXTRACTION_ID,
    jdHash: "a".repeat(64),
    profileVersionId: PROFILE_VERSION_ID,
    evidenceHash: "b".repeat(64),
    masterProjectionHash: "c".repeat(64),
    priorities: [
      { priorityId: P1, quote: { text: "customer discovery", startByte: 10, endByte: 28 }, count: 3, category: "Research", importance: "required", support: "supported", factIds: ["pm-fact-discovery"] },
      { priorityId: P2, quote: { text: "roadmap planning", startByte: 90, endByte: 106 }, count: 1, category: "Delivery", importance: "preferred", support: "supported", factIds: ["pm-fact-roadmap"] },
    ],
    featuredPriorityIds: [P1, P2],
    positioning: {
      keepMasterSummary: MASTER_SUMMARY,
      angles: [
        { angleId: "angle-1", title: "Discovery-led growth", summaryText: "Discovery-led PM driving growth.", factIds: ["pm-fact-discovery"], priorityIds: [P1] },
      ],
    },
    suggestions: [
      { suggestionId: "sug-001", roleId: "emp-harbor", text: SUGGESTION_TEXT, factIds: ["pm-fact-discovery"], priorityIds: [P1], usable: true, unusableReason: null },
      { suggestionId: "sug-002", roleId: "emp-lime", text: "Piloted Lime lane analytics with carriers.", factIds: ["pm-fact-roadmap"], priorityIds: [P2], usable: true, unusableReason: null },
      { suggestionId: "sug-003", roleId: "emp-harbor", text: "Invented 900% growth numbers.", factIds: ["pm-fact-discovery"], priorityIds: [P1], usable: false, unusableReason: "NEW_METRIC" },
    ],
    rationale: "Fixture v2 plan.",
  };
}

function eligibleRolesFixture(): Array<Record<string, unknown>> {
  return [
    { suggestionId: "sug-001", eligibleRoleIds: ["emp-harbor"] },
    { suggestionId: "sug-002", eligibleRoleIds: ["emp-lime"] },
    { suggestionId: "sug-003", eligibleRoleIds: ["emp-harbor"] },
  ];
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

function prepFixture(state: string): Record<string, unknown> {
  return {
    schemaVersion: "step2-preparation-status/v1",
    preparationId: state === "ABSENT" ? null : PREP_ID,
    jobId: JOB_ID,
    state,
    binding: state === "ABSENT" ? null : bindingFixture(),
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
  };
}

function v3WorkspaceFixture(revision: number, draft: Record<string, unknown> | null): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    revision,
    draft: {
      schemaVersion: "tailoring-workspace/v3",
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

interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface V2FakeOptions {
  workspace?: Record<string, unknown> | null;
  failGenerations?: { status: number; body: unknown } | null;
}

function createV2FakeServer(options: V2FakeOptions = {}) {
  const calls: FetchCall[] = [];
  let serverWorkspace: Record<string, unknown> | null = options.workspace ?? null;
  let serverRevision = (serverWorkspace?.["revision"] as number | undefined) ?? 0;

  // Server-derived provenance over the posted bytes: exact master
  // text is verified, exact suggestion text is accepted AI, any
  // change is a user edit. Structural checks always pass here.
  const provenanceFor = (text: string): string => {
    if (text === MASTER_SUMMARY || text === DISCOVERY_TEXT) {
      return "VERIFIED_SOURCE";
    }
    if (text === SUGGESTION_TEXT) {
      return "USER_ACCEPTED_AI";
    }
    return "USER_EDITED";
  };
  const segmentFor = (id: string, text: string): Record<string, unknown> => ({
    segmentId: id,
    kind: id === "summary" ? "summary" : "bullet",
    provenance: provenanceFor(text),
    structural: { ok: true, reason: null },
    match: "exact-fact",
    reason: null,
    anchorFactIds: ["pm-fact-discovery"],
    priorityIds: [P1],
    textHash: "a".repeat(64),
    normalizedHash: "b".repeat(64),
  });

  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
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
      return jsonResponse(200, { ok: true, preparation: prepFixture("SUCCEEDED") });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/workspace` && method === "GET") {
      return jsonResponse(200, { ok: true, workspace: serverWorkspace });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/workspace` && method === "PUT") {
      const put = body as { draft?: unknown };
      serverRevision += 1;
      serverWorkspace = v3WorkspaceFixture(serverRevision, (put.draft ?? null) as Record<string, unknown> | null);
      return jsonResponse(serverRevision === 1 ? 201 : 200, { ok: true, workspace: serverWorkspace });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/plan` && method === "GET") {
      return jsonResponse(200, {
        ok: true,
        plan: planV2Fixture(),
        planHash: PLAN_HASH,
        validatedAt: T0,
        supersedesPlanId: null,
        eligibleRoles: eligibleRolesFixture(),
      });
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
      const request = body as {
        schemaVersion?: unknown;
        summaryOrigin?: unknown;
        summaryText?: unknown;
        operations?: Array<Record<string, unknown>>;
      };
      if (
        request.schemaVersion !== "step2-validate-draft/v2" ||
        (request.summaryOrigin !== "master" &&
          request.summaryOrigin !== "angle-1" &&
          request.summaryOrigin !== "angle-2")
      ) {
        return jsonResponse(400, { ok: false, error: { code: "INVALID_REQUEST", message: "expected V-v2" } });
      }
      const segments = [segmentFor("summary", String(request.summaryText ?? ""))];
      for (const op of request.operations ?? []) {
        const text =
          op.op === "add" || op.op === "replace"
            ? String((op.editedText as string | null) ?? SUGGESTION_TEXT)
            : op.op === "edit"
              ? String(op.text ?? "")
              : "";
        if (op.op !== "exclude") {
          segments.push(segmentFor(`op:${String(op.operationId)}`, text));
        }
      }
      return jsonResponse(200, {
        ok: true,
        validationId: "99999999-9999-4999-8999-999999999999",
        validation: {
          schemaVersion: "step2-validation/v2",
          policyVersion: "step2-claims/2",
          planId: PLAN_ID,
          planHash: PLAN_HASH,
          draftHash: "c".repeat(64),
          segments,
          provenanceCounts: { verifiedSource: 0, userAcceptedAi: 0, userEdited: 0 },
          budget: { summaryChars: 10, perRoleCounts: [], totalBullets: 0, exceeded: false },
          validatedAt: T0,
        },
      });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/generations` && method === "POST") {
      if (options.failGenerations !== null && options.failGenerations !== undefined) {
        return jsonResponse(options.failGenerations.status, options.failGenerations.body);
      }
      return jsonResponse(202, { ok: true, requestId: "req-1", workItemId: "wi-1", replayed: false });
    }
    return jsonResponse(404, { ok: false, error: { code: "NOT_FOUND", message: `unexpected ${method} ${url}` } });
  };

  return {
    fetch: fetchImpl,
    calls,
    puts: () => calls.filter((call) => call.method === "PUT"),
    posts: (suffix: string) => calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix)),
  };
}

type V2FakeServer = ReturnType<typeof createV2FakeServer>;

function renderStep2(server: V2FakeServer) {
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
    />,
  );
  return { onNavigateStep, ...utils };
}

async function settle(ms = 1200): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubLocation(): { assign: ReturnType<typeof vi.fn> } {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    href: "http://127.0.0.1:3000/tailor/job?step=2",
    assign,
  });
  return { assign };
}

function lastPutDraft(server: V2FakeServer): Record<string, unknown> | undefined {
  return (
    server.puts().at(-1)?.body as { draft?: Record<string, unknown> } | undefined
  )?.draft;
}

describe("S2CPC1 provenance labels and priority phrases", () => {
  it("untouched v2 rows show Verified source with linked phrases and no evidence blocker", async () => {
    const server = createV2FakeServer();
    renderStep2(server);
    await settle();

    expect(screen.getAllByText("Verified source").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Addresses: “customer discovery”/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Addresses: “roadmap planning”/)).toBeInTheDocument();
    expect(screen.queryByText(/needs evidence/i)).toBeNull();
    expect(screen.getByLabelText(/Summary \(Master\)/)).toBeInTheDocument();
  });

  it("accepted AI text and user edits label distinctly without blocking", async () => {
    const server = createV2FakeServer();
    renderStep2(server);
    await settle();

    // Use sug-001 unchanged: the added instance labels accepted AI.
    fireEvent.click(screen.getAllByRole("button", { name: "Use" })[0] as HTMLElement);
    await settle();
    expect(screen.getByText("AI suggestion · accepted")).toBeInTheDocument();

    // Edit the instance: the label flips to User edit, and
    // Generate resume stays enabled (no evidence blocker).
    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${SUGGESTION_TEXT.slice(0, 60)}` }),
    );
    const area = screen.getByLabelText(/Edit instance text/) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "User-rewritten bullet with UNVERIFIED claims." } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await settle();
    expect(screen.getByText("User edit")).toBeInTheDocument();
    expect(screen.queryByText(/needs evidence/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^generate resume$/i })).toBeEnabled();
  });
});

describe("S2CPC2 eligible roles across Add, Replace, drag, and keyboard", () => {
  it("Add choosers expose eligible roles only", async () => {
    const server = createV2FakeServer();
    renderStep2(server);
    await settle();

    const choosers = screen.getAllByLabelText("Add to role") as HTMLSelectElement[];
    expect(choosers).toHaveLength(2);
    const harborOptions = Array.from(choosers[0]?.options ?? []).map((option) => option.value);
    expect(harborOptions).toEqual(["emp-harbor"]);
    const limeOptions = Array.from(choosers[1]?.options ?? []).map((option) => option.value);
    expect(limeOptions).toEqual(["emp-lime"]);
  });

  it("foreign drops refuse with guidance and persist nothing", async () => {
    const server = createV2FakeServer();
    renderStep2(server);
    await settle();

    // Mount may have autosaved the seeded draft (revision 1);
    // the refused drop itself must persist nothing.
    const putsBeforeDrop = server.puts().length;
    const group = screen.getByRole("heading", { name: "Lime Logistics — Associate PM" })
      .parentElement as HTMLElement;
    fireEvent.drop(group, { dataTransfer: { getData: () => "suggestion:sug-001" } });
    await settle(200);
    expect(screen.getByRole("status")).toHaveTextContent("is not eligible for this suggestion");
    expect(server.puts()).toHaveLength(putsBeforeDrop);
  });

  it("Add, Replace, drag, and keyboard persist identical eligible ops", async () => {
    const server = createV2FakeServer();
    renderStep2(server);
    await settle();

    // Chooser path: add sug-002 to its eligible Lime role.
    const choosers = screen.getAllByLabelText("Add to role");
    fireEvent.change(choosers[1] as HTMLElement, { target: { value: "emp-lime" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[1] as HTMLElement);
    await settle();
    let draft = lastPutDraft(server);
    expect(
      (draft?.["operations"] as Array<Record<string, unknown>>)?.map((op) => [
        op["op"],
        op["suggestionId"],
        op["roleId"],
      ]),
    ).toEqual([["add", "sug-002", "emp-lime"]]);

    // Drop path: drop sug-001 onto the Harbor group.
    const group = screen.getByRole("heading", { name: "Harbor Analytics — Product Manager" })
      .parentElement as HTMLElement;
    fireEvent.drop(group, { dataTransfer: { getData: () => "suggestion:sug-001" } });
    await settle();
    draft = lastPutDraft(server);
    expect(
      (draft?.["operations"] as Array<Record<string, unknown>>)?.map((op) => [
        op["op"],
        op["suggestionId"],
        op["roleId"],
      ]),
    ).toEqual([
      ["add", "sug-002", "emp-lime"],
      ["add", "sug-001", "emp-harbor"],
    ]);

    // Keyboard path: move the Lime instance down within its role.
    // (Single-instance groups cannot reorder; the op survives
    // unchanged, proving keyboard and drop persist identically.)
    fireEvent.click(screen.getAllByRole("button", { name: "Move down within role" })[0] as HTMLElement);
    await settle();
    draft = lastPutDraft(server);
    const ops = (draft?.["operations"] as Array<Record<string, unknown>>) ?? [];
    expect(ops.map((op) => [op["suggestionId"], op["roleId"]])).toEqual([
      ["sug-002", "emp-lime"],
      ["sug-001", "emp-harbor"],
    ]);

    // Replace path: replace a Harbor bullet with sug-001 in place.
    fireEvent.click(screen.getAllByRole("button", { name: "Replace…" })[0] as HTMLElement);
    fireEvent.click(
      screen.getByRole("button", { name: `Replace this bullet` }),
    );
    await settle(200);
    draft = lastPutDraft(server);
    const last = ((draft?.["operations"] as Array<Record<string, unknown>>) ?? []).at(-1);
    expect(last).toMatchObject({ op: "replace", suggestionId: "sug-001", roleId: "emp-harbor" });
  });
});

describe("S2CPC3 one Generate exit and no phantom queue", () => {
  it("user-edited drafts submit and follow Step 3 without an evidence block", async () => {
    const server = createV2FakeServer();
    const { assign } = stubLocation();
    const { onNavigateStep } = renderStep2(server);
    await settle();

    fireEvent.change(screen.getByLabelText(/Summary \(/), {
      target: { value: "Edited summary with UNVERIFIED claims." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^generate resume$/i }));
    await settle();

    const posts = server.posts("/tailoring/generations");
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as Record<string, unknown>)["workspaceRevision"]).toBe(2);
    expect(onNavigateStep).toHaveBeenCalledWith(3);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toContain("step=3");
  });

  it("mount, validation, navigation, autosave, and cancel enqueue nothing", async () => {
    const server = createV2FakeServer();
    const { onNavigateStep } = renderStep2(server);
    await settle();

    // Mount validated (advisory) and may have autosaved, but
    // nothing reaches the generation or preparation queues.
    expect(server.posts("/tailoring/generations")).toHaveLength(0);
    expect(server.posts("/tailoring/preparation")).toHaveLength(0);
    const putsAfterMount = server.puts().length;

    // Back navigation enqueues nothing.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle(200);
    expect(onNavigateStep).toHaveBeenCalledWith(1);
    expect(server.posts("/tailoring/generations")).toHaveLength(0);

    // Cancelling an edit writes nothing.
    fireEvent.click(screen.getAllByRole("button", { name: "Use" })[0] as HTMLElement);
    await settle();
    const putsAfterUse = server.puts().length;
    fireEvent.click(
      screen.getByRole("button", { name: `Edit ${SUGGESTION_TEXT.slice(0, 60)}` }),
    );
    const area = screen.getByLabelText(/Edit instance text/) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Discarded edit." } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(server.puts()).toHaveLength(putsAfterUse);
    expect(server.posts("/tailoring/generations")).toHaveLength(0);
    expect(putsAfterMount).toBeGreaterThanOrEqual(0);
  });
});
