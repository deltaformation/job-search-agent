import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import { getActiveProfileVersion, getProfileVersion, listFactsByVersion } from "../db/candidates";
import { parseStoredPlan, readPreparationById, readPreparationByJob, readPlan } from "../db/step2";
import { getTailoringJob } from "../db/tailoring";
import { readWorkspace, saveWorkspaceCAS } from "../db/tailoringWorkspace";
import {
  candidateProfiles,
  candidateProfileVersions,
  candidateSnapshots,
  generationRequests,
  jobAnalyses,
  jobExtractions,
  resumeVersions,
} from "../db/schema";
import { withTransaction } from "../db/transactions";
import { utcNow } from "../db/utils";
import { canonicalJson } from "../domain/canonical";
import { parseStoredProfilePayload } from "../domain/candidate";
import { ReviewState } from "../domain/enums";
import { IsoUtcDateTime } from "../domain/fields";
import {
  PreparationPlanV1,
  STEP2_SCHEMA_VERSIONS,
  WorkspacePutV2,
  WorkspaceStoredV2,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type Step2DraftOperationV1 as Step2DraftOperationV1Type,
  type WorkspacePutV2 as WorkspacePutV2Type,
  type WorkspaceViewV2 as WorkspaceViewV2Type,
} from "../domain/step2";
import {
  STEP2_CORRECTION_VERSIONS,
  WorkspacePutV3,
  WorkspaceStoredV3,
  deriveEligibleRoles,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2DraftOperationV2 as Step2DraftOperationV2Type,
  type WorkspacePutV3 as WorkspacePutV3Type,
  type WorkspaceViewV3 as WorkspaceViewV3Type,
} from "../domain/step2Correction";
import {
  FocusV1,
  RecommendationV1,
  TAILORING_FOCUS_SCHEMA_VERSION,
  TAILORING_WORKSPACE_SCHEMA_VERSION,
  WorkspacePut,
  buildWorkspaceETag,
  validateFocusSelection,
  type RecommendationV1 as RecommendationV1Type,
  type WorkspacePut as WorkspacePutType,
  type WorkspaceView as WorkspaceViewType,
} from "../domain/tailoringWorkspace";
import { sha256HexUtf8 } from "../tailoring/hash";
import { hashRecommendation } from "../tailoring/requestsV3";
import { evidenceHashFor } from "../tailoring/step2policy";

/**
 * v1.3 workspace service (WO-1.3-B): transaction W, the bounded
 * workspace/version reads C consumes, and the submission-stamp
 * primitive E's G composes. Repositories own SQL; this module owns
 * Zod validation, active-binding checks, hash equality, and typed
 * failures (routes map these to ErrorBody + status).
 *
 * Clock rule: every method takes an optional trusted `now`
 * (`Date.toISOString()`); routes pass real time, tests freeze T0.
 * Public bodies never carry time, actors, tokens, or paths.
 */

/** Deterministic recommendation builder (WO-1.3-D implements the real adapter). */
export interface WorkspaceRecommendationsProvider {
  getRecommendations(
    handle: DatabaseHandle,
    input: { jobId: string; extractionId: string; profileVersionId: string },
  ):
    | { ok: true; recommendations: RecommendationV1Type }
    | { ok: false; error: "extraction-not-ready" | "storage-unavailable"; detail: string };
}

export type WorkspaceFailureError =
  | "unknown-job"
  | "not-found"
  | "workspace-conflict"
  | "input-stale"
  | "invalid-selection"
  | "invalid-request"
  | "plan-stale"
  | "storage-unavailable";

export interface WorkspaceFailure {
  error: WorkspaceFailureError;
  detail: string;
  field?: string;
  currentWorkspaceRevision?: number;
}

export interface WorkspaceSuccess {
  /** Stored view; clients branch on `draft.schemaVersion` (v1, v2, or v3). */
  workspace: WorkspaceViewType | WorkspaceViewV2Type | WorkspaceViewV3Type | null;
  /** Stored revision, or 0 when no workspace exists (GET only). */
  revision: number;
  etag: string;
  created: boolean;
}

export type WorkspaceResult =
  | { ok: true; value: WorkspaceSuccess }
  | { ok: false; failure: WorkspaceFailure };

function fail(
  error: WorkspaceFailureError,
  detail: string,
  extra: Partial<WorkspaceFailure> = {},
): { ok: false; failure: WorkspaceFailure } {
  return { ok: false, failure: { error, detail, ...extra } };
}

/**
 * GET workspace read: job + one PK lookup, then strict Zod parsing
 * of every stored JSON column. Absent workspaces return a null view
 * at revision 0 WITHOUT inserting. Corrupt stored JSON is a typed
 * storage failure, never unchecked typed data.
 */
export function getWorkspaceView(handle: DatabaseHandle, jobId: string): WorkspaceResult {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  const row = readWorkspace(handle, jobId);
  if (row === null) {
    return {
      ok: true,
      value: { workspace: null, revision: 0, etag: buildWorkspaceETag(jobId, 0), created: false },
    };
  }
  const view = parseWorkspaceRow(jobId, row);
  if (view === null) {
    return fail(
      "storage-unavailable",
      "stored workspace draft failed strict validation; inspect the row, do not trust it",
    );
  }
  return {
    ok: true,
    value: {
      workspace: view,
      revision: row.revision,
      etag: buildWorkspaceETag(jobId, row.revision),
      created: false,
    },
  };
}

interface StoredWorkspaceRow {
  revision: number;
  extractionId: string | null;
  profileId: string | null;
  profileVersionId: string | null;
  requestKind: string;
  parentVersionId: string | null;
  revisionNote: string | null;
  focusJson: string;
  recommendationsJson: string | null;
  recommendationHash: string | null;
  lastRequestId: string | null;
  lastSubmittedRevision: number | null;
  updatedAt: string;
}

