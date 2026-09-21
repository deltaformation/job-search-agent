// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  artifactDownloadHref,
  resolveTailorEntry,
  tailorReviewHref,
  tailorStepHref,
  workspaceHasDraft,
  type TailorEntrySignals,
} from "../../../src/domain/tailorEntry";
import type { WorkspaceViewV2 } from "../../../src/domain/step2";
import type { WorkspaceViewV3 } from "../../../src/domain/step2Correction";
import type { WorkspaceView } from "../../../src/domain/tailoringWorkspace";

/**
 * WO-1.3-H acceptance, H1 leg: the v1/v2 parity matrix. Every
 * production Tailor/Review entry exposes identical Step 2 states
 * with deep links, whether the job's workspace is v1-focus, v2, or
 * v3-correction, and version links carry exact v1/v2 row context.
 */

function signals(overrides: Partial<TailorEntrySignals>): TailorEntrySignals {
  return {
    tailorLive: false,
    tailoringState: "READY",
    tailoringReasonCode: null,
    preparationState: "ABSENT",
    preparationFailure: null,
    acceptedPlanId: null,
    workspace: null,
    ...overrides,
  };
}

describe("H1 entry-state ladder", () => {
  it("resolves each of the five states with its deep-link step", () => {
    expect(
      resolveTailorEntry(signals({ tailorLive: true, tailoringState: "RUNNING" })),
    ).toEqual({ state: "generating", reason: null, step: 3, label: "Generating" });
    expect(
      resolveTailorEntry(
        signals({ tailoringState: "FAILED", tailoringReasonCode: "PROVIDER_TIMEOUT" }),
      ),
    ).toEqual({
      state: "failed",
      reason: "PROVIDER_TIMEOUT",
      step: 3,
      label: "Generation failed",
    });
    expect(
      resolveTailorEntry(
        signals({ preparationState: "FAILED", preparationFailure: "No provider configured" }),
      ),
    ).toEqual({
      state: "blocked",
      reason: "No provider configured",
      step: 2,
      label: "Blocked",
    });
    expect(
      resolveTailorEntry(
        signals({
          preparationState: "SUCCEEDED",
          acceptedPlanId: "plan-1",
          workspace: { revision: 2, lastSubmittedRevision: 1, hasDraft: true },
        }),
      ),
    ).toEqual({ state: "editing", reason: null, step: 2, label: "Editing draft" });
    expect(
      resolveTailorEntry(
        signals({
          preparationState: "SUCCEEDED",
          acceptedPlanId: "plan-1",
          workspace: { revision: 2, lastSubmittedRevision: 2, hasDraft: true },
        }),
      ),
    ).toEqual({ state: "prepared", reason: null, step: 2, label: "Prepared plan" });
    expect(resolveTailorEntry(signals({}))).toEqual({
      state: null,
      reason: null,
      step: 1,
      label: "Not started",
    });
  });

  it("prefers generating over failed over blocked over editing over prepared", () => {
    const editing = {
      preparationState: "SUCCEEDED",
      acceptedPlanId: "plan-1",
      workspace: { revision: 2, lastSubmittedRevision: 1, hasDraft: true },
    } as const;
    expect(
      resolveTailorEntry(signals({ ...editing, tailorLive: true })).state,
    ).toBe("generating");
    expect(
      resolveTailorEntry(signals({ ...editing, tailoringState: "FAILED" })).state,
    ).toBe("failed");
    expect(
      resolveTailorEntry(
        signals({ ...editing, preparationState: "FAILED", preparationFailure: "x" }),
      ).state,
    ).toBe("blocked");
    expect(resolveTailorEntry(signals({ ...editing })).state).toBe("editing");
  });

  it("treats a live preparation as generating on Step 2", () => {
    for (const preparationState of ["PENDING", "QUEUED", "RUNNING"] as const) {
      expect(resolveTailorEntry(signals({ preparationState }))).toEqual({
        state: "generating",
        reason: null,
        step: 2,
        label: "Generating",
      });
    }
  });

  it("treats a blocked tailoring lane as blocked with its reason", () => {
    expect(
      resolveTailorEntry(
        signals({ tailoringState: "BLOCKED", tailoringReasonCode: "PROVIDER_UNAVAILABLE" }),
      ),
    ).toEqual({
      state: "blocked",
      reason: "PROVIDER_UNAVAILABLE",
      step: 2,
      label: "Blocked",
    });
  });
});

