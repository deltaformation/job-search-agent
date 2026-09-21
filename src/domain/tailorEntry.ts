import { z } from "zod";
import type { WorkspaceViewV2 } from "./step2";
import type { WorkspaceViewV3 } from "./step2Correction";
import type { WorkspaceView } from "./tailoringWorkspace";

/**
 * WO-1.3-H entry states: every production Tailor/Review entry point
 * (board card, drawer panel, history rows) exposes the same Step 2
 * vocabulary with a deep link into the tailor route. The resolver is
 * format-agnostic — v1-focus, v2, and v3-correction workspaces yield
 * identical states — and version links always carry exact context.
 */

export const TAILOR_ENTRY_STATES = [
  "generating",
  "failed",
  "blocked",
  "editing",
  "prepared",
] as const;
export type TailorEntryState = (typeof TAILOR_ENTRY_STATES)[number];

export const TailorEntryStateSchema = z.enum(TAILOR_ENTRY_STATES);

export const ENTRY_STATE_LABEL: Record<TailorEntryState, string> = {
  generating: "Generating",
  failed: "Generation failed",
  blocked: "Blocked",
  editing: "Editing draft",
  prepared: "Prepared plan",
};

export interface TailorEntrySignals {
  /** A TAILOR request or work item is QUEUED/RUNNING. */
  tailorLive: boolean;
  /** Raw jobs.tailoring_state (READY, FAILED, BLOCKED, …). */
  tailoringState: string;
  /** Raw jobs.tailoring_reason_code, if any. */
  tailoringReasonCode: string | null;
  /** Step 2 preparation lane state (ABSENT when no preparation row). */
  preparationState: "ABSENT" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  /** Human-readable preparation failure reason, if any. */
  preparationFailure: string | null;
  /** Accepted plan id, if the preparation accepted one. */
  acceptedPlanId: string | null;
  /** Normalized workspace footprint; null when no workspace row. */
  workspace: {
    revision: number;
    lastSubmittedRevision: number | null;
    /** v1-focus: any selections/mappings/direction; v2/v3: draft !== null. */
    hasDraft: boolean;
  } | null;
}

export interface TailorEntry {
  /** Null when the job has no Step 2 footprint yet (fresh). */
  state: TailorEntryState | null;
  /** Machine reason code or human failure text for failed/blocked. */
  reason: string | null;
  /** Deep-link step: 1 fresh, 2 Step 2 work, 3 live/failed runs. */
  step: 1 | 2 | 3;
  /** Display label, identical across workspace formats. */
  label: string;
}

export function resolveTailorEntry(signals: TailorEntrySignals): TailorEntry {
  if (signals.tailorLive) {
    return { state: "generating", reason: null, step: 3, label: ENTRY_STATE_LABEL.generating };
  }
  if (signals.tailoringState === "FAILED") {
    return {
      state: "failed",
      reason: signals.tailoringReasonCode,
      step: 3,
      label: ENTRY_STATE_LABEL.failed,
    };
  }
  if (signals.preparationState === "FAILED") {
    return {
      state: "blocked",
      reason: signals.preparationFailure,
      step: 2,
      label: ENTRY_STATE_LABEL.blocked,
    };
  }
  if (signals.tailoringState === "BLOCKED") {
    return {
      state: "blocked",
      reason: signals.tailoringReasonCode,
      step: 2,
      label: ENTRY_STATE_LABEL.blocked,
    };
  }
  if (
    signals.preparationState === "PENDING" ||
    signals.preparationState === "QUEUED" ||
    signals.preparationState === "RUNNING"
  ) {
    return { state: "generating", reason: null, step: 2, label: ENTRY_STATE_LABEL.generating };
  }
  const workspace = signals.workspace;
  if (
    workspace !== null &&
    workspace.hasDraft &&
    (workspace.lastSubmittedRevision === null || workspace.revision > workspace.lastSubmittedRevision)
  ) {
    return { state: "editing", reason: null, step: 2, label: ENTRY_STATE_LABEL.editing };
  }
  if (signals.acceptedPlanId !== null) {
    return { state: "prepared", reason: null, step: 2, label: ENTRY_STATE_LABEL.prepared };
  }
  return { state: null, reason: null, step: 1, label: "Not started" };
}

/**
 * Format-agnostic draft presence across v1-focus, v2, and v3
 * workspaces. v1-focus rows always carry a focus object, so presence
 * means any user-authored content; v2/v3 carry a nullable draft.
 */
export function workspaceHasDraft(
  workspace: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3,
): boolean {
  const draft = workspace.draft as unknown;
  if (draft === null || typeof draft !== "object") {
    return false;
  }
  if (!("schemaVersion" in draft)) {
    return false;
  }
  if ("focus" in draft) {
    const focus = (draft as { focus?: unknown }).focus as
      | {
          selectedPhraseIds?: unknown;
          themeId?: unknown;
          summaryDirection?: unknown;
          mappings?: unknown;
          additionalGuidance?: unknown;
        }
      | undefined;
    if (focus === undefined || focus === null || typeof focus !== "object") {
      return false;
    }
    return (
      (Array.isArray(focus.selectedPhraseIds) && focus.selectedPhraseIds.length > 0) ||
      focus.themeId !== null ||
      (typeof focus.summaryDirection === "string" && focus.summaryDirection.trim() !== "") ||
      (Array.isArray(focus.mappings) && focus.mappings.length > 0) ||
      (typeof focus.additionalGuidance === "string" && focus.additionalGuidance.trim() !== "")
    );
  }
  return (draft as { draft?: unknown }).draft !== null;
}

/** Canonical tailor-route deep links for entry points. */
export function tailorStepHref(jobId: string, step: 1 | 2 | 3 | 4): string {
  return `/jobs/${jobId}/tailor?step=${step}`;
}

export function tailorReviewHref(jobId: string, versionId: string): string {
  return `/jobs/${jobId}/tailor?step=4&version=${versionId}`;
}

/** Exact artifact download URL for the selected approved PDF. */
export function artifactDownloadHref(artifactId: string): string {
  return `/api/resumes/artifacts/${artifactId}?download=1`;
}