function parseJsonColumn(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Assemble + strictly validate a view from a stored row; null on any corruption. */
function parseWorkspaceRow(
  jobId: string,
  row: StoredWorkspaceRow,
): WorkspaceViewType | WorkspaceViewV2Type | WorkspaceViewV3Type | null {
  const stored = parseJsonColumn(row.focusJson) as { schemaVersion?: unknown } | undefined;
  if (stored !== undefined && stored.schemaVersion === STEP2_CORRECTION_VERSIONS.workspace) {
    return parseWorkspaceRowV3(jobId, row, stored);
  }
  if (stored !== undefined && stored.schemaVersion === STEP2_SCHEMA_VERSIONS.workspace) {
    return parseWorkspaceRowV2(jobId, row, stored);
  }
  if (stored === undefined || stored.schemaVersion !== TAILORING_FOCUS_SCHEMA_VERSION) {
    return null;
  }
  const focus = FocusV1.safeParse(stored);
  if (!focus.success) {
    return null;
  }
  let recommendations: RecommendationV1Type | null = null;
  if (row.recommendationsJson !== null) {
    const parsed = RecommendationV1.safeParse(parseJsonColumn(row.recommendationsJson));
    if (!parsed.success) {
      return null;
    }
    recommendations = parsed.data;
  }
  const draft = WorkspacePut.safeParse({
    schemaVersion: TAILORING_WORKSPACE_SCHEMA_VERSION,
    extractionId: row.extractionId,
    profileId: row.profileId,
    profileVersionId: row.profileVersionId,
    requestKind: row.requestKind,
    parentVersionId: row.parentVersionId,
    revisionNote: row.revisionNote,
    recommendationHash: row.recommendationHash,
    focus: focus.data,
  });
  if (!draft.success) {
    return null;
  }
  if (IsoUtcDateTime.safeParse(row.updatedAt).success === false) {
    return null;
  }
  return {
    jobId,
    revision: row.revision,
    draft: draft.data,
    recommendations,
    lastRequestId: row.lastRequestId,
    lastSubmittedRevision: row.lastSubmittedRevision,
    updatedAt: row.updatedAt,
  };
}

/**
 * S2-C v2 view: header from the row columns, plan binding + draft
 * from the stored v2 envelope. Unknown inner versions stay corrupt
 * (null) exactly like unparseable v1 bytes.
 */
function parseWorkspaceRowV2(
  jobId: string,
  row: StoredWorkspaceRow,
  stored: unknown,
): WorkspaceViewV2Type | null {
  const envelope = WorkspaceStoredV2.safeParse(stored);
  if (!envelope.success) {
    return null;
  }
  let recommendations: RecommendationV1Type | null = null;
  if (row.recommendationsJson !== null) {
    const parsed = RecommendationV1.safeParse(parseJsonColumn(row.recommendationsJson));
    if (!parsed.success) {
      return null;
    }
    recommendations = parsed.data;
  }
  const draft = WorkspacePutV2.safeParse({
    schemaVersion: STEP2_SCHEMA_VERSIONS.workspace,
    extractionId: row.extractionId,
    profileId: row.profileId,
    profileVersionId: row.profileVersionId,
    requestKind: row.requestKind,
    parentVersionId: row.parentVersionId,
    revisionNote: row.revisionNote,
    planId: envelope.data.planId,
    planHash: envelope.data.planHash,
    recommendationHash: row.recommendationHash,
    draft: envelope.data.draft,
  });
  if (!draft.success) {
    return null;
  }
  if (IsoUtcDateTime.safeParse(row.updatedAt).success === false) {
    return null;
  }
  return {
    jobId,
    revision: row.revision,
    draft: draft.data,
    recommendations,
    lastRequestId: row.lastRequestId,
    lastSubmittedRevision: row.lastSubmittedRevision,
    updatedAt: row.updatedAt,
  };
}

/**
 * S2-CP-B v3 view: header from the row columns, plan binding +
 * draft from the stored v3 envelope. Unknown inner versions stay
 * corrupt (null) exactly like unparseable v1/v2 bytes.
 */
function parseWorkspaceRowV3(
  jobId: string,
  row: StoredWorkspaceRow,
  stored: unknown,
): WorkspaceViewV3Type | null {
  const envelope = WorkspaceStoredV3.safeParse(stored);
  if (!envelope.success) {
    return null;
  }
  let recommendations: RecommendationV1Type | null = null;
  if (row.recommendationsJson !== null) {
    const parsed = RecommendationV1.safeParse(parseJsonColumn(row.recommendationsJson));
    if (!parsed.success) {
      return null;
    }
    recommendations = parsed.data;
  }
  const draft = WorkspacePutV3.safeParse({
    schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
    extractionId: row.extractionId,
    profileId: row.profileId,
    profileVersionId: row.profileVersionId,
    requestKind: row.requestKind,
    parentVersionId: row.parentVersionId,
    revisionNote: row.revisionNote,
    planId: envelope.data.planId,
    planHash: envelope.data.planHash,
    recommendationHash: row.recommendationHash,
    draft: envelope.data.draft,
  });
  if (!draft.success) {
    return null;
  }
  if (IsoUtcDateTime.safeParse(row.updatedAt).success === false) {
    return null;
  }
  return {
    jobId,
    revision: row.revision,
    draft: draft.data,
    recommendations,
    lastRequestId: row.lastRequestId,
    lastSubmittedRevision: row.lastSubmittedRevision,
    updatedAt: row.updatedAt,
  };
}

export interface SaveWorkspaceDeps {
  now?: () => string;
  recommendations: WorkspaceRecommendationsProvider;
}

/**
 * Transaction W (contracts §4.1): revision-CAS draft save.
 *
 * Phase 1 (outside the transaction): existence/ownership reads for
 * the build, deterministic recommendation build, client-hash
 * equality, and focus validation. Phase 2 (one short transaction):
 * recheck job/extraction/profile active ownership, re-verify the
 * hash over the phase-1 object (same binding ⟹ same bytes, because
 * extractions, version payloads, and approved facts are immutable),
 * check parent ownership, and CAS the revision.
 *
 * Binding rules: an incomplete binding stores no snapshot and the
 * client hash must be null (else 409); selections without a binding
 * are 422. A complete binding normally requires the client's hash
 * to equal the fresh build (else 409) — except an empty focus with
 * a null hash and unbuildable recommendations (missing JD), which
 * saves with an honest null snapshot so reading/editing stays
 * possible. W never bumps the job version and never touches
 * queue/review state.
 */
export function saveWorkspace(
  handle: DatabaseHandle,
  jobId: string,
  observedRevision: number,
  body: WorkspacePutType,
  deps: SaveWorkspaceDeps,
): WorkspaceResult {
  const now = deps.now?.() ?? utcNow();
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  const bindingComplete =
    body.extractionId !== null && body.profileId !== null && body.profileVersionId !== null;

  let recommendations: RecommendationV1Type | null = null;
  if (!bindingComplete) {
    if (body.recommendationHash !== null) {
      return fail("input-stale", "recommendation hash requires a complete binding", {
        field: "recommendationHash",
      });
    }
  } else {
    const extractionId = body.extractionId as string;
    const profileId = body.profileId as string;
    const profileVersionId = body.profileVersionId as string;
    const extraction = handle.db
      .select()
      .from(jobExtractions)
      .where(eq(jobExtractions.id, extractionId))
      .get();
    if (extraction === undefined || extraction.jobId !== jobId) {
      return fail("not-found", `extraction ${extractionId} does not belong to job ${jobId}`, {
        field: "extractionId",
      });
    }
    const version = getProfileVersion(handle, profileVersionId);
    if (version === null || version.profileId !== profileId) {
      return fail(
        "not-found",
        `profile version ${profileVersionId} does not belong to profile ${profileId}`,
        { field: "profileVersionId" },
      );
    }
    const built = deps.recommendations.getRecommendations(handle, {
      jobId,
      extractionId,
      profileVersionId,
    });
    if (!built.ok) {
      if (built.error === "storage-unavailable") {
        return fail("storage-unavailable", built.detail);
      }
      const focusEmpty =
        body.focus.selectedPhraseIds.length === 0 &&
        body.focus.mappings.length === 0 &&
        body.focus.themeId === null;
      if (!focusEmpty || body.recommendationHash !== null) {
        return fail("input-stale", built.detail, { field: "recommendationHash" });
      }
      recommendations = null;
    } else {
      recommendations = built.recommendations;
      if (body.recommendationHash === null) {
        return fail("input-stale", "save with a complete binding must send the shown recommendation hash", {
          field: "recommendationHash",
        });
      }
      if (hashRecommendation(recommendations) !== body.recommendationHash) {
        return fail("input-stale", "recommendation hash does not match the current binding", {
          field: "recommendationHash",
        });
      }
    }
  }

  const issues = validateFocusSelection(body.focus, recommendations);
  if (issues.length > 0) {
    const first = issues[0] as { code: string; field: string; detail: string };
    return fail("invalid-selection", `${first.code}: ${first.detail}`, { field: first.field });
  }

  return withTransaction(handle.sqlite, () => {
    const current = getTailoringJob(handle, jobId);
    if (current === null) {
      return fail("unknown-job", `job ${jobId} does not exist`);
    }
    if (bindingComplete) {
      if (current.activeExtractionId !== body.extractionId) {
        return fail("input-stale", "binding extraction is no longer the job's active extraction", {
          field: "extractionId",
        });
      }
      const active = getActiveProfileVersion(handle, body.profileId as string);
      if (active === null || active.id !== body.profileVersionId) {
        return fail("input-stale", "binding profile version is no longer active", {
          field: "profileVersionId",
        });
      }
      if (recommendations !== null && body.recommendationHash !== null) {
        if (hashRecommendation(recommendations) !== body.recommendationHash) {
          return fail("input-stale", "recommendation hash does not match the current binding", {
            field: "recommendationHash",
          });
        }
      }
    }
    if (body.parentVersionId !== null) {
      const parent = handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, body.parentVersionId))
        .get();
      if (parent === undefined || parent.jobId !== jobId) {
        return fail(
          "not-found",
          `parent version ${body.parentVersionId} does not belong to job ${jobId}`,
          { field: "parentVersionId" },
        );
      }
    }
    const saved = saveWorkspaceCAS(handle, {
      jobId,
      observedRevision,
      extractionId: body.extractionId,
      profileId: body.profileId,
      profileVersionId: body.profileVersionId,
      requestKind: body.requestKind,
      parentVersionId: body.parentVersionId,
      revisionNote: body.revisionNote,
      focusJson: canonicalJson(body.focus),
      recommendationsJson: recommendations === null ? null : canonicalJson(recommendations),
      recommendationHash: recommendations === null ? null : body.recommendationHash,
      now,
    });
    if (!saved.ok) {
      return fail("workspace-conflict", "workspace revision changed since the edit began", {
        currentWorkspaceRevision: saved.currentRevision,
      });
    }
    const stored = readWorkspace(handle, jobId);
    if (stored === null) {
      return fail("storage-unavailable", "workspace row missing immediately after save");
    }
    const view = parseWorkspaceRow(jobId, stored);
    if (view === null) {
      return fail("storage-unavailable", "saved workspace draft failed strict validation");
    }
    return {
      ok: true,
      value: {
        workspace: view,
        revision: saved.revision,
        etag: buildWorkspaceETag(jobId, saved.revision),
        created: saved.created,
      },
    } as const;
  });
}