describe("H1 workspace-format parity", () => {
  const v1Focus = {
    jobId: "job-1",
    revision: 2,
    draft: {
      schemaVersion: "tailoring-workspace/v1",
      focus: {
        schemaVersion: "tailoring-focus/v1",
        selectedPhraseIds: ["a".repeat(64)],
        themeId: null,
        summaryDirection: "",
        mappings: [],
        additionalGuidance: "",
      },
    },
    lastSubmittedRevision: 1,
  } as unknown as WorkspaceView;

  const v1Blank = {
    jobId: "job-1",
    revision: 1,
    draft: {
      schemaVersion: "tailoring-workspace/v1",
      focus: {
        schemaVersion: "tailoring-focus/v1",
        selectedPhraseIds: [],
        themeId: null,
        summaryDirection: "",
        mappings: [],
        additionalGuidance: "",
      },
    },
    lastSubmittedRevision: null,
  } as unknown as WorkspaceView;

  const v2Draft = {
    jobId: "job-1",
    revision: 2,
    draft: {
      schemaVersion: "step2-workspace/v2",
      draft: { schemaVersion: "step2-draft/v2", operations: [] },
    },
    lastSubmittedRevision: 1,
  } as unknown as WorkspaceViewV2;

  const v3Draft = {
    jobId: "job-1",
    revision: 2,
    draft: {
      schemaVersion: "tailoring-workspace/v3",
      draft: { schemaVersion: "step2-draft/v2", operations: [] },
    },
    lastSubmittedRevision: 1,
  } as unknown as WorkspaceViewV3;

  const v3Empty = {
    jobId: "job-1",
    revision: 1,
    draft: { schemaVersion: "tailoring-workspace/v3", draft: null },
    lastSubmittedRevision: null,
  } as unknown as WorkspaceViewV3;

  it("normalizes draft presence across v1-focus, v2, and v3", () => {
    expect(workspaceHasDraft(v1Focus)).toBe(true);
    expect(workspaceHasDraft(v1Blank)).toBe(false);
    expect(workspaceHasDraft(v2Draft)).toBe(true);
    expect(workspaceHasDraft(v3Draft)).toBe(true);
    expect(workspaceHasDraft(v3Empty)).toBe(false);
  });

  it("resolves identical entries for equivalent v1, v2, and v3 footprints", () => {
    const views = [v1Focus, v2Draft, v3Draft] as const;
    const entries = views.map((view) =>
      resolveTailorEntry(
        signals({
          preparationState: "SUCCEEDED",
          acceptedPlanId: "plan-1",
          workspace: {
            revision: view.revision,
            lastSubmittedRevision: view.lastSubmittedRevision,
            hasDraft: workspaceHasDraft(view),
          },
        }),
      ),
    );
    for (const entry of entries) {
      expect(entry).toEqual({ state: "editing", reason: null, step: 2, label: "Editing draft" });
    }
  });
});

describe("H1 exact deep links across v1/v2 rows", () => {
  it("builds step links without version context", () => {
    expect(tailorStepHref("job-1", 1)).toBe("/jobs/job-1/tailor?step=1");
    expect(tailorStepHref("job-1", 2)).toBe("/jobs/job-1/tailor?step=2");
    expect(tailorStepHref("job-1", 3)).toBe("/jobs/job-1/tailor?step=3");
  });

  it("builds exact review links per version row", () => {
    expect(tailorReviewHref("job-1", "v1-id")).toBe("/jobs/job-1/tailor?step=4&version=v1-id");
    expect(tailorReviewHref("job-1", "v2-id")).toBe("/jobs/job-1/tailor?step=4&version=v2-id");
  });

  it("builds the exact artifact download URL", () => {
    expect(artifactDownloadHref("art-1")).toBe("/api/resumes/artifacts/art-1?download=1");
  });
});
