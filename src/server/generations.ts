import { z } from "zod";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import { getProfile, getProfileVersion, getSourceByVersion } from "../db/candidates";
import { getGenerationRequest, getLiveGenerationRequest } from "../db/generation";
import { getActiveProfileVersion, listFactsByVersion } from "../db/candidates";
import { generationRequests } from "../db/schema/generation";
import { workItems } from "../db/schema/queue";
import { jobExtractions, resumeReviews, resumeVersions } from "../db/schema";
import { casJobTailoringState, getTailoringJob } from "../db/tailoring";
import {
  insertRequestInputs,
  markWorkspaceSubmitted,
  readRequestInputs,
  readWorkspace,
} from "../db/tailoringWorkspace";
import {
  insertDraftValidation,
  insertStep2GenerationInputs,
  parseStoredPlan,
  parseStoredValidation,
  readDraftValidationsByHash,
  readPlan,
  readPreparationByJob,
} from "../db/step2";
import { withTransaction } from "../db/transactions";
import { newId, sha256HexUtf8, utcNow } from "../db/utils";
import type { StoredProfilePayload } from "../domain/candidate";
import { parseStoredProfilePayload } from "../domain/candidate";
import { canonicalJson, canonicalText } from "../domain/canonical";
import { EntityId, IsoUtcDateTime, RowVersion } from "../domain/fields";
import { renderMasterMarkdown } from "../domain/master-preview";
import { parseStoredExtraction } from "../domain/extraction";
import {
  PreparationPlanV1,
  STEP2_SCHEMA_VERSIONS,
  Step2EditedInputsV1,
  Step2ValidationV1,
  WorkspaceStoredV2,
  applyEditedBullets,
  deriveStep2Segments,
  masterBulletsByRole,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type Step2DraftV1 as Step2DraftV1Type,
  type Step2PolicyVersionsV1 as Step2PolicyVersionsV1Type,
  type Step2ValidationV1 as Step2ValidationV1Type,
} from "../domain/step2";
import type { Step2SnapshotFact } from "../domain/step2Claims";
import {
  STEP2_CORRECTION_VERSIONS,
  Step2EditedInputsV2,
  WorkspaceStoredV3,
  deriveCorrectionSegments,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2DraftV2 as Step2DraftV2Type,
  type Step2PolicyVersionsV2 as Step2PolicyVersionsV2Type,
  type Step2ProvenanceEntryV2 as Step2ProvenanceEntryV2Type,
  type Step2ValidationV2 as Step2ValidationV2Type,
} from "../domain/step2Correction";
import {
  FocusV1,
  type FocusV1 as FocusV1Type,
  type RecommendationV1 as RecommendationV1Type,
} from "../domain/tailoringWorkspace";
import {
  getOrCreateCandidateSnapshot,
  getOrCreateJdSnapshot,
  isUniqueViolation,
} from "./candidates";
import {
  getTailoringReadiness,
  resolveRecommendationBinding,
} from "./recommendations";
import { resumeIdentityHash, storedArtifactDigests } from "./resumeDigests";
import { buildRecommendations } from "../tailoring/recommendations";
import {
  generationRequestIdentity,
  hashGenerationRequest,
  canonicalKeywordSet,
  SteeringSnapshotV1,
} from "../tailoring/requests";
import {
  TAILOR_QUEUE_SCHEMA_VERSION_V3,
  TailorQueuePayloadV3,
  hashGenerationRequestV3,
  hashRecommendation,
  hashSubmission,
  hashWorkflowRequestInput,
} from "../tailoring/requestsV3";
import {
  draftHashFor,
  hashStep2WorkflowInput,
  planHashFor,
  step2GenerationPolicies,
  validateStep2Segments,
  verifyStep2VerdictCoverage,
} from "../tailoring/step2policy";
import {
  correctionDraftHashFor,
  correctionManifestHashFor,
  correctionPlanHashFor,
  correctionSegmentNormalizedHashFor,
  correctionSegmentTextHashFor,
  hashStep2CorrectionWorkflowInput,
  step2CorrectionPolicies,
  validateCorrectionSegments,
  verifyCorrectionCoverage,
} from "../tailoring/step2CorrectionPolicy";
import { verifyCapturedEvidence } from "./preparation";

/**
 * v1.3 transaction G: atomic generation/revision submission
 * (WO-1.3-E, contracts §4.1). The client mints the operation UUID
 * once and submits the exact `GenerateBody` bytes; G freezes the
 * pinned workspace draft into immutable request inputs, dispatches
 * one v3 queue payload, CASes the job to PENDING, and stamps the
 * workspace — or writes nothing at all.
 *
 * Phase 0 runs outside any transaction: read-only resolution
 * (job, draft, binding), a fresh recommendation rebuild verified
 * against the draft hash, readiness, and the frozen master-text/1
 * projection. Phase 1 is one short synchronous transaction:
 * request lookup FIRST (identical submitHash replays byte-equal
 * with zero writes, even when FAILED; anything else with the same
 * ID fails closed with 409 IDEMPOTENCY_MISMATCH), then draft/job
 * CAS rechecks, liveness, active-pointer and source-hash
 * re-verification, state gate, idempotent snapshots, work
 * item → request → inputs in FK order, job CAS, workspace stamp,
 * and the atomic REVISION review extras.
 *
 * G reads the exact stored focus and binding — it never falls back
 * to the default profile and never rebuilds guidance. G enqueues
 * only; no provider call happens on this path (F executes).
 *
 * S2-D routes v2 edited drafts through the same transaction with an
 * edited-plan freeze: the accepted plan, exact draft bytes, and
 * verdicts are pinned into `step2_generation_inputs` beside the
 * v3 queue payload. Included needs-evidence text (422
 * UNRESOLVED_EVIDENCE) blocks with zero writes; bullet/summary
 * length guidance is advisory only and never blocks. Plan drift
 * fails 409 PLAN_STALE against the captured binding, never the
 * active pointers. 422 BUDGET_EXCEEDED now fires only for the
 * 64 KiB frozen-input byte cap (a payload-size protection, not a
 * bullet count).
 */

/** Frozen master-text/1 projection cap (contracts §3.1). */
export const MASTER_TEXT_MAX_UTF8_BYTES = 262144;

export const SubmitGenerationInput = z.object({
  jobId: EntityId,
  requestId: EntityId,
  workspaceRevision: z.int().positive(),
  observedRowVersion: RowVersion,
  actor: z.literal("human"),
  now: IsoUtcDateTime.optional(),
});
export type SubmitGenerationInput = z.infer<typeof SubmitGenerationInput>;

export type SubmitGenerationError =
  | "unknown-job"
  | "workspace-conflict"
  | "job-conflict"
  | "input-stale"
  | "generation-busy"
  | "idempotency-mismatch"
  | "profile-not-ready"
  | "jd-not-ready"
  | "provider-not-ready"
  | "plan-stale"
  | "unresolved-evidence"
  | "budget-exceeded"
  | "invalid-selection"
  | "storage-unavailable";

export interface SubmitGenerationFailure {
  error: SubmitGenerationError;
  detail: string;
  field?: string;
  currentWorkspaceRevision?: number;
  currentRowVersion?: number;
}

export type SubmitGenerationResult =
  | {
      ok: true;
      requestId: string;
      workItemId: string;
      status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
      replayed: boolean;
      jobRowVersion: number;
      workspaceRevision: number;
    }
  | { ok: false; failure: SubmitGenerationFailure };

export interface SubmitGenerationDeps {
  env?: Record<string, string | undefined>;
  /**
   * Test-only injection seam (E7): invoked after the queue INSERT
   * inside the transaction; a throw rolls everything back. No
   * production caller passes this.
   */
  testHooks?: { afterQueueInsert?: () => void };
}

function fail(
  error: SubmitGenerationError,
  detail: string,
  extra: Partial<SubmitGenerationFailure> = {},
): { ok: false; failure: SubmitGenerationFailure } {
  return { ok: false, failure: { error, detail, ...extra } };
}

interface FrozenDraftBase {
  extractionId: string;
  profileId: string;
  profileVersionId: string;
  requestKind: "INITIAL" | "NEW_VERSION" | "REVISION";
  parentVersionId: string | null;
  revisionNote: string | null;
  jdHash: string;
  canonicalJdText: string;
  payload: StoredProfilePayload;
  masterText: string;
  masterTextHash: string;
}

interface FrozenDraftV1 extends FrozenDraftBase {
  format: "v1";
  recommendationHash: string;
  focus: FocusV1Type;
  recommendations: RecommendationV1Type;
  profileHash: string;
  selectedTexts: string[];
}

