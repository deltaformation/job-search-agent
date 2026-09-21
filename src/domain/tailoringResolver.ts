/**
 * Pure domain authoritative step resolver for the tailoring workflow.
 * Normative specification: docs/tailoring-contracts-v1.3.md §5,
 * acceptance criteria C5, C6.
 *
 * Rules:
 * - Pure domain: no imports of Next.js, Drizzle, Playwright, or SQLite.
 * - Deterministic, priority-ordered resolution.
 * - Zero side effects.
 */

export interface ResolverVersionSummary {
  id: string;
  version: number;
  reviewState: string;
  selectedApproved: boolean;
  latestPublished: boolean;
}

export interface TailoringResolverInput {
  /** Explicit step hint from URL (?step=1|2|3|4) */
  requestedStep?: number | null;
  /** Explicit version ID hint from URL (?version=<id>) */
  requestedVersionId?: string | null;
  /** Whether there is an active/live generation request (QUEUED or RUNNING) */
  hasLiveRequest: boolean;
  /** The live generation request ID if any */
  liveRequestId?: string | null;
  /** The workspace if present */
  workspace: {
    revision: number;
    lastSubmittedRevision: number | null;
  } | null;
  /** Version summaries owned by this job */
  versions: ResolverVersionSummary[];
  /** Whether the last generation request failed */
  lastRequestFailed: boolean;
}

export interface TailoringResolverResult {
  /** Authoritative step to display: 1 | 2 | 3 | 4 */
  step: 1 | 2 | 3 | 4;
  /** Selected version ID for Step 4 review (if available) */
  selectedVersionId: string | null;
  /** Whether the user is in inspect mode (e.g. historical version review or step 1/2 during live run) */
  isInspectMode: boolean;
  /** Whether the Generate action is enabled */
  canGenerate: boolean;
  /** Whether the Approve / Decision actions are enabled */
  canApprove: boolean;
  /** Highest step reached for step indicator navigation */
  maxStepReached: 1 | 2 | 3 | 4;
}

/**
 * Resolves the authoritative step and UI capabilities for the tailoring shell.
 */
export function resolveAuthoritativeStep(
  input: TailoringResolverInput,
): TailoringResolverResult {
  const {
    requestedStep,
    requestedVersionId,
    hasLiveRequest,
    workspace,
    versions,
    lastRequestFailed,
  } = input;

  // Pick default version for Step 4 if any exist:
  // Prefer selectedApproved, otherwise latestPublished, otherwise first in list
  const defaultVersion =
    versions.find((v) => v.selectedApproved) ??
    versions.find((v) => v.latestPublished) ??
    versions[0] ??
    null;

  // Compute baseline maxStepReached
  let maxStepReached: 1 | 2 | 3 | 4 = 1;
  if (versions.length > 0) {
    maxStepReached = 4;
  } else if (hasLiveRequest || lastRequestFailed) {
    maxStepReached = 3;
  } else if (workspace !== null && workspace.revision >= 1) {
    maxStepReached = 2;
  }

  // 1. Explicit owned version in URL wins highest priority (§5 2026-09-16 clarification)
  if (requestedVersionId !== undefined && requestedVersionId !== null && requestedVersionId !== "") {
    const matched = versions.find((v) => v.id === requestedVersionId);
    if (matched) {
      return {
        step: 4,
        selectedVersionId: matched.id,
        isInspectMode: true,
        canGenerate: false,
        canApprove: matched.reviewState === "AWAITING_REVIEW",
        maxStepReached: 4,
      };
    }
  }

  // 2. Explicit step in URL
  if (requestedStep !== undefined && requestedStep !== null && [1, 2, 3, 4].includes(requestedStep)) {
    const step = requestedStep as 1 | 2 | 3 | 4;
    const computedMax: 1 | 2 | 3 | 4 = Math.max(maxStepReached, step) as 1 | 2 | 3 | 4;

    if (hasLiveRequest) {
      // Step 1 or 2 inspection while live creates no second work (Generate disabled)
      if (step === 1 || step === 2) {
        return {
          step,
          selectedVersionId: null,
          isInspectMode: true,
          canGenerate: false,
          canApprove: false,
          maxStepReached: computedMax,
        };
      }
      if (step === 3) {
        return {
          step: 3,
          selectedVersionId: null,
          isInspectMode: false,
          canGenerate: false,
          canApprove: false,
          maxStepReached: computedMax,
        };
      }
      if (step === 4) {
        return {
          step: 4,
          selectedVersionId: defaultVersion?.id ?? null,
          isInspectMode: true,
          canGenerate: false,
          canApprove: defaultVersion !== null && defaultVersion.reviewState === "AWAITING_REVIEW",
          maxStepReached: computedMax,
        };
      }
    }

    // Not live request, explicit step
    if (step === 4) {
      const canApprove = defaultVersion !== null && defaultVersion.reviewState === "AWAITING_REVIEW";
      return {
        step: 4,
        selectedVersionId: defaultVersion?.id ?? null,
        isInspectMode: false,
        canGenerate: false,
        canApprove,
        maxStepReached: computedMax,
      };
    }

    return {
      step,
      selectedVersionId: null,
      isInspectMode: false,
      canGenerate: step === 2,
      canApprove: false,
      maxStepReached: computedMax,
    };
  }

  // 3. Default resolution matrix (§5 priority order)
  // 3a. Live request -> Step 3
  if (hasLiveRequest) {
    return {
      step: 3,
      selectedVersionId: null,
      isInspectMode: false,
      canGenerate: false,
      canApprove: false,
      maxStepReached: Math.max(maxStepReached, 3) as 1 | 2 | 3 | 4,
    };
  }

  // 3b. Draft revision > last_submitted_revision -> Step 2 (edited draft)
  const isEditedDraft =
    workspace !== null &&
    workspace.revision > (workspace.lastSubmittedRevision ?? 0);

  if (isEditedDraft) {
    return {
      step: 2,
      selectedVersionId: null,
      isInspectMode: false,
      canGenerate: true,
      canApprove: false,
      maxStepReached: Math.max(maxStepReached, 2) as 1 | 2 | 3 | 4,
    };
  }

  // 3c. Last request failed -> Step 3
  if (lastRequestFailed) {
    return {
      step: 3,
      selectedVersionId: null,
      isInspectMode: false,
      canGenerate: false,
      canApprove: false,
      maxStepReached: Math.max(maxStepReached, 3) as 1 | 2 | 3 | 4,
    };
  }

  // 3d. Published version exists -> Step 4
  if (versions.length > 0) {
    return {
      step: 4,
      selectedVersionId: defaultVersion?.id ?? null,
      isInspectMode: false,
      canGenerate: false,
      canApprove: defaultVersion !== null && defaultVersion.reviewState === "AWAITING_REVIEW",
      maxStepReached: 4,
    };
  }

  // 3e. Saved draft exists (revision >= 1) -> Step 2
  if (workspace !== null && workspace.revision >= 1) {
    return {
      step: 2,
      selectedVersionId: null,
      isInspectMode: false,
      canGenerate: true,
      canApprove: false,
      maxStepReached: Math.max(maxStepReached, 2) as 1 | 2 | 3 | 4,
    };
  }

  // 3f. Absent workspace / fresh job -> Step 1
  return {
    step: 1,
    selectedVersionId: null,
    isInspectMode: false,
    canGenerate: false,
    canApprove: false,
    maxStepReached: maxStepReached,
  };
}