interface Step2OperationIssue {
  code: string;
  field: string;
  detail: string;
}

/**
 * S2-C op collapse (contracts §1.4): a second `add` for the same
 * `suggestionId`+`roleId` collapses to the existing operation id
 * instead of appending, and a repeated `exclude` is a no-op. Stable:
 * surviving ops keep their submitted relative order. Generic over
 * the v1/v2 op shapes, which share these fields.
 */
function collapseStep2Operations<T extends Step2DraftOperationV1Type | Step2DraftOperationV2Type>(
  operations: T[],
): T[] {
  const seenAdd = new Set<string>();
  const seenExclude = new Set<string>();
  const collapsed: T[] = [];
  for (const op of operations) {
    if (op.op === "add") {
      const key = JSON.stringify([op.suggestionId, op.roleId]);
      if (seenAdd.has(key)) {
        continue;
      }
      seenAdd.add(key);
    } else if (op.op === "exclude") {
      if (seenExclude.has(op.targetFactId)) {
        continue;
      }
      seenExclude.add(op.targetFactId);
    }
    collapsed.push(op);
  }
  return collapsed;
}

/**
 * S2-C v2 op semantics (contracts §1.4, §4): adds/replaces name
 * usable plan suggestions in known employment roles; fact
 * references name approved captured facts; a suggestion edit
 * applies to an added instance. First issue wins, with `draft.*`
 * field paths for the 422 envelope.
 */