interface FrozenDraftV2 extends FrozenDraftBase {
  format: "v2";
  planId: string;
  planHash: string;
  draftHash: string;
  draft: Step2DraftV1Type;
  plan: PreparationPlanV1Type;
  policies: Step2PolicyVersionsV1Type;
  editedInputsJson: string;
  /** Latest matching verdict row, when one already persists. */
  validationId: string | null;
  /** Freshly computed verdicts, persisted in-txn when no row matched. */
  computedValidation: Step2ValidationV1Type | null;
  profilePayloadHash: string;
  evidenceHash: string;
}

interface FrozenDraftV3 extends FrozenDraftBase {
  format: "v3";
  planId: string;
  planHash: string;
  draftHash: string;
  draft: Step2DraftV2Type;
  plan: PreparationPlanV2Type;
  policies: Step2PolicyVersionsV2Type;
  editedInputsJson: string;
  provenanceManifestHash: string;
  /** Latest matching verdict row, when one already persists. */
  validationId: string | null;
  /** Freshly computed verdicts, persisted in-txn when no row matched. */
  computedValidation: Step2ValidationV2Type | null;
  profilePayloadHash: string;
  evidenceHash: string;
}

type FrozenDraft = FrozenDraftV1 | FrozenDraftV2 | FrozenDraftV3;

