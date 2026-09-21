import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Step2Focus from "../../../components/tailoring/Step2Focus";

/**
 * WO-1.3-S2-CP-A / S2CPA4: Step 2 has one primary exit. The S2-D
 * `Continue` control navigates to Step 3 without submitting
 * generation; the correction removes it, leaving a single
 * Generate-resume transition (flush → resolve → freeze → submit →
 * follow). The guard documents today's two exits; the pin fails at
 * its target until S2-CP-C.
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
      draft: {
        schemaVersion: "step2-draft/v1",
        planId: PLAN_ID,
        planHash: PLAN_HASH,
        summaryText: "Master summary from Harbor.",
        summarySource: "master",
        operations: [
          { op: "add", operationId: ADD_OP, suggestionId: "sug-001", roleId: "emp-harbor", editedText: null },
        ],
      },
    },
    recommendations: null,
    lastRequestId: null,
    lastSubmittedRevision: null,
    updatedAt: T0,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function errorBody(code: string, message: string): unknown {
  return { ok: false, error: { code, message, action: null } };
}

function createFakeServer() {
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === `/api/jobs/${JOB_ID}/tailoring/preparation` && method === "GET") {
      return jsonResponse(200, {
        ok: true,
        preparation: {
          schemaVersion: "step2-preparation-status/v1",
          preparationId: PREP_ID,
          jobId: JOB_ID,
          state: "SUCCEEDED",
          binding: { profileId: PROFILE_ID, profileVersionId: PROFILE_VERSION_ID, batchId: BATCH_ID },
          extractionId: EXTRACTION_ID,
          acceptedPlanId: PLAN_ID,
          acceptedPlanHash: PLAN_HASH,
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
      return jsonResponse(200, { ok: true, workspace: workspaceFixture(1) });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/plan` && method === "GET") {
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
      return jsonResponse(200, { profiles: [{ id: PROFILE_ID, displayName: "Product Manager", isDefault: true }] });
    }
    if (url === `/api/jobs/${JOB_ID}` && method === "GET") {
      return jsonResponse(200, { job: { rowVersion: 2 } });
    }
    if (url === `/api/jobs/${JOB_ID}/tailoring/draft/validate` && method === "POST") {
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
          ],
          budget: { summaryChars: 10, perRoleCounts: [{ roleId: "emp-harbor", bullets: 2 }], totalBullets: 2, exceeded: false },
          validatedAt: T0,
        },
      });
    }
    return jsonResponse(404, errorBody("NOT_FOUND", `unexpected ${method} ${url}`));
  };
  return { fetch: fetchImpl };
}

function renderStep2() {
  const onNavigateStep = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(createFakeServer().fetch as typeof fetch);
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

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
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

describe("S2CPA4 one Generate exit", () => {
  it("guard: Step 2 exposes no Continue control", async () => {
    renderStep2();
    await settle();
    expect(screen.queryByRole("button", { name: /^continue$/i })).toBeNull();
  });

  it("Step 2 exposes exactly one primary exit", async () => {
    renderStep2();
    await settle();
    // TARGET (S2-CP-C), flipped: the navigation-only Continue
    // action is removed; Generate resume is the sole Step 2 exit.
    expect(screen.queryByRole("button", { name: /^continue$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^generate resume$/i })).toBeInTheDocument();
  });
});