function validateStep2Operations(input: {
  plan: PreparationPlanV1Type;
  approvedFactIds: ReadonlySet<string>;
  employmentIds: ReadonlySet<string>;
  operations: Step2DraftOperationV1Type[];
}): Step2OperationIssue | null {
  const suggestions = new Map(
    input.plan.suggestions.map((suggestion) => [suggestion.suggestionId, suggestion]),
  );
  const addedSuggestions = new Set<string>();
  for (const op of input.operations) {
    if (op.op === "add") {
      addedSuggestions.add(op.suggestionId);
    } else if (op.op === "replace" && op.suggestionId !== null) {
      addedSuggestions.add(op.suggestionId);
    }
  }
  for (const [index, op] of input.operations.entries()) {
    const at = `draft.operations[${index}]`;
    if (op.op === "add" || op.op === "replace") {
      if (!input.employmentIds.has(op.roleId)) {
        return {
          code: "UNKNOWN_ROLE",
          field: `${at}.roleId`,
          detail: `role '${op.roleId}' is not an employment of the captured profile`,
        };
      }
      const suggestionId = op.op === "add" ? op.suggestionId : op.suggestionId;
      if (suggestionId !== null) {
        const suggestion = suggestions.get(suggestionId);
        if (suggestion === undefined) {
          return {
            code: "UNKNOWN_SUGGESTION",
            field: `${at}.suggestionId`,
            detail: `suggestion '${suggestionId}' is not in the bound plan`,
          };
        }
        if (!suggestion.usable) {
          return {
            code: "UNUSABLE_SUGGESTION",
            field: `${at}.suggestionId`,
            detail: `suggestion '${suggestionId}' is not usable (${suggestion.unusableReason ?? "no reason recorded"})`,
          };
        }
      }
      if (op.op === "replace" && !input.approvedFactIds.has(op.targetFactId)) {
        return {
          code: "UNKNOWN_FACT",
          field: `${at}.targetFactId`,
          detail: `fact '${op.targetFactId}' is not approved captured evidence`,
        };
      }
    } else if (op.op === "exclude") {
      if (!input.approvedFactIds.has(op.targetFactId)) {
        return {
          code: "UNKNOWN_FACT",
          field: `${at}.targetFactId`,
          detail: `fact '${op.targetFactId}' is not approved captured evidence`,
        };
      }
    } else if (op.target.kind === "suggestion") {
      const suggestion = suggestions.get(op.target.suggestionId);
      if (suggestion === undefined) {
        return {
          code: "UNKNOWN_SUGGESTION",
          field: `${at}.target.suggestionId`,
          detail: `suggestion '${op.target.suggestionId}' is not in the bound plan`,
        };
      }
      if (!addedSuggestions.has(op.target.suggestionId)) {
        return {
          code: "NO_ADDED_INSTANCE",
          field: `${at}.target.suggestionId`,
          detail: `suggestion '${op.target.suggestionId}' has no added instance in this draft`,
        };
      }
    } else if (!input.approvedFactIds.has(op.target.factId)) {
      return {
        code: "UNKNOWN_FACT",
        field: `${at}.target.factId`,
        detail: `fact '${op.target.factId}' is not approved captured evidence`,
      };
    }
  }
  return null;
}

/**
 * S2-CP-B v3 op semantics (correction contracts §1.4, §4.2, §7.3):
 * v2 op checks plus server-derived eligibility — every op roleId
 * must belong to the eligible set derived from its anchors
 * (master-bullet ops in their own role, suggestion ops in an
 * eligible role) — and summary-origin checks against the bound
 * plan's angles. User-authored text (editedText, edit ops,
 * replace-with-text) is never evidence-blocked here: only
 * structural, ownership, size, and binding failures refuse the
 * save. First issue wins, with `draft.*` field paths.
 */
function validateStep2OperationsV2(input: {
  plan: PreparationPlanV2Type;
  approvedFactIds: ReadonlySet<string>;
  employmentIds: ReadonlySet<string>;
  employmentByFactId: ReadonlyMap<string, string | null>;
  summaryOrigin: "master" | "angle-1" | "angle-2";
  operations: Step2DraftOperationV2Type[];
}): Step2OperationIssue | null {
  if (input.summaryOrigin !== "master") {
    const angle = input.plan.positioning.angles.find(
      (entry) => entry.angleId === input.summaryOrigin,
    );
    if (angle === undefined) {
      return {
        code: "UNKNOWN_ORIGIN",
        field: "draft.summaryOrigin",
        detail: `summary origin '${input.summaryOrigin}' names no angle of the bound plan`,
      };
    }
  }
  const suggestions = new Map(
    input.plan.suggestions.map((suggestion) => [suggestion.suggestionId, suggestion]),
  );
  const eligibleBySuggestion = new Map<string, string[]>();
  for (const suggestion of input.plan.suggestions) {
    eligibleBySuggestion.set(
      suggestion.suggestionId,
      deriveEligibleRoles({
        citedFactIds: suggestion.factIds,
        employmentByFactId: input.employmentByFactId,
        employmentIds: [...input.employmentIds],
      }).eligibleRoleIds,
    );
  }
  const addedSuggestions = new Set<string>();
  for (const op of input.operations) {
    if (op.op === "add") {
      addedSuggestions.add(op.suggestionId);
    } else if (op.op === "replace" && op.suggestionId !== null) {
      addedSuggestions.add(op.suggestionId);
    }
  }
  const eligibleFor = (citedFactIds: string[]): string[] =>
    deriveEligibleRoles({
      citedFactIds,
      employmentByFactId: input.employmentByFactId,
      employmentIds: [...input.employmentIds],
    }).eligibleRoleIds;
  for (const [index, op] of input.operations.entries()) {
    const at = `draft.operations[${index}]`;
    if (op.op === "add" || op.op === "replace") {
      if (!input.employmentIds.has(op.roleId)) {
        return {
          code: "UNKNOWN_ROLE",
          field: `${at}.roleId`,
          detail: `role '${op.roleId}' is not an employment of the captured profile`,
        };
      }
      const suggestionId = op.op === "add" ? op.suggestionId : op.suggestionId;
      if (suggestionId !== null) {
        const suggestion = suggestions.get(suggestionId);
        if (suggestion === undefined) {
          return {
            code: "UNKNOWN_SUGGESTION",
            field: `${at}.suggestionId`,
            detail: `suggestion '${suggestionId}' is not in the bound plan`,
          };
        }
        if (!suggestion.usable) {
          return {
            code: "UNUSABLE_SUGGESTION",
            field: `${at}.suggestionId`,
            detail: `suggestion '${suggestionId}' is not usable (${suggestion.unusableReason ?? "no reason recorded"})`,
          };
        }
        const eligible = eligibleBySuggestion.get(suggestionId) ?? [];
        if (!eligible.includes(op.roleId)) {
          return {
            code: "FOREIGN_ROLE",
            field: `${at}.roleId`,
            detail: `role '${op.roleId}' owns none of suggestion '${suggestionId}' cited employment facts`,
          };
        }
      } else if (op.op === "replace") {
        if (!input.approvedFactIds.has(op.targetFactId)) {
          return {
            code: "UNKNOWN_FACT",
            field: `${at}.targetFactId`,
            detail: `fact '${op.targetFactId}' is not approved captured evidence`,
          };
        }
        if (!eligibleFor([op.targetFactId]).includes(op.roleId)) {
          return {
            code: "FOREIGN_ROLE",
            field: `${at}.roleId`,
            detail: `role '${op.roleId}' does not own fact '${op.targetFactId}'`,
          };
        }
      }
      if (op.op === "replace" && !input.approvedFactIds.has(op.targetFactId)) {
        return {
          code: "UNKNOWN_FACT",
          field: `${at}.targetFactId`,
          detail: `fact '${op.targetFactId}' is not approved captured evidence`,
        };
      }
    } else if (op.op === "exclude") {
      if (!input.approvedFactIds.has(op.targetFactId)) {
        return {
          code: "UNKNOWN_FACT",
          field: `${at}.targetFactId`,
          detail: `fact '${op.targetFactId}' is not approved captured evidence`,
        };
      }
    } else if (op.target.kind === "suggestion") {
      const suggestion = suggestions.get(op.target.suggestionId);
      if (suggestion === undefined) {
        return {
          code: "UNKNOWN_SUGGESTION",
          field: `${at}.target.suggestionId`,
          detail: `suggestion '${op.target.suggestionId}' is not in the bound plan`,
        };
      }
      if (!addedSuggestions.has(op.target.suggestionId)) {
        return {
          code: "NO_ADDED_INSTANCE",
          field: `${at}.target.suggestionId`,
          detail: `suggestion '${op.target.suggestionId}' has no added instance in this draft`,
        };
      }
    } else if (!input.approvedFactIds.has(op.target.factId)) {
      return {
        code: "UNKNOWN_FACT",
        field: `${at}.target.factId`,
        detail: `fact '${op.target.factId}' is not approved captured evidence`,
      };
    }
  }
  return null;
}