function resolveFrozenDraft(
  handle: DatabaseHandle,
  jobId: string,
  workspaceRevision: number,
  env: Record<string, string | undefined>,
  now: string,
): { ok: true; draft: FrozenDraft; jobRowVersion: number } | { ok: false; failure: SubmitGenerationFailure } {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  const workspace = readWorkspace(handle, jobId);
  if (workspace === null || workspace.revision !== workspaceRevision) {
    return fail(
      "workspace-conflict",
      workspace === null
        ? `job ${jobId} has no workspace draft to submit`
        : `stale draft: workspace is at revision ${workspace.revision}`,
      { currentWorkspaceRevision: workspace?.revision ?? 0 },
    );
  }
  let focusRaw: unknown;
  try {
    focusRaw = JSON.parse(workspace.focusJson) as unknown;
  } catch {
    return fail(
      "storage-unavailable",
      "stored workspace focus failed strict validation; inspect the row, do not trust it",
    );
  }
  if (
    typeof focusRaw === "object" &&
    focusRaw !== null &&
    (focusRaw as { schemaVersion?: unknown }).schemaVersion === STEP2_CORRECTION_VERSIONS.workspace
  ) {
    // S2-CP-B: a v3 correction draft routes to the
    // provenance-aware freeze below; older paths never compile it.
    return resolveFrozenDraftV3(handle, jobId, workspace, focusRaw, env, now);
  }
  if (
    typeof focusRaw === "object" &&
    focusRaw !== null &&
    (focusRaw as { schemaVersion?: unknown }).schemaVersion === STEP2_SCHEMA_VERSIONS.workspace
  ) {
    // S2-D: a v2 edited draft routes to the edited-plan freeze
    // below; v1 submission never compiles it.
    return resolveFrozenDraftV2(handle, jobId, workspace, focusRaw, env, now);
  }
  if (
    workspace.extractionId === null ||
    workspace.profileId === null ||
    workspace.profileVersionId === null ||
    workspace.recommendationHash === null
  ) {
    // An unbound draft cannot submit: no default-profile fallback,
    // no rebuilt guidance — bind first, then submit.
    return fail("input-stale", "workspace draft has no bound recommendation snapshot");
  }
  let focus: FocusV1Type;
  try {
    focus = FocusV1.parse(focusRaw);
  } catch {
    return fail(
      "storage-unavailable",
      "stored workspace focus failed strict validation; inspect the row, do not trust it",
    );
  }
  const resolved = resolveRecommendationBinding(handle, {
    jobId,
    extractionId: workspace.extractionId,
    profileVersionId: workspace.profileVersionId,
  });
  if (!resolved.ok) {
    switch (resolved.failure.error) {
      case "unknown-job":
        return fail("unknown-job", resolved.failure.detail);
      case "jd-not-ready":
        return fail("jd-not-ready", resolved.failure.detail);
      case "storage-unavailable":
        return fail("storage-unavailable", resolved.failure.detail);
      case "not-found":
      case "input-stale":
        // The draft references rows that no longer resolve: the
        // binding drifted out from under a validated save.
        return fail("input-stale", resolved.failure.detail);
    }
  }
  const binding = resolved.binding;
  let recommendations: RecommendationV1Type;
  try {
    recommendations = buildRecommendations({
      extractionId: binding.extractionId,
      canonicalJdText: binding.canonicalJdText,
      jdHash: binding.jdHash,
      profileVersionId: binding.profileVersionId,
      profileHash: binding.profileHash,
      payload: binding.payload,
      approvedFacts: binding.approvedFacts,
    });
  } catch (error: unknown) {
    return fail(
      "storage-unavailable",
      `rebuilt recommendations failed strict validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (hashRecommendation(recommendations) !== workspace.recommendationHash) {
    return fail("input-stale", "bound recommendation snapshot no longer matches a fresh build");
  }
  if (binding.extractionId !== job.activeExtractionId) {
    return fail("input-stale", "binding extraction is no longer the job's active extraction");
  }
  const active = getActiveProfileVersion(handle, binding.profileId);
  if (active === null || active.id !== binding.profileVersionId) {
    return fail("input-stale", "binding profile version is no longer active");
  }
  const readiness = getTailoringReadiness(handle, jobId, env, {
    extractionId: binding.extractionId,
    profileVersionId: binding.profileVersionId,
  });
  if (!readiness.ok) {
    switch (readiness.failure.error) {
      case "unknown-job":
        return fail("unknown-job", readiness.failure.detail);
      case "profile-not-ready":
        return fail("profile-not-ready", readiness.failure.detail);
      case "jd-not-ready":
        return fail("jd-not-ready", readiness.failure.detail);
      case "provider-not-ready":
        return fail("provider-not-ready", readiness.failure.detail);
      case "storage-unavailable":
        return fail("storage-unavailable", readiness.failure.detail);
    }
  }
  // Kind coherence was validated at W-save; re-verify before
  // freezing (a mismatch is storage corruption, not user input).
  const kind = workspace.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION";
  if (kind !== "INITIAL" && kind !== "NEW_VERSION" && kind !== "REVISION") {
    return fail(
      "storage-unavailable",
      `stored draft kind ${JSON.stringify(workspace.requestKind)} is not a generation kind; inspect the row, do not trust it`,
    );
  }
  const parentVersionId = workspace.parentVersionId;
  const revisionNote = workspace.revisionNote;
  const coherent =
    kind === "INITIAL"
      ? parentVersionId === null && revisionNote === null
      : kind === "NEW_VERSION"
        ? parentVersionId !== null && revisionNote === null
        : parentVersionId !== null && revisionNote !== null;
  if (!coherent) {
    return fail(
      "storage-unavailable",
      `stored draft kind ${kind} disagrees with its parent/note; inspect the row, do not trust it`,
    );
  }
  if (parentVersionId !== null) {
    const parent = handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, parentVersionId))
      .get();
    if (parent === undefined || parent.jobId !== jobId) {
      return fail(
        "storage-unavailable",
        `draft parent version ${parentVersionId} does not belong to job ${jobId}; inspect the row, do not trust it`,
      );
    }
    if (kind === "REVISION" && parent.reviewState !== "AWAITING_REVIEW") {
      return fail(
        "input-stale",
        `draft parent version ${parentVersionId} is no longer awaiting review`,
      );
    }
  }
  const profile = getProfile(handle, binding.profileId);
  if (profile === null) {
    return fail(
      "storage-unavailable",
      `binding profile ${binding.profileId} no longer resolves; inspect the row, do not trust it`,
    );
  }
  const versionRow = getProfileVersion(handle, binding.profileVersionId);
  if (versionRow === null) {
    return fail(
      "storage-unavailable",
      `binding profile version ${binding.profileVersionId} no longer resolves; inspect the row, do not trust it`,
    );
  }
  const sourceRow = getSourceByVersion(handle, binding.profileVersionId);
  const masterText = canonicalText(
    renderMasterMarkdown(binding.payload, {
      reconstructed: sourceRow === null,
      profileDisplayName: profile.displayName,
      version: versionRow.version,
    }),
  );
  if (Buffer.byteLength(masterText, "utf8") > MASTER_TEXT_MAX_UTF8_BYTES) {
    return fail(
      "profile-not-ready",
      `bound master text exceeds the frozen projection cap of ${MASTER_TEXT_MAX_UTF8_BYTES} bytes`,
    );
  }
  const phraseText = new Map(recommendations.phrases.map((phrase) => [phrase.id, phrase.text]));
  const selectedTexts: string[] = [];
  for (const phraseId of focus.selectedPhraseIds) {
    const text = phraseText.get(phraseId);
    if (text === undefined) {
      return fail(
        "storage-unavailable",
        `stored focus selects unknown phrase ${phraseId}; inspect the row, do not trust it`,
      );
    }
    selectedTexts.push(text);
  }
  return {
    ok: true,
    draft: {
      format: "v1",
      extractionId: binding.extractionId,
      profileId: binding.profileId,
      profileVersionId: binding.profileVersionId,
      requestKind: kind,
      parentVersionId,
      revisionNote,
      recommendationHash: workspace.recommendationHash,
      focus,
      recommendations,
      jdHash: binding.jdHash,
      profileHash: binding.profileHash,
      canonicalJdText: binding.canonicalJdText,
      payload: binding.payload,
      masterText,
      masterTextHash: sha256HexUtf8(masterText),
      selectedTexts,
    },
    jobRowVersion: job.rowVersion,
  };
}

/** Snapshot facts for `step2-claims/1` (same construction as validate-draft). */
function buildStep2SnapshotFacts(
  handle: DatabaseHandle,
  versionId: string,
  payload: StoredProfilePayload,
): Step2SnapshotFact[] {
  const employmentOf = new Map<string, string>();
  const metricsByFact = new Map<string, string[]>();
  for (const achievement of payload.achievements) {
    if (achievement.employmentId !== undefined) {
      employmentOf.set(achievement.factId, achievement.employmentId);
    }
    metricsByFact.set(achievement.factId, [...achievement.metrics]);
  }
  return listFactsByVersion(handle, versionId).map((fact) => ({
    factId: fact.factId,
    statement: fact.statement,
    verification: fact.verification,
    profileVersionId: versionId,
    employmentId: employmentOf.get(fact.factId) ?? null,
    metrics: metricsByFact.get(fact.factId) ?? [],
  }));
}

function step2PlanTexts(plan: PreparationPlanV1Type): Array<{ textId: string; text: string }> {
  return [
    ...plan.suggestions.map((suggestion) => ({
      textId: suggestion.suggestionId,
      text: suggestion.text,
    })),
    ...plan.positioning.angles.map((angle) => ({ textId: angle.angleId, text: angle.summaryText })),
    ...(plan.positioning.keepMasterSummary === ""
      ? []
      : [{ textId: "keep-master", text: plan.positioning.keepMasterSummary }]),
  ];
}

function unresolvedDetail(
  segments: Array<{ segmentId: string; supported: boolean; reason: string | null }>,
): string {
  const blocked = segments.filter((segment) => !segment.supported);
  const names = blocked
    .slice(0, 3)
    .map((segment) =>
      segment.reason === null
        ? segment.segmentId
        : `${segment.segmentId} (${segment.reason})`,
    );
  const extra = blocked.length > 3 ? ` and ${blocked.length - 3} more` : "";
  return `included text needs evidence: ${names.join(", ")}${extra}; edit it to supported wording or exclude it`;
}

/**
 * S2-D phase 0 for edited-plan drafts: freeze the accepted plan,
 * the exact stored draft bytes, and their verdicts. Plan drift
 * fails plan-stale (never silently rebinds); captured-evidence
 * drift fails profile-not-ready (§8.6 web rule); included
 * needs-evidence text fails unresolved-evidence — all with zero
 * writes, the drafts staying saved for editing. Bullet/summary
 * length guidance (`validation.budget.exceeded`) is advisory
 * data, never a rejection: every kept bullet submits as is.
 * Unlinked master bullets that survive exclusion fail
 * invalid-selection: no employment can carry them, and
 * generation never drops content silently.
 */
function resolveFrozenDraftV2(
  handle: DatabaseHandle,
  jobId: string,
  workspace: {
    extractionId: string | null;
    profileId: string | null;
    profileVersionId: string | null;
    requestKind: string;
    parentVersionId: string | null;
    revisionNote: string | null;
  },
  focusRaw: unknown,
  env: Record<string, string | undefined>,
  now: string,
): { ok: true; draft: FrozenDraftV2; jobRowVersion: number } | { ok: false; failure: SubmitGenerationFailure } {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  if (
    workspace.extractionId === null ||
    workspace.profileId === null ||
    workspace.profileVersionId === null
  ) {
    return fail("input-stale", "workspace draft has no bound plan snapshot");
  }
  let stored: { planId: string | null; planHash: string | null; draft: Step2DraftV1Type | null };
  try {
    stored = WorkspaceStoredV2.parse(focusRaw);
  } catch {
    return fail(
      "storage-unavailable",
      "stored edited draft failed strict validation; inspect the row, do not trust it",
    );
  }
  if (stored.planId === null || stored.planHash === null || stored.draft === null) {
    return fail("input-stale", "workspace holds an empty editor; prepare a plan and edit it first");
  }
  const draft = stored.draft;
  const preparation = readPreparationByJob(handle, jobId);
  if (preparation === null || preparation.acceptedPlanId === null) {
    return fail("plan-stale", "job has no accepted plan; run preparation first");
  }
  if (preparation.acceptedPlanId !== stored.planId) {
    return fail("plan-stale", "a newer plan was accepted; rebind the draft before submitting");
  }
  const planRow = readPlan(handle, stored.planId);
  if (planRow === null) {
    return fail("storage-unavailable", `accepted plan ${stored.planId} is unreadable`);
  }
  let plan: PreparationPlanV1Type;
  try {
    plan = PreparationPlanV1.parse(JSON.parse(planRow.planJson) as unknown);
  } catch {
    return fail("storage-unavailable", `accepted plan ${stored.planId} is unreadable`);
  }
  if (planHashFor(plan) !== planRow.planHash || planRow.planHash !== stored.planHash) {
    return fail(
      "storage-unavailable",
      "accepted plan bytes disagree with their recorded hash; inspect the rows, do not trust them",
    );
  }
  if (plan.extractionId !== job.activeExtractionId) {
    return fail("plan-stale", "accepted plan predates the active job description; re-prepare first");
  }
  const extraction = handle.db
    .select()
    .from(jobExtractions)
    .where(eq(jobExtractions.id, plan.extractionId))
    .get();
  if (extraction === undefined) {
    return fail("storage-unavailable", `binding extraction ${plan.extractionId} vanished`);
  }
  let envelopeDescription: string | null;
  try {
    envelopeDescription = parseStoredExtraction(
      JSON.parse(extraction.extractedJson) as unknown,
    ).fields.descriptionText;
  } catch {
    return fail(
      "storage-unavailable",
      `stored extraction ${plan.extractionId} failed strict validation; inspect the row, do not trust it`,
    );
  }
  const jdHash = sha256HexUtf8(canonicalText(envelopeDescription ?? ""));
  if (jdHash !== plan.jdHash) {
    return fail("plan-stale", "retained job description bytes changed; re-prepare first");
  }
  const evidence = verifyCapturedEvidence(handle, {
    profileId: workspace.profileId,
    profileVersionId: workspace.profileVersionId,
    profilePayloadHash: preparation.profilePayloadHash,
    evidenceHash: preparation.evidenceHash,
  });
  if (evidence.ok !== true) {
    return fail("profile-not-ready", "captured profile evidence no longer verifies");
  }
  const readiness = getTailoringReadiness(handle, jobId, env, {
    extractionId: workspace.extractionId,
    profileVersionId: workspace.profileVersionId,
  });
  if (!readiness.ok) {
    switch (readiness.failure.error) {
      case "unknown-job":
        return fail("unknown-job", readiness.failure.detail);
      case "profile-not-ready":
        return fail("profile-not-ready", readiness.failure.detail);
      case "jd-not-ready":
        return fail("jd-not-ready", readiness.failure.detail);
      case "provider-not-ready":
        return fail("provider-not-ready", readiness.failure.detail);
      case "storage-unavailable":
        return fail("storage-unavailable", readiness.failure.detail);
    }
  }
  const kind = workspace.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION";
  if (kind !== "INITIAL" && kind !== "NEW_VERSION" && kind !== "REVISION") {
    return fail(
      "storage-unavailable",
      `stored draft kind ${JSON.stringify(workspace.requestKind)} is not a generation kind; inspect the row, do not trust it`,
    );
  }
  const parentVersionId = workspace.parentVersionId;
  const revisionNote = workspace.revisionNote;
  const coherent =
    kind === "INITIAL"
      ? parentVersionId === null && revisionNote === null
      : kind === "NEW_VERSION"
        ? parentVersionId !== null && revisionNote === null
        : parentVersionId !== null && revisionNote !== null;
  if (!coherent) {
    return fail(
      "storage-unavailable",
      `stored draft kind ${kind} disagrees with its parent/note; inspect the row, do not trust it`,
    );
  }
  if (parentVersionId !== null) {
    const parent = handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, parentVersionId))
      .get();
    if (parent === undefined || parent.jobId !== jobId) {
      return fail(
        "storage-unavailable",
        `draft parent version ${parentVersionId} does not belong to job ${jobId}; inspect the row, do not trust it`,
      );
    }
    if (kind === "REVISION" && parent.reviewState !== "AWAITING_REVIEW") {
      return fail(
        "input-stale",
        `draft parent version ${parentVersionId} is no longer awaiting review`,
      );
    }
  }
  const profile = getProfile(handle, workspace.profileId);
  if (profile === null) {
    return fail(
      "storage-unavailable",
      `binding profile ${workspace.profileId} no longer resolves; inspect the row, do not trust it`,
    );
  }
  const versionRow = getProfileVersion(handle, workspace.profileVersionId);
  if (versionRow === null) {
    return fail(
      "storage-unavailable",
      `binding profile version ${workspace.profileVersionId} no longer resolves; inspect the row, do not trust it`,
    );
  }
  const sourceRow = getSourceByVersion(handle, workspace.profileVersionId);
  const masterText = canonicalText(
    renderMasterMarkdown(evidence.bound.payload, {
      reconstructed: sourceRow === null,
      profileDisplayName: profile.displayName,
      version: versionRow.version,
    }),
  );
  if (Buffer.byteLength(masterText, "utf8") > MASTER_TEXT_MAX_UTF8_BYTES) {
    return fail(
      "profile-not-ready",
      `bound master text exceeds the frozen projection cap of ${MASTER_TEXT_MAX_UTF8_BYTES} bytes`,
    );
  }
  // Structural integrity first: unknown references are corruption
  // (W pins them on save), and unplaceable unlinked bullets refuse
  // loudly instead of dropping silently.
  const master = masterBulletsByRole(evidence.bound.payload);
  let applied: ReturnType<typeof applyEditedBullets>;
  try {
    applied = applyEditedBullets({ master, plan, operations: draft.operations });
  } catch (error: unknown) {
    return fail(
      "storage-unavailable",
      error instanceof Error ? error.message : "stored draft failed op application",
    );
  }
  const unlinked = applied
    .filter((group) => group.roleId === "")
    .flatMap((group) => group.bullets);
  if (unlinked.length > 0) {
    return fail(
      "invalid-selection",
      `${unlinked.length} master bullets have no linked employer and cannot be placed; exclude them or link them in Settings`,
      { field: "draft" },
    );
  }
  const draftHash = draftHashFor(draft);
  const derived = deriveStep2Segments({
    plan,
    master,
    summaryText: draft.summaryText,
    operations: draft.operations,
  });
  const candidates = readDraftValidationsByHash(handle, jobId, draftHash);
  let validationId: string | null = null;
  let validation: Step2ValidationV1Type | null = null;
  for (const candidate of candidates) {
    if (candidate.planId !== planRow.id || candidate.policyVersion !== "step2-claims/1") {
      continue;
    }
    let parsed: Step2ValidationV1Type;
    try {
      parsed = Step2ValidationV1.parse(JSON.parse(candidate.verdictJson) as unknown);
    } catch {
      continue;
    }
    if (parsed.planHash !== stored.planHash || parsed.draftHash !== draftHash) {
      continue;
    }
    const coverage = verifyStep2VerdictCoverage({ derived, validation: parsed });
    if (!coverage.covered) {
      continue;
    }
    validationId = candidate.id;
    validation = parsed;
    break;
  }
  if (validation === null) {
    // No persisted verdict covers these exact bytes (direct API
    // callers may skip the validate endpoint): replay validation
    // over the frozen inputs. The row persists in-txn on success;
    // blocked attempts write nothing at all.
    validation = validateStep2Segments({
      segments: derived,
      planId: plan.planId,
      planHash: stored.planHash,
      draftHash,
      boundProfileVersionId: workspace.profileVersionId,
      snapshotFacts: buildStep2SnapshotFacts(
        handle,
        workspace.profileVersionId,
        evidence.bound.payload,
      ),
      planTexts: step2PlanTexts(plan),
      master,
      employments: evidence.bound.payload.employment.map((entry) => ({
        id: entry.id,
        company: entry.company,
      })),
      versionCreatedAt: versionRow.createdAt,
      planAcceptedAt: planRow.createdAt,
      now,
      validatedAt: now,
      summaryText: draft.summaryText,
      operations: draft.operations,
    });
  }
  const coverage = verifyStep2VerdictCoverage({ derived, validation });
  if (!coverage.allSupported) {
    return fail("unresolved-evidence", unresolvedDetail(coverage.segments));
  }
  // Length guidance is advisory: `validation.budget` still
  // records the counts for display/audit, but overflow never
  // rejects. The frozen-input byte cap below stays blocking.
  const policies = step2GenerationPolicies();
  const editedInputsJson = canonicalJson(
    Step2EditedInputsV1.parse({
      schemaVersion: "step2-edited-inputs/v1",
      planId: plan.planId,
      summaryText: draft.summaryText,
      summarySource: draft.summarySource,
      operations: draft.operations,
    }),
  );
  // W's 64 KiB focus cap transitively bounds these bytes; the guard
  // converts any future drift into a 422 instead of a 500.
  if (
    Buffer.byteLength(editedInputsJson, "utf8") > 65536 ||
    Buffer.byteLength(canonicalJson(draft), "utf8") > 65536
  ) {
    return fail(
      "budget-exceeded",
      "edited draft bytes exceed the 64 KiB frozen-input cap; shorten edits to submit",
    );
  }
  return {
    ok: true,
    draft: {
      format: "v2",
      extractionId: workspace.extractionId,
      profileId: workspace.profileId,
      profileVersionId: workspace.profileVersionId,
      requestKind: kind,
      parentVersionId,
      revisionNote,
      jdHash,
      canonicalJdText: canonicalText(envelopeDescription ?? ""),
      payload: evidence.bound.payload,
      masterText,
      masterTextHash: sha256HexUtf8(masterText),
      planId: plan.planId,
      planHash: stored.planHash,
      draftHash,
      draft,
      plan,
      policies,
      editedInputsJson,
      validationId,
      computedValidation: validationId === null ? validation : null,
      profilePayloadHash: preparation.profilePayloadHash,
      evidenceHash: preparation.evidenceHash,
    },
    jobRowVersion: job.rowVersion,
  };
}

function structuralDetail(
  segments: Array<{ segmentId: string; structuralOk: boolean; structuralReason: string | null }>,
  missing: string[],
): string {
  const blocked = segments.filter((segment) => !segment.structuralOk);
  const names = blocked
    .slice(0, 3)
    .map((segment) =>
      segment.structuralReason === null
        ? segment.segmentId
        : `${segment.segmentId} (${segment.structuralReason})`,
    );
  if (missing.length > 0) {
    names.push(`stale verdicts for ${missing.slice(0, 3).join(", ")}`);
  }
  const extra = blocked.length > 3 ? ` and ${blocked.length - 3} more` : "";
  return `included text is structurally blocked: ${names.join(", ")}${extra}; fix the named segments or exclude them`;
}

/**
 * S2-CP-B phase 0 for correction drafts: freeze the accepted v2
 * plan, the exact stored v2 draft bytes, their `step2-claims/2`
 * verdicts, and the frozen provenance manifest. The gate requires
 * covered segments with every segment structurally sound —
 * provenance never blocks, so `USER_EDITED` text (including
 * unverified metrics, technologies, and responsibilities)
 * submits verbatim, and bullet/summary length guidance is
 * advisory only. Structural failures refuse 422
 * INVALID_SELECTION with zero writes; `UNRESOLVED_EVIDENCE` is
 * never emitted on this path, and `BUDGET_EXCEEDED` fires only
 * for the 64 KiB frozen-input byte cap. Plan drift fails 409
 * PLAN_STALE against the captured binding, never the active
 * pointers.
 */
function resolveFrozenDraftV3(
  handle: DatabaseHandle,
  jobId: string,
  workspace: {
    extractionId: string | null;
    profileId: string | null;
    profileVersionId: string | null;
    requestKind: string;
    parentVersionId: string | null;
    revisionNote: string | null;
  },
  focusRaw: unknown,
  env: Record<string, string | undefined>,
  now: string,
): { ok: true; draft: FrozenDraftV3; jobRowVersion: number } | { ok: false; failure: SubmitGenerationFailure } {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("unknown-job", `job ${jobId} does not exist`);
  }
  if (
    workspace.extractionId === null ||
    workspace.profileId === null ||
    workspace.profileVersionId === null
  ) {
    return fail("input-stale", "workspace draft has no bound plan snapshot");
  }
  let stored: { planId: string | null; planHash: string | null; draft: Step2DraftV2Type | null };
  try {
    stored = WorkspaceStoredV3.parse(focusRaw);
  } catch {
    return fail(
      "storage-unavailable",
      "stored edited draft failed strict validation; inspect the row, do not trust it",
    );
  }
  if (stored.planId === null || stored.planHash === null || stored.draft === null) {
    return fail("input-stale", "workspace holds an empty editor; prepare a plan and edit it first");
  }
  const draft = stored.draft;
  const preparation = readPreparationByJob(handle, jobId);
  if (preparation === null || preparation.acceptedPlanId === null) {
    return fail("plan-stale", "job has no accepted plan; run preparation first");
  }
  if (preparation.acceptedPlanId !== stored.planId) {
    return fail("plan-stale", "a newer plan was accepted; rebind the draft before submitting");
  }
  const planRow = readPlan(handle, stored.planId);
  if (planRow === null) {
    return fail("storage-unavailable", `accepted plan ${stored.planId} is unreadable`);
  }
  const parsedPlan = parseStoredPlan(planRow.planJson);
  if (parsedPlan === null || parsedPlan.version !== 2) {
    return fail("plan-stale", "accepted plan predates correction generation; run preparation first");
  }
  const plan = parsedPlan.plan;
  if (correctionPlanHashFor(plan) !== planRow.planHash || planRow.planHash !== stored.planHash) {
    return fail(
      "storage-unavailable",
      "accepted plan bytes disagree with their recorded hash; inspect the rows, do not trust them",
    );
  }
  if (plan.extractionId !== job.activeExtractionId) {
    return fail("plan-stale", "accepted plan predates the active job description; re-prepare first");
  }
  const extraction = handle.db
    .select()
    .from(jobExtractions)
    .where(eq(jobExtractions.id, plan.extractionId))
    .get();
  if (extraction === undefined) {
    return fail("storage-unavailable", `binding extraction ${plan.extractionId} vanished`);
  }
  let envelopeDescription: string | null;
  try {
    envelopeDescription = parseStoredExtraction(
      JSON.parse(extraction.extractedJson) as unknown,
    ).fields.descriptionText;
  } catch {
    return fail(
      "storage-unavailable",
      `stored extraction ${plan.extractionId} failed strict validation; inspect the row, do not trust it`,
    );
  }
  const jdHash = sha256HexUtf8(canonicalText(envelopeDescription ?? ""));
  if (jdHash !== plan.jdHash) {
    return fail("plan-stale", "retained job description bytes changed; re-prepare first");
  }
  const evidence = verifyCapturedEvidence(handle, {
    profileId: workspace.profileId,
    profileVersionId: workspace.profileVersionId,
    profilePayloadHash: preparation.profilePayloadHash,
    evidenceHash: preparation.evidenceHash,
  });
  if (evidence.ok !== true) {
    return fail("profile-not-ready", "captured profile evidence no longer verifies");
  }
  const readiness = getTailoringReadiness(handle, jobId, env, {
    extractionId: workspace.extractionId,
    profileVersionId: workspace.profileVersionId,
  });
  if (!readiness.ok) {
    switch (readiness.failure.error) {
      case "unknown-job":
        return fail("unknown-job", readiness.failure.detail);
      case "profile-not-ready":
        return fail("profile-not-ready", readiness.failure.detail);
      case "jd-not-ready":
        return fail("jd-not-ready", readiness.failure.detail);
      case "provider-not-ready":
        return fail("provider-not-ready", readiness.failure.detail);
      case "storage-unavailable":
        return fail("storage-unavailable", readiness.failure.detail);
    }
  }
  const kind = workspace.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION";
  if (kind !== "INITIAL" && kind !== "NEW_VERSION" && kind !== "REVISION") {
    return fail(
      "storage-unavailable",
      `stored draft kind ${JSON.stringify(workspace.requestKind)} is not a generation kind; inspect the row, do not trust it`,
    );
  }
  const parentVersionId = workspace.parentVersionId;
  const revisionNote = workspace.revisionNote;
  const coherent =
    kind === "INITIAL"
      ? parentVersionId === null && revisionNote === null
      : kind === "NEW_VERSION"
        ? parentVersionId !== null && revisionNote === null
        : parentVersionId !== null && revisionNote !== null;
  if (!coherent) {
    return fail(
      "storage-unavailable",
      `stored draft kind ${kind} disagrees with its parent/note; inspect the row, do not trust it`,
    );
  }
  if (parentVersionId !== null) {
    const parent = handle.db
      .select()
      .from(resumeVersions)
      .where(eq(resumeVersions.id, parentVersionId))
      .get();
    if (parent === undefined || parent.jobId !== jobId) {
      return fail(
        "storage-unavailable",
        `draft parent version ${parentVersionId} does not belong to job ${jobId}; inspect the row, do not trust it`,
      );
    }
    if (kind === "REVISION" && parent.reviewState !== "AWAITING_REVIEW") {
      return fail(
        "input-stale",
        `draft parent version ${parentVersionId} is no longer awaiting review`,
      );
    }
  }
  const profile = getProfile(handle, workspace.profileId);
  if (profile === null) {
    return fail(
      "storage-unavailable",
      `binding profile ${workspace.profileId} no longer resolves; inspect the row, do not trust it`,
    );
  }
  const versionRow = getProfileVersion(handle, workspace.profileVersionId);
  if (versionRow === null) {
    return fail(
      "storage-unavailable",
      `binding profile version ${workspace.profileVersionId} no longer resolves; inspect the row, do not trust it`,
    );
  }
  const sourceRow = getSourceByVersion(handle, workspace.profileVersionId);
  const masterText = canonicalText(
    renderMasterMarkdown(evidence.bound.payload, {
      reconstructed: sourceRow === null,
      profileDisplayName: profile.displayName,
      version: versionRow.version,
    }),
  );
  if (Buffer.byteLength(masterText, "utf8") > MASTER_TEXT_MAX_UTF8_BYTES) {
    return fail(
      "profile-not-ready",
      `bound master text exceeds the frozen projection cap of ${MASTER_TEXT_MAX_UTF8_BYTES} bytes`,
    );
  }
  // Structural integrity first: unknown references are corruption
  // (W pins them on save), and unplaceable unlinked bullets refuse
  // loudly instead of dropping silently.
  const master = masterBulletsByRole(evidence.bound.payload);
  let applied: ReturnType<typeof applyEditedBullets>;
  try {
    applied = applyEditedBullets({ master, plan, operations: draft.operations });
  } catch (error: unknown) {
    return fail(
      "storage-unavailable",
      error instanceof Error ? error.message : "stored draft failed op application",
    );
  }
  const unlinked = applied
    .filter((group) => group.roleId === "")
    .flatMap((group) => group.bullets);
  if (unlinked.length > 0) {
    return fail(
      "invalid-selection",
      `${unlinked.length} master bullets have no linked employer and cannot be placed; exclude them or link them in Settings`,
      { field: "draft" },
    );
  }
  const draftHash = correctionDraftHashFor(draft);
  const derived = deriveCorrectionSegments({
    plan,
    master,
    masterSummary: evidence.bound.payload.summary ?? "",
    summaryText: draft.summaryText,
    summaryOrigin: draft.summaryOrigin,
    operations: draft.operations,
  });
  const candidates = readDraftValidationsByHash(handle, jobId, draftHash);
  let validationId: string | null = null;
  let validation: Step2ValidationV2Type | null = null;
  for (const candidate of candidates) {
    if (candidate.planId !== planRow.id || candidate.policyVersion !== "step2-claims/2") {
      continue;
    }
    const parsed = parseStoredValidation(candidate.verdictJson);
    if (parsed === null || parsed.version !== 2) {
      continue;
    }
    if (parsed.validation.planHash !== stored.planHash || parsed.validation.draftHash !== draftHash) {
      continue;
    }
    const coverage = verifyCorrectionCoverage({ derived, validation: parsed.validation });
    if (!coverage.covered) {
      continue;
    }
    validationId = candidate.id;
    validation = parsed.validation;
    break;
  }
  if (validation === null) {
    // No persisted verdict covers these exact bytes (direct API
    // callers may skip the validate endpoint): replay validation
    // over the frozen inputs. The row persists in-txn on success;
    // blocked attempts write nothing at all.
    validation = validateCorrectionSegments({
      segments: derived,
      plan,
      planHash: stored.planHash,
      draftHash,
      boundProfileVersionId: workspace.profileVersionId,
      snapshotFacts: buildStep2SnapshotFacts(
        handle,
        workspace.profileVersionId,
        evidence.bound.payload,
      ),
      master,
      masterSummary: evidence.bound.payload.summary ?? "",
      employments: evidence.bound.payload.employment.map((entry) => ({
        id: entry.id,
        company: entry.company,
      })),
      versionCreatedAt: versionRow.createdAt,
      planAcceptedAt: planRow.createdAt,
      now,
      validatedAt: now,
      summaryText: draft.summaryText,
      operations: draft.operations,
    });
  }
  const coverage = verifyCorrectionCoverage({ derived, validation });
  if (!coverage.covered || !coverage.allStructuralOk) {
    return fail("invalid-selection", structuralDetail(coverage.segments, coverage.missing), {
      field: "draft",
    });
  }
  // Length guidance is advisory: `validation.budget` still
  // records the counts for display/audit, but overflow never
  // rejects. The frozen-input byte cap below stays blocking.
  const policies = step2CorrectionPolicies();
  const manifest: Step2ProvenanceEntryV2Type[] = derived.map((segment) => ({
    segmentId: segment.segmentId,
    kind: segment.kind,
    roleId: segment.roleId,
    origin: segment.origin,
    anchorFactIds: [...segment.anchorFactIds],
    priorityIds: [...segment.priorityIds],
    textHash: correctionSegmentTextHashFor(segment.text),
    normalizedHash: correctionSegmentNormalizedHashFor(segment.text),
    provenance:
      coverage.segments.find((entry) => entry.segmentId === segment.segmentId)?.provenance ??
      "USER_EDITED",
    sourceOperationId: segment.sourceOperationId,
  }));
  const editedInputsJson = canonicalJson(
    Step2EditedInputsV2.parse({
      schemaVersion: "step2-edited-inputs/v2",
      planId: plan.planId,
      summaryText: draft.summaryText,
      summaryOrigin: draft.summaryOrigin,
      operations: draft.operations,
      provenanceManifest: manifest,
    }),
  );
  // W's 64 KiB focus cap transitively bounds these bytes; the guard
  // converts any future drift into a 422 instead of a 500.
  if (
    Buffer.byteLength(editedInputsJson, "utf8") > 65536 ||
    Buffer.byteLength(canonicalJson(draft), "utf8") > 65536
  ) {
    return fail(
      "budget-exceeded",
      "edited draft bytes exceed the 64 KiB frozen-input cap; shorten edits to submit",
    );
  }
  return {
    ok: true,
    draft: {
      format: "v3",
      extractionId: workspace.extractionId,
      profileId: workspace.profileId,
      profileVersionId: workspace.profileVersionId,
      requestKind: kind,
      parentVersionId,
      revisionNote,
      jdHash,
      canonicalJdText: canonicalText(envelopeDescription ?? ""),
      payload: evidence.bound.payload,
      masterText,
      masterTextHash: sha256HexUtf8(masterText),
      planId: plan.planId,
      planHash: stored.planHash,
      draftHash,
      draft,
      plan,
      policies,
      editedInputsJson,
      provenanceManifestHash: correctionManifestHashFor(manifest),
      validationId,
      computedValidation: validationId === null ? validation : null,
      profilePayloadHash: preparation.profilePayloadHash,
      evidenceHash: preparation.evidenceHash,
    },
    jobRowVersion: job.rowVersion,
  };
}

/**
 * Request lookup shared by the pre-read fast path and the in-txn
 * backstop: identical submit bytes replay with zero writes, anything
 * else under a reused operation ID fails closed. Returns null when
 * no row exists yet (submission proceeds). Request and input rows
 * are immutable once written, so a pre-read hit is stable and safe
 * to return outside any transaction.
 */
function checkReplay(
  handle: DatabaseHandle,
  input: SubmitGenerationInput,
  submitHash: string,
): SubmitGenerationResult | null {
  const existing = getGenerationRequest(handle, input.requestId);
  if (existing === null) {
    return null;
  }
  if (existing.jobId !== input.jobId) {
    return fail("idempotency-mismatch", `operation ${input.requestId} belongs to another job`);
  }
  const inputs = readRequestInputs(handle, input.requestId);
  if (inputs === null || inputs.submitHash !== submitHash) {
    return fail(
      "idempotency-mismatch",
      `operation ${input.requestId} was already submitted with different bytes; mint a fresh operation ID to submit again`,
    );
  }
  // Byte-identical replay: pure reads, zero writes — even when the
  // run already failed (recovery is F's explicit retry). The CHECK
  // constraint pins status to the four reply values.
  const job = getTailoringJob(handle, input.jobId) as { rowVersion: number };
  const workspace = readWorkspace(handle, input.jobId);
  if (existing.workItemId === null) {
    return fail(
      "storage-unavailable",
      `request ${input.requestId} has no queue row; inspect the row, do not trust it`,
    );
  }
  return {
    ok: true,
    requestId: existing.id,
    workItemId: existing.workItemId,
    status: existing.status as "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED",
    replayed: true,
    jobRowVersion: job.rowVersion,
    workspaceRevision: workspace?.revision ?? input.workspaceRevision,
  };
}

export function submitGeneration(
  handle: DatabaseHandle,
  rawInput: unknown,
  deps: SubmitGenerationDeps = {},
): SubmitGenerationResult {
  const input = SubmitGenerationInput.parse(rawInput);
  const now = input.now ?? utcNow();
  const env = deps.env ?? process.env;
  const submitHash = hashSubmission({
    jobId: input.jobId,
    requestId: input.requestId,
    workspaceRevision: input.workspaceRevision,
    observedRowVersion: input.observedRowVersion,
  });

  // Request lookup FIRST — before draft, job, and readiness checks —
  // so lost-202 replays reconcile no matter how far the job moved.
  const preplay = checkReplay(handle, input, submitHash);
  if (preplay !== null) {
    return preplay;
  }

  // Phase 0: read-only freeze outside any transaction — resolution,
  // fresh-build verification, readiness, projection. Any failure
  // returns before a single write is attempted.
  const frozen = resolveFrozenDraft(handle, input.jobId, input.workspaceRevision, env, now);
  if (!frozen.ok) {
    return frozen;
  }
  const draft = frozen.draft;

  return withTransaction(handle.sqlite, () => {
    // In-txn lookup backstop: a concurrent same-ID submit may have
    // committed between the pre-read and this transaction.
    const raced = checkReplay(handle, input, submitHash);
    if (raced !== null) {
      return raced;
    }

    const workspace = readWorkspace(handle, input.jobId);
    if (workspace === null || workspace.revision !== input.workspaceRevision) {
      return fail("workspace-conflict", "workspace draft changed during submission; reload and resubmit", {
        currentWorkspaceRevision: workspace?.revision ?? 0,
      });
    }
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail("unknown-job", `job ${input.jobId} does not exist`);
    }
    if (job.rowVersion !== input.observedRowVersion) {
      return fail("job-conflict", "job changed during submission; reload and resubmit", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (job.status === "REJECTED") {
      return fail("job-conflict", "rejected jobs cannot start generation", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (job.tailoringState === "PENDING" || job.tailoringState === "RUNNING") {
      return fail("generation-busy", "a tailoring run is already live for this job", {
        currentRowVersion: job.rowVersion,
      });
    }
    const live = getLiveGenerationRequest(handle, input.jobId);
    if (live !== null) {
      return fail(
        "generation-busy",
        `request ${live.id} is already live for this job; wait for it or replay its own operation ID`,
        { currentRowVersion: job.rowVersion },
      );
    }
    // Active-pointer and source-hash re-verification: the frozen
    // phase-0 inputs must still be pinned and byte-identical. The v2
    // leg re-verifies the captured binding (never the active
    // pointers): later Settings edits alone never stale a submit.
    let envelopeDescription: string | null;
    if (draft.format === "v2" || draft.format === "v3") {
      if (job.activeExtractionId !== draft.extractionId) {
        return fail("plan-stale", "binding extraction is no longer the job's active extraction");
      }
      const preparation = readPreparationByJob(handle, input.jobId);
      if (preparation === null || preparation.acceptedPlanId !== draft.planId) {
        return fail("plan-stale", "accepted plan changed during submission; rebind and resubmit");
      }
      const planRow = readPlan(handle, draft.planId);
      if (planRow === null || planRow.planHash !== draft.planHash) {
        return fail(
          "storage-unavailable",
          `accepted plan ${draft.planId} changed mid-submit; inspect the rows, do not trust them`,
        );
      }
      const extraction = handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.id, draft.extractionId))
        .get();
      if (extraction === undefined) {
        return fail(
          "storage-unavailable",
          `binding extraction ${draft.extractionId} vanished mid-submit`,
        );
      }
      try {
        envelopeDescription = parseStoredExtraction(
          JSON.parse(extraction.extractedJson) as unknown,
        ).fields.descriptionText;
      } catch {
        return fail(
          "storage-unavailable",
          `stored extraction ${draft.extractionId} failed strict validation; inspect the row, do not trust it`,
        );
      }
      if (sha256HexUtf8(canonicalText(envelopeDescription ?? "")) !== draft.jdHash) {
        return fail("plan-stale", "retained job description bytes changed during submission");
      }
      const evidence = verifyCapturedEvidence(handle, {
        profileId: draft.profileId,
        profileVersionId: draft.profileVersionId,
        profilePayloadHash: draft.profilePayloadHash,
        evidenceHash: draft.evidenceHash,
      });
      if (evidence.ok !== true) {
        return fail("profile-not-ready", "captured profile evidence changed during submission");
      }
    } else {
      if (job.activeExtractionId !== draft.extractionId) {
        return fail("input-stale", "binding extraction is no longer the job's active extraction");
      }
      const active = getActiveProfileVersion(handle, draft.profileId);
      if (active === null || active.id !== draft.profileVersionId) {
        return fail("input-stale", "binding profile version is no longer active");
      }
      const extraction = handle.db
        .select()
        .from(jobExtractions)
        .where(eq(jobExtractions.id, draft.extractionId))
        .get();
      if (extraction === undefined) {
        return fail("storage-unavailable", `binding extraction ${draft.extractionId} vanished mid-submit`);
      }
      try {
        envelopeDescription = parseStoredExtraction(
          JSON.parse(extraction.extractedJson) as unknown,
        ).fields.descriptionText;
      } catch {
        return fail(
          "storage-unavailable",
          `stored extraction ${draft.extractionId} failed strict validation; inspect the row, do not trust it`,
        );
      }
      if (sha256HexUtf8(canonicalText(envelopeDescription ?? "")) !== draft.jdHash) {
        return fail("input-stale", "retained job description bytes changed during submission");
      }
      const versionRow = getProfileVersion(handle, draft.profileVersionId);
      if (versionRow === null) {
        return fail(
          "storage-unavailable",
          `binding profile version ${draft.profileVersionId} vanished mid-submit`,
        );
      }
      let frozenPayload: StoredProfilePayload;
      try {
        frozenPayload = parseStoredProfilePayload(JSON.parse(versionRow.payloadJson) as unknown);
      } catch {
        return fail(
          "storage-unavailable",
          `stored profile version ${draft.profileVersionId} failed strict validation; inspect the row, do not trust it`,
        );
      }
      if (sha256HexUtf8(canonicalJson(frozenPayload)) !== draft.profileHash) {
        return fail("input-stale", "bound profile bytes changed during submission");
      }
    }
    if (draft.parentVersionId !== null) {
      const parent = handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, draft.parentVersionId))
        .get();
      if (parent === undefined || parent.jobId !== input.jobId) {
        return fail(
          "storage-unavailable",
          `draft parent version ${draft.parentVersionId} does not belong to job ${input.jobId}`,
        );
      }
      if (draft.requestKind === "REVISION" && parent.reviewState !== "AWAITING_REVIEW") {
        return fail(
          "input-stale",
          `draft parent version ${draft.parentVersionId} is no longer awaiting review`,
        );
      }
    }

    // Idempotent snapshots (nest-safe): any failure aborts before
    // the queue write, so snapshots never leak on rejection.
    const jd = getOrCreateJdSnapshot(handle, {
      jobId: input.jobId,
      extractionId: draft.extractionId,
      jdText: envelopeDescription ?? "",
    });
    if (!jd.ok) {
      return fail(
        "storage-unavailable",
        `JD snapshot failed mid-submit: ${jd.error === "empty-jd" ? "empty JD text" : jd.error}`,
      );
    }
    const candidate = getOrCreateCandidateSnapshot(handle, {
      profileVersionId: draft.profileVersionId,
    });
    if (!candidate.ok) {
      return fail(
        "storage-unavailable",
        candidate.error === "version-not-found"
          ? `profile version '${draft.profileVersionId}' is no longer available`
          : candidate.detail,
      );
    }

    const profile = getProfile(handle, draft.profileId);
    if (profile === null) {
      return fail(
        "storage-unavailable",
        `binding profile ${draft.profileId} vanished mid-submit`,
      );
    }
    const steering = SteeringSnapshotV1.parse({
      schemaVersion: "generation-steering/v1",
      profileId: profile.id,
      profileVersionId: draft.profileVersionId,
      profileName: profile.name,
      profileDisplayName: profile.displayName,
      executiveNarrative: profile.executiveNarrative,
      targetTitles: profile.workPreferences?.targetTitles ?? [],
      targetLocations: profile.workPreferences?.targetLocations ?? [],
      careerKeywords: profile.workPreferences?.careerKeywords ?? [],
      workMode: profile.workPreferences?.workMode ?? [],
      workAuthorization: profile.workPreferences?.workAuthorization ?? [],
      sponsorshipRequired: profile.workPreferences?.sponsorshipRequired ?? null,
      willingToRelocate: profile.workPreferences?.willingToRelocate ?? null,
      yearsOfExperience: profile.workPreferences?.yearsOfExperience ?? null,
    });
    // v2/v3 verdict ensure: reuse the latest row covering these
    // exact bytes (a concurrent validate call may have persisted
    // one), or persist the phase-0 replay. Either way the frozen
    // validation id below names an immutable row the worker
    // rechecks.
    let v2validationId: string | null = null;
    if (draft.format === "v2") {
      const derived = deriveStep2Segments({
        plan: draft.plan,
        master: masterBulletsByRole(draft.payload),
        summaryText: draft.draft.summaryText,
        operations: draft.draft.operations,
      });
      for (const candidate of readDraftValidationsByHash(handle, input.jobId, draft.draftHash)) {
        if (candidate.planId !== draft.planId || candidate.policyVersion !== "step2-claims/1") {
          continue;
        }
        let parsed: Step2ValidationV1Type;
        try {
          parsed = Step2ValidationV1.parse(JSON.parse(candidate.verdictJson) as unknown);
        } catch {
          continue;
        }
        if (parsed.planHash !== draft.planHash || parsed.draftHash !== draft.draftHash) {
          continue;
        }
        if (!verifyStep2VerdictCoverage({ derived, validation: parsed }).covered) {
          continue;
        }
        v2validationId = candidate.id;
        break;
      }
      if (v2validationId === null) {
        if (draft.computedValidation === null) {
          return fail(
            "storage-unavailable",
            "no verdict covers the frozen draft and none was computed; resubmit",
          );
        }
        v2validationId = insertDraftValidation(handle, {
          jobId: input.jobId,
          planId: draft.planId,
          workspaceRevision: input.workspaceRevision,
          draftHash: draft.draftHash,
          verdictJson: canonicalJson(draft.computedValidation),
          policyVersion: "step2-claims/1",
          now,
        }).id;
      }
    }
    if (draft.format === "v3") {
      const derived = deriveCorrectionSegments({
        plan: draft.plan,
        master: masterBulletsByRole(draft.payload),
        masterSummary: draft.payload.summary ?? "",
        summaryText: draft.draft.summaryText,
        summaryOrigin: draft.draft.summaryOrigin,
        operations: draft.draft.operations,
      });
      for (const candidate of readDraftValidationsByHash(handle, input.jobId, draft.draftHash)) {
        if (candidate.planId !== draft.planId || candidate.policyVersion !== "step2-claims/2") {
          continue;
        }
        const parsed = parseStoredValidation(candidate.verdictJson);
        if (parsed === null || parsed.version !== 2) {
          continue;
        }
        if (
          parsed.validation.planHash !== draft.planHash ||
          parsed.validation.draftHash !== draft.draftHash
        ) {
          continue;
        }
        if (!verifyCorrectionCoverage({ derived, validation: parsed.validation }).covered) {
          continue;
        }
        v2validationId = candidate.id;
        break;
      }
      if (v2validationId === null) {
        if (draft.computedValidation === null) {
          return fail(
            "storage-unavailable",
            "no verdict covers the frozen draft and none was computed; resubmit",
          );
        }
        v2validationId = insertDraftValidation(handle, {
          jobId: input.jobId,
          planId: draft.planId,
          workspaceRevision: input.workspaceRevision,
          draftHash: draft.draftHash,
          verdictJson: canonicalJson(draft.computedValidation),
          policyVersion: "step2-claims/2",
          now,
        }).id;
      }
    }
    // v2/v3 requests freeze steering in `step2_generation_inputs`,
    // so the legacy keyword/directive columns stay canonically
    // empty — the worker verifies that pin instead of a focus
    // projection.
    const keywords =
      draft.format === "v1" ? canonicalKeywordSet(draft.selectedTexts) : [];
    const directivesText =
      draft.format === "v1" && draft.focus.additionalGuidance !== ""
        ? draft.focus.additionalGuidance
        : null;
    const identity = generationRequestIdentity(input.requestId);
    const v2input = {
      requestIdentity: identity,
      jobId: input.jobId,
      extractionId: draft.extractionId,
      profileId: draft.profileId,
      profileVersionId: draft.profileVersionId,
      jdSnapshotId: jd.snapshotId,
      parentVersionId: draft.parentVersionId,
      requestKind: draft.requestKind,
      steeringSnapshot: steering,
      selectedKeywords: keywords,
      directivesText,
      revisionNote: draft.revisionNote,
    };
    const v2hash = hashGenerationRequest(v2input);
    let inputHash: string;
    if (draft.format === "v2") {
      if (v2validationId === null) {
        return fail(
          "storage-unavailable",
          "no verdict row was bound mid-submit; resubmit",
        );
      }
      inputHash = hashStep2WorkflowInput({
        workspaceRevision: input.workspaceRevision,
        planId: draft.planId,
        planHash: draft.planHash,
        draftHash: draft.draftHash,
        validationId: v2validationId,
        candidateSnapshotId: candidate.snapshotId,
        masterText: draft.masterText,
        masterTextHash: draft.masterTextHash,
        projectionVersion: "master-text/1",
        policies: draft.policies,
      });
    } else if (draft.format === "v3") {
      if (v2validationId === null) {
        return fail(
          "storage-unavailable",
          "no verdict row was bound mid-submit; resubmit",
        );
      }
      inputHash = hashStep2CorrectionWorkflowInput({
        workspaceRevision: input.workspaceRevision,
        planId: draft.planId,
        planHash: draft.planHash,
        draftHash: draft.draftHash,
        validationId: v2validationId,
        provenanceManifestHash: draft.provenanceManifestHash,
        candidateSnapshotId: candidate.snapshotId,
        masterText: draft.masterText,
        masterTextHash: draft.masterTextHash,
        projectionVersion: "master-text/1",
        policies: draft.policies,
      });
    } else {
      inputHash = hashWorkflowRequestInput({
        workspaceRevision: input.workspaceRevision,
        focus: draft.focus,
        recommendations: draft.recommendations,
        candidateSnapshotId: candidate.snapshotId,
        masterText: draft.masterText,
        masterTextHash: draft.masterTextHash,
        projectionVersion: "master-text/1",
      });
    }
    const v3hash = hashGenerationRequestV3(v2input, inputHash);
    const queuePayload = TailorQueuePayloadV3.parse({
      schemaVersion: TAILOR_QUEUE_SCHEMA_VERSION_V3,
      generationRequestId: input.requestId,
      jobId: input.jobId,
      extractionId: draft.extractionId,
      profileId: draft.profileId,
      profileVersionId: draft.profileVersionId,
      jdSnapshotId: jd.snapshotId,
      ...(draft.parentVersionId === null ? {} : { parentVersionId: draft.parentVersionId }),
      payloadHash: v2hash,
      inputHash,
    });

    // Work item → request → inputs in FK order; the partial unique
    // index backstops the liveness precheck against races.
    const workItemId = newId();
    try {
      handle.db
        .insert(workItems)
        .values({
          id: workItemId,
          kind: "TAILOR",
          idempotencyKey: identity,
          jobId: input.jobId,
          payloadJson: canonicalJson(queuePayload),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error: unknown) {
      if (isUniqueViolation(error, "work_items")) {
        return fail("generation-busy", "a tailoring run went live during submission", {
          currentRowVersion: job.rowVersion,
        });
      }
      throw error;
    }
    deps.testHooks?.afterQueueInsert?.();
    handle.db
      .insert(generationRequests)
      .values({
        id: input.requestId,
        requestIdentity: identity,
        jobId: input.jobId,
        extractionId: draft.extractionId,
        profileId: draft.profileId,
        profileVersionId: draft.profileVersionId,
        jdSnapshotId: jd.snapshotId,
        parentVersionId: draft.parentVersionId,
        requestKind: draft.requestKind,
        steeringSnapshotJson: canonicalJson(steering),
        selectedKeywordsJson: canonicalJson(keywords),
        directivesText,
        revisionNote: draft.revisionNote,
        payloadHash: v3hash,
        workItemId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertRequestInputs(handle, {
      requestId: input.requestId,
      workspaceRevision: input.workspaceRevision,
      submitHash,
      inputHash,
      candidateSnapshotId: candidate.snapshotId,
      focusJson: draft.format === "v1" ? canonicalJson(draft.focus) : canonicalJson(draft.draft),
      recommendationsJson:
        draft.format === "v1" ? canonicalJson(draft.recommendations) : canonicalJson(draft.plan),
      masterText: draft.masterText,
      masterTextHash: draft.masterTextHash,
      projectionVersion: "master-text/1",
      now,
    });
    if (draft.format === "v2" || draft.format === "v3") {
      if (v2validationId === null) {
        return fail("storage-unavailable", "no verdict row was bound mid-submit; resubmit");
      }
      // The trigger re-verifies plan/request/validation linkage;
      // any disagreement aborts the whole submission.
      insertStep2GenerationInputs(handle, {
        requestId: input.requestId,
        planId: draft.planId,
        planHash: draft.planHash,
        draftHash: draft.draftHash,
        validationId: v2validationId,
        editedInputsJson: draft.editedInputsJson,
        policyVersionsJson: canonicalJson(draft.policies),
        now,
      });
    }

    const fenced = casJobTailoringState(handle, {
      jobId: input.jobId,
      rowVersion: input.observedRowVersion,
      tailoringState: "PENDING",
      reasonCode: null,
      now,
    });
    if (!fenced) {
      return fail("job-conflict", "job changed during submission; reload and resubmit", {
        currentRowVersion: job.rowVersion,
      });
    }
    const stamped = markWorkspaceSubmitted(handle, {
      jobId: input.jobId,
      observedRevision: input.workspaceRevision,
      requestId: input.requestId,
      now,
    });
    if (!stamped.ok) {
      return fail("workspace-conflict", "workspace draft changed during submission; reload and resubmit", {
        currentWorkspaceRevision: stamped.currentRevision,
      });
    }

    if (draft.requestKind === "REVISION" && draft.parentVersionId !== null) {
      const parent = handle.db
        .select()
        .from(resumeVersions)
        .where(eq(resumeVersions.id, draft.parentVersionId))
        .get();
      if (parent === undefined) {
        return fail(
          "storage-unavailable",
          `draft parent version ${draft.parentVersionId} vanished mid-submit`,
        );
      }
      handle.db
        .update(resumeVersions)
        .set({ reviewState: "REVISION_REQUESTED", updatedAt: now })
        .where(eq(resumeVersions.id, draft.parentVersionId))
        .run();
      const digests = storedArtifactDigests(handle, draft.parentVersionId);
      handle.db
        .insert(resumeReviews)
        .values({
          id: newId(),
          resumeVersionId: draft.parentVersionId,
          action: "REVISION_REQUESTED",
          actor: "human",
          note: draft.revisionNote,
          resumeHash: resumeIdentityHash(parent),
          contentHash: parent.contentHash,
          artifactHashesJson: canonicalJson(digests),
          createdAt: now,
        })
        .run();
    }

    return {
      ok: true,
      requestId: input.requestId,
      workItemId,
      status: "QUEUED",
      replayed: false,
      jobRowVersion: input.observedRowVersion + 1,
      workspaceRevision: input.workspaceRevision + 1,
    };
  });
}