/**
 * Transaction W v2 (contracts §4–§5, §8.6–§8.7): revision-CAS save
 * of a plan-bound Step 2 editor draft. Same two phases as W v1
 * (build + verify outside, recheck + CAS inside one short
 * transaction) with three deliberate deltas: the captured profile
 * version is accepted without requiring active-ness (later
 * settings edits never invalidate captured work); the plan must be
 * the job's accepted plan over the active extraction (stale plan
 * writes are refused while the stored draft is preserved); and op
 * semantics are checked against the bound plan plus recomputed
 * captured evidence. A null draft is the saveable empty editor.
 * Saving v2 replaces the stored bytes wholesale — v1 and v2 never
 * merge. W never bumps the job version and never touches
 * queue/review state.
 */
export function saveWorkspaceV2(
  handle: DatabaseHandle,
  jobId: string,
  observedRevision: number,
  body: WorkspacePutV2Type,
  deps: SaveWorkspaceDeps,
): WorkspaceResult {
  const now = deps.now?.() ?? utcNow();
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  const bindingComplete =
    body.extractionId !== null && body.profileId !== null && body.profileVersionId !== null;

  if (body.extractionId !== null) {
    const extraction = handle.db
      .select()
      .from(jobExtractions)
      .where(eq(jobExtractions.id, body.extractionId))
      .get();
    if (extraction === undefined || extraction.jobId !== jobId) {
      return fail("not-found", `extraction ${body.extractionId} does not belong to job ${jobId}`, {
        field: "extractionId",
      });
    }
    if (job.activeExtractionId !== body.extractionId) {
      return fail("input-stale", "binding extraction is no longer the job's active extraction", {
        field: "extractionId",
      });
    }
  }
  if (body.profileId !== null) {
    const version = getProfileVersion(handle, body.profileVersionId as string);
    if (version === null || version.profileId !== body.profileId) {
      return fail(
        "not-found",
        `profile version ${body.profileVersionId} does not belong to profile ${body.profileId}`,
        { field: "profileVersionId" },
      );
    }
  }

  let recommendations: RecommendationV1Type | null = null;
  if (!bindingComplete) {
    if (body.recommendationHash !== null) {
      return fail("input-stale", "recommendation hash requires a complete binding", {
        field: "recommendationHash",
      });
    }
  } else if (body.recommendationHash !== null) {
    const built = deps.recommendations.getRecommendations(handle, {
      jobId,
      extractionId: body.extractionId as string,
      profileVersionId: body.profileVersionId as string,
    });
    if (!built.ok) {
      if (built.error === "storage-unavailable") {
        return fail("storage-unavailable", built.detail);
      }
      return fail("input-stale", built.detail, { field: "recommendationHash" });
    }
    recommendations = built.recommendations;
    if (hashRecommendation(recommendations) !== body.recommendationHash) {
      return fail("input-stale", "recommendation hash does not match the current binding", {
        field: "recommendationHash",
      });
    }
  }

  if (body.planId !== null) {
    const stored = readPlan(handle, body.planId);
    if (stored === null) {
      return fail("invalid-selection", `plan ${body.planId} does not exist`, { field: "planId" });
    }
    const preparation = readPreparationById(handle, stored.preparationId);
    if (preparation === null || preparation.jobId !== jobId) {
      return fail("invalid-selection", `plan ${body.planId} does not belong to job ${jobId}`, {
        field: "planId",
      });
    }
    if (stored.planHash !== body.planHash) {
      return fail("invalid-selection", "plan hash does not match the stored plan bytes", {
        field: "planHash",
      });
    }
    let plan: PreparationPlanV1Type;
    try {
      plan = PreparationPlanV1.parse(JSON.parse(stored.planJson) as unknown);
    } catch {
      return fail("storage-unavailable", "stored plan is unreadable");
    }
    const current = readPreparationByJob(handle, jobId);
    if (current === null || current.acceptedPlanId === null) {
      return fail("plan-stale", "job has no accepted plan yet; run preparation first");
    }
    if (current.acceptedPlanId !== body.planId) {
      return fail(
        "plan-stale",
        "a newer plan superseded this draft's plan; rebind before saving",
      );
    }
    if (plan.extractionId !== job.activeExtractionId) {
      return fail("plan-stale", "accepted plan predates the active job description", {
        field: "planId",
      });
    }
    if (
      body.profileId !== current.profileId ||
      body.profileVersionId !== current.profileVersionId
    ) {
      return fail("input-stale", "draft binding differs from the captured preparation binding", {
        field: "profileVersionId",
      });
    }
    const version = getProfileVersion(handle, current.profileVersionId);
    if (version === null) {
      return fail("input-stale", "captured profile version is gone", {
        field: "profileVersionId",
      });
    }
    let payload: ReturnType<typeof parseStoredProfilePayload>;
    try {
      payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
    } catch {
      return fail("storage-unavailable", "captured profile payload is unreadable");
    }
    const payloadHash = sha256HexUtf8(canonicalJson(payload));
    if (payloadHash !== current.profilePayloadHash) {
      return fail("input-stale", "captured profile payload drifted from the binding", {
        field: "profileVersionId",
      });
    }
    const employmentOf = new Map<string, string>();
    for (const achievement of payload.achievements) {
      if (achievement.employmentId !== undefined) {
        employmentOf.set(achievement.factId, achievement.employmentId);
      }
    }
    const approved = listFactsByVersion(handle, version.id)
      .filter((fact) => fact.verification === "APPROVED")
      .map((fact) => ({
        factId: fact.factId,
        statement: fact.statement,
        employmentId: employmentOf.get(fact.factId) ?? null,
      }));
    if (approved.length === 0) {
      return fail("input-stale", "captured profile has no approved evidence left", {
        field: "profileVersionId",
      });
    }
    if (
      evidenceHashFor({ profileVersionId: version.id, payloadHash, approved }) !==
      current.evidenceHash
    ) {
      return fail("input-stale", "captured evidence drifted from the binding", {
        field: "profileVersionId",
      });
    }
    const approvedFactIds = new Set(approved.map((fact) => fact.factId));
    const employmentIds = new Set(payload.employment.map((entry) => entry.id));
    if (body.draft !== null) {
      if (body.draft.planId !== body.planId || body.draft.planHash !== body.planHash) {
        return fail("invalid-selection", "draft plan binding differs from the header binding", {
          field: "draft.planId",
        });
      }
      const collapsed = collapseStep2Operations(body.draft.operations);
      const issue = validateStep2Operations({
        plan,
        approvedFactIds,
        employmentIds,
        operations: collapsed,
      });
      if (issue !== null) {
        return fail("invalid-selection", `${issue.code}: ${issue.detail}`, { field: issue.field });
      }
    }
  }

  const collapsedDraft =
    body.draft === null
      ? null
      : { ...body.draft, operations: collapseStep2Operations(body.draft.operations) };

  return withTransaction(handle.sqlite, () => {
    const current = getTailoringJob(handle, jobId);
    if (current === null) {
      return fail("unknown-job", `job ${jobId} does not exist`);
    }
    if (body.extractionId !== null && current.activeExtractionId !== body.extractionId) {
      return fail("input-stale", "binding extraction is no longer the job's active extraction", {
        field: "extractionId",
      });
    }
    if (body.planId !== null) {
      const raced = readPreparationByJob(handle, jobId);
      if (raced === null || raced.acceptedPlanId !== body.planId) {
        return fail(
          "plan-stale",
          "a newer plan superseded this draft's plan; rebind before saving",
        );
      }
    }
    if (body.parentVersionId !== null) {
      const parent = handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, body.parentVersionId))
        .get();
      if (parent === undefined || parent.jobId !== jobId) {
        return fail(
          "not-found",
          `parent version ${body.parentVersionId} does not belong to job ${jobId}`,
          { field: "parentVersionId" },
        );
      }
    }
    const saved = saveWorkspaceCAS(handle, {
      jobId,
      observedRevision,
      extractionId: body.extractionId,
      profileId: body.profileId,
      profileVersionId: body.profileVersionId,
      requestKind: body.requestKind,
      parentVersionId: body.parentVersionId,
      revisionNote: body.revisionNote,
      focusJson: canonicalJson({
        schemaVersion: STEP2_SCHEMA_VERSIONS.workspace,
        planId: body.planId,
        planHash: body.planHash,
        draft: collapsedDraft,
      }),
      recommendationsJson: recommendations === null ? null : canonicalJson(recommendations),
      recommendationHash: recommendations === null ? null : body.recommendationHash,
      now,
    });
    if (!saved.ok) {
      return fail("workspace-conflict", "workspace revision changed since the edit began", {
        currentWorkspaceRevision: saved.currentRevision,
      });
    }
    const stored = readWorkspace(handle, jobId);
    if (stored === null) {
      return fail("storage-unavailable", "workspace row missing immediately after save");
    }
    const view = parseWorkspaceRow(jobId, stored);
    if (view === null) {
      return fail("storage-unavailable", "saved workspace draft failed strict validation");
    }
    return {
      ok: true,
      value: {
        workspace: view,
        revision: saved.revision,
        etag: buildWorkspaceETag(jobId, saved.revision),
        created: saved.created,
      },
    } as const;
  });
}

/**
 * Transaction W v3 (correction contracts §4.2): revision-CAS save
 * of an origin-stable v2 editor draft bound to an accepted v2
 * plan. Same two phases as W v2 (build + verify outside, recheck
 * + CAS inside one short transaction) with correction deltas: the
 * plan must be v2 over the active extraction (a v1 accepted plan
 * refuses 409 PLAN_STALE while the stored draft is preserved);
 * every op roleId must belong to the server-derived eligible set;
 * the summary origin must name master or a plan angle. The
 * workspace stores operations only — provenance is derived, never
 * written here. Saving v3 replaces the stored bytes wholesale —
 * versions never merge. W never bumps the job version and never
 * touches queue/review state.
 */
export function saveWorkspaceV3(
  handle: DatabaseHandle,
  jobId: string,
  observedRevision: number,
  body: WorkspacePutV3Type,
  deps: SaveWorkspaceDeps,
): WorkspaceResult {
  const now = deps.now?.() ?? utcNow();
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  const bindingComplete =
    body.extractionId !== null && body.profileId !== null && body.profileVersionId !== null;

  if (body.extractionId !== null) {
    const extraction = handle.db
      .select()
      .from(jobExtractions)
      .where(eq(jobExtractions.id, body.extractionId))
      .get();
    if (extraction === undefined || extraction.jobId !== jobId) {
      return fail("not-found", `extraction ${body.extractionId} does not belong to job ${jobId}`, {
        field: "extractionId",
      });
    }
    if (job.activeExtractionId !== body.extractionId) {
      return fail("input-stale", "binding extraction is no longer the job's active extraction", {
        field: "extractionId",
      });
    }
  }
  if (body.profileId !== null) {
    const version = getProfileVersion(handle, body.profileVersionId as string);
    if (version === null || version.profileId !== body.profileId) {
      return fail(
        "not-found",
        `profile version ${body.profileVersionId} does not belong to profile ${body.profileId}`,
        { field: "profileVersionId" },
      );
    }
  }

  let recommendations: RecommendationV1Type | null = null;
  if (!bindingComplete) {
    if (body.recommendationHash !== null) {
      return fail("input-stale", "recommendation hash requires a complete binding", {
        field: "recommendationHash",
      });
    }
  } else if (body.recommendationHash !== null) {
    const built = deps.recommendations.getRecommendations(handle, {
      jobId,
      extractionId: body.extractionId as string,
      profileVersionId: body.profileVersionId as string,
    });
    if (!built.ok) {
      if (built.error === "storage-unavailable") {
        return fail("storage-unavailable", built.detail);
      }
      return fail("input-stale", built.detail, { field: "recommendationHash" });
    }
    recommendations = built.recommendations;
    if (hashRecommendation(recommendations) !== body.recommendationHash) {
      return fail("input-stale", "recommendation hash does not match the current binding", {
        field: "recommendationHash",
      });
    }
  }

  if (body.planId !== null) {
    const stored = readPlan(handle, body.planId);
    if (stored === null) {
      return fail("invalid-selection", `plan ${body.planId} does not exist`, { field: "planId" });
    }
    const preparation = readPreparationById(handle, stored.preparationId);
    if (preparation === null || preparation.jobId !== jobId) {
      return fail("invalid-selection", `plan ${body.planId} does not belong to job ${jobId}`, {
        field: "planId",
      });
    }
    if (stored.planHash !== body.planHash) {
      return fail("invalid-selection", "plan hash does not match the stored plan bytes", {
        field: "planHash",
      });
    }
    const parsed = parseStoredPlan(stored.planJson);
    if (parsed === null) {
      return fail("storage-unavailable", "stored plan is unreadable");
    }
    if (parsed.version !== 2) {
      return fail(
        "plan-stale",
        "accepted plan predates correction editing; run preparation first",
      );
    }
    const plan = parsed.plan;
    const current = readPreparationByJob(handle, jobId);
    if (current === null || current.acceptedPlanId === null) {
      return fail("plan-stale", "job has no accepted plan yet; run preparation first");
    }
    if (current.acceptedPlanId !== body.planId) {
      return fail(
        "plan-stale",
        "a newer plan superseded this draft's plan; rebind before saving",
      );
    }
    if (plan.extractionId !== job.activeExtractionId) {
      return fail("plan-stale", "accepted plan predates the active job description", {
        field: "planId",
      });
    }
    if (
      body.profileId !== current.profileId ||
      body.profileVersionId !== current.profileVersionId
    ) {
      return fail("input-stale", "draft binding differs from the captured preparation binding", {
        field: "profileVersionId",
      });
    }
    const version = getProfileVersion(handle, current.profileVersionId);
    if (version === null) {
      return fail("input-stale", "captured profile version is gone", {
        field: "profileVersionId",
      });
    }
    let payload: ReturnType<typeof parseStoredProfilePayload>;
    try {
      payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
    } catch {
      return fail("storage-unavailable", "captured profile payload is unreadable");
    }
    const payloadHash = sha256HexUtf8(canonicalJson(payload));
    if (payloadHash !== current.profilePayloadHash) {
      return fail("input-stale", "captured profile payload drifted from the binding", {
        field: "profileVersionId",
      });
    }
    const employmentOf = new Map<string, string>();
    for (const achievement of payload.achievements) {
      if (achievement.employmentId !== undefined) {
        employmentOf.set(achievement.factId, achievement.employmentId);
      }
    }
    const approved = listFactsByVersion(handle, version.id)
      .filter((fact) => fact.verification === "APPROVED")
      .map((fact) => ({
        factId: fact.factId,
        statement: fact.statement,
        employmentId: employmentOf.get(fact.factId) ?? null,
      }));
    if (approved.length === 0) {
      return fail("input-stale", "captured profile has no approved evidence left", {
        field: "profileVersionId",
      });
    }
    if (
      evidenceHashFor({ profileVersionId: version.id, payloadHash, approved }) !==
      current.evidenceHash
    ) {
      return fail("input-stale", "captured evidence drifted from the binding", {
        field: "profileVersionId",
      });
    }
    const approvedFactIds = new Set(approved.map((fact) => fact.factId));
    const employmentIds = new Set(payload.employment.map((entry) => entry.id));
    const employmentByFactId = new Map<string, string | null>();
    for (const achievement of payload.achievements) {
      employmentByFactId.set(achievement.factId, achievement.employmentId ?? null);
    }
    if (body.draft !== null) {
      if (body.draft.planId !== body.planId || body.draft.planHash !== body.planHash) {
        return fail("invalid-selection", "draft plan binding differs from the header binding", {
          field: "draft.planId",
        });
      }
      const collapsed = collapseStep2Operations(body.draft.operations);
      const issue = validateStep2OperationsV2({
        plan,
        approvedFactIds,
        employmentIds,
        employmentByFactId,
        summaryOrigin: body.draft.summaryOrigin,
        operations: collapsed,
      });
      if (issue !== null) {
        return fail("invalid-selection", `${issue.code}: ${issue.detail}`, { field: issue.field });
      }
    }
  }

  const collapsedDraft =
    body.draft === null
      ? null
      : { ...body.draft, operations: collapseStep2Operations(body.draft.operations) };

  return withTransaction(handle.sqlite, () => {
    const current = getTailoringJob(handle, jobId);
    if (current === null) {
      return fail("unknown-job", `job ${jobId} does not exist`);
    }
    if (body.extractionId !== null && current.activeExtractionId !== body.extractionId) {
      return fail("input-stale", "binding extraction is no longer the job's active extraction", {
        field: "extractionId",
      });
    }
    if (body.planId !== null) {
      const raced = readPreparationByJob(handle, jobId);
      if (raced === null || raced.acceptedPlanId !== body.planId) {
        return fail(
          "plan-stale",
          "a newer plan superseded this draft's plan; rebind before saving",
        );
      }
    }
    if (body.parentVersionId !== null) {
      const parent = handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, body.parentVersionId))
        .get();
      if (parent === undefined || parent.jobId !== jobId) {
        return fail(
          "not-found",
          `parent version ${body.parentVersionId} does not belong to job ${jobId}`,
          { field: "parentVersionId" },
        );
      }
    }
    const saved = saveWorkspaceCAS(handle, {
      jobId,
      observedRevision,
      extractionId: body.extractionId,
      profileId: body.profileId,
      profileVersionId: body.profileVersionId,
      requestKind: body.requestKind,
      parentVersionId: body.parentVersionId,
      revisionNote: body.revisionNote,
      focusJson: canonicalJson({
        schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
        planId: body.planId,
        planHash: body.planHash,
        draft: collapsedDraft,
      }),
      recommendationsJson: recommendations === null ? null : canonicalJson(recommendations),
      recommendationHash: recommendations === null ? null : body.recommendationHash,
      now,
    });
    if (!saved.ok) {
      return fail("workspace-conflict", "workspace revision changed since the edit began", {
        currentWorkspaceRevision: saved.currentRevision,
      });
    }
    const stored = readWorkspace(handle, jobId);
    if (stored === null) {
      return fail("storage-unavailable", "workspace row missing immediately after save");
    }
    const view = parseWorkspaceRow(jobId, stored);
    if (view === null) {
      return fail("storage-unavailable", "saved workspace draft failed strict validation");
    }
    return {
      ok: true,
      value: {
        workspace: view,
        revision: saved.revision,
        etag: buildWorkspaceETag(jobId, saved.revision),
        created: saved.created,
      },
    } as const;
  });
}

export interface VersionSummary {
  id: string;
  version: number;
  profileDisplayName: string | null;
  reviewState: string;
  createdAt: string;
  selectedApproved: boolean;
  latestPublished: boolean;
}

export interface ListVersionsDeps {
  cursor?: string;
  limit?: number;
}

export type ListVersionsResult =
  | { ok: true; versions: VersionSummary[]; nextCursor: string | null }
  | { ok: false; failure: WorkspaceFailure };

interface VersionsCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: VersionsCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): VersionsCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return null;
  }
  const [createdAt, id] = parsed as [unknown, unknown];
  if (typeof createdAt !== "string" || typeof id !== "string") {
    return null;
  }
  if (IsoUtcDateTime.safeParse(createdAt).success === false || id === "") {
    return null;
  }
  return { createdAt, id };
}

function parseFrozenDisplayName(steeringJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(steeringJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const displayName = (parsed as Record<string, unknown>)["profileDisplayName"];
  return typeof displayName === "string" && displayName !== "" ? displayName : null;
}

/**
 * Paginated version history (contracts §4): at most 4 statements
 * per page (job pointers; version page; frozen steering names;
 * live-lineage fallback only when needed). Newest first by
 * (created_at, id); the cursor carries both. Corrupt review state
 * or timestamps fail safe (503); unparseable steering degrades to
 * live names; unresolvable profiles report null display names.
 * Never loads artifact bodies.
 */
export function listVersionSummaries(
  handle: DatabaseHandle,
  jobId: string,
  deps: ListVersionsDeps = {},
): ListVersionsResult {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  const limit = deps.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return fail("invalid-request", "limit must be an integer between 1 and 50", {
      field: "limit",
    });
  }
  let cursor: VersionsCursor | null = null;
  if (deps.cursor !== undefined && deps.cursor !== "") {
    cursor = decodeCursor(deps.cursor);
    if (cursor === null) {
      return fail("invalid-request", "versions cursor is malformed", { field: "cursor" });
    }
  }
  const page = handle.db
    .select({
      id: resumeVersions.id,
      version: resumeVersions.version,
      reviewState: resumeVersions.reviewState,
      createdAt: resumeVersions.createdAt,
    })
    .from(resumeVersions)
    .where(
      and(
        eq(resumeVersions.jobId, jobId),
        cursor === null
          ? undefined
          : or(
              lt(resumeVersions.createdAt, cursor.createdAt),
              and(
                eq(resumeVersions.createdAt, cursor.createdAt),
                lt(resumeVersions.id, cursor.id),
              ),
            ),
      ),
    )
    .orderBy(desc(resumeVersions.createdAt), desc(resumeVersions.id))
    .limit(limit + 1)
    .all();
  const rows = page.slice(0, limit);
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor =
    page.length > limit && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  const frozen = new Map<string, string>();
  if (rows.length > 0) {
    const names = handle.db
      .select({
        versionId: resumeVersions.id,
        steeringJson: generationRequests.steeringSnapshotJson,
      })
      .from(resumeVersions)
      .innerJoin(
        generationRequests,
        eq(resumeVersions.generationRequestId, generationRequests.id),
      )
      .where(eq(resumeVersions.jobId, jobId))
      .all();
    for (const entry of names) {
      const displayName = parseFrozenDisplayName(entry.steeringJson);
      if (displayName !== null) {
        frozen.set(entry.versionId, displayName);
      }
    }
  }
  let live = new Map<string, string>();
  if (rows.some((row) => !frozen.has(row.id))) {
    live = new Map(
      handle.db
        .select({ versionId: resumeVersions.id, displayName: candidateProfiles.displayName })
        .from(resumeVersions)
        .innerJoin(jobAnalyses, eq(resumeVersions.analysisId, jobAnalyses.id))
        .innerJoin(
          candidateSnapshots,
          eq(jobAnalyses.candidateSnapshotId, candidateSnapshots.id),
        )
        .innerJoin(
          candidateProfileVersions,
          eq(candidateSnapshots.profileVersionId, candidateProfileVersions.id),
        )
        .innerJoin(
          candidateProfiles,
          eq(candidateProfileVersions.profileId, candidateProfiles.id),
        )
        .where(eq(resumeVersions.jobId, jobId))
        .all()
        .map((entry) => [entry.versionId, entry.displayName] as const),
    );
  }

  const versions: VersionSummary[] = [];
  for (const row of rows) {
    if (ReviewState.safeParse(row.reviewState).success === false) {
      return fail(
        "storage-unavailable",
        `version ${row.id} carries an unrecognized review state; inspect the row, do not trust it`,
      );
    }
    if (IsoUtcDateTime.safeParse(row.createdAt).success === false) {
      return fail(
        "storage-unavailable",
        `version ${row.id} carries an invalid timestamp; inspect the row, do not trust it`,
      );
    }
    versions.push({
      id: row.id,
      version: row.version,
      profileDisplayName: frozen.get(row.id) ?? live.get(row.id) ?? null,
      reviewState: row.reviewState,
      createdAt: row.createdAt,
      selectedApproved: job.selectedResumeVersionId === row.id,
      latestPublished: job.activeResumeVersionId === row.id,
    });
  }
  return { ok: true, versions, nextCursor };
}
