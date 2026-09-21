import { canonicalJson, canonicalText } from "../domain/canonical";
import { CandidateSnapshotV1 } from "../domain/candidate";
import type { DatabaseHandle } from "../db/client";
import { parseVersionedPayload } from "../domain/envelopes";
import type { ReasonCode } from "../domain/enums";
import { parseStoredExtraction } from "../domain/extraction";
import { getProfileVersion, listFactsByVersion } from "../db/candidates";
import { failGenerationRequest, getGenerationRequest } from "../db/generation";
import type { GenerationRequest } from "../db/schema/generation";
import type { TailoringRequestInputs } from "../db/schema";
import type { Step2GenerationInput } from "../db/schema/step2";
import {
  parseStoredValidation,
  readDraftValidation,
  readJobExtractionJson,
  readPlan,
  readPreparationByJob,
  readStep2GenerationInputs,
} from "../db/step2";
import {
  getAnalysisByRequest,
  getCandidateSnapshotById,
  getJdSnapshotById,
  getJobSalaryState,
  getTailoringJob,
} from "../db/tailoring";
import type { JobAnalysis } from "../db/schema/analysis";
import { appendProgressFenced, readRequestInputs } from "../db/tailoringWorkspace";
import { verifyCapturedEvidence } from "../server/preparation";
import { utcNow } from "../db/utils";
import type { HandlerOutcome, WorkHandler, WorkHandlerContext } from "../queue/dispatch";
import { DEFAULT_LEASE_DURATION_MS } from "../queue/leases";
import {
  FocusV1,
  RecommendationV1,
  type FocusV1 as FocusV1Type,
  type RecommendationV1 as RecommendationV1Type,
  type TailoringStage,
} from "../domain/tailoringWorkspace";
import {
  PreparationPlanV1,
  Step2DraftV1,
  Step2EditedInputsV1,
  Step2PolicyVersionsV1,
  Step2ValidationV1,
  applyEditedBullets,
  deriveStep2Segments,
  masterBulletsByRole,
  type MasterBullet,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type Step2DraftV1 as Step2DraftV1Type,
  type Step2ValidationV1 as Step2ValidationV1Type,
} from "../domain/step2";
import {
  PreparationPlanV2,
  Step2DraftV2,
  Step2EditedInputsV2,
  Step2PolicyVersionsV2,
  deriveCorrectionSegments,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2DraftV2 as Step2DraftV2Type,
  type Step2ProvenanceEntryV2 as Step2ProvenanceEntryV2Type,
  type Step2ValidationV2 as Step2ValidationV2Type,
} from "../domain/step2Correction";
import { loadDocxTemplateBytes } from "../resumes/docx";
import { renderPdf as renderPdfWithBrowser } from "../resumes/pdf";
import type { BrowserSupplier } from "../scraping/browser";
import { createLogger } from "../security/logger";
import { adaptSnapshotProfile } from "./adapt";
import {
  ProviderAttemptV1,
  RESUME_PROPOSAL_SCHEMA_VERSION,
  ResumeProposalV1,
  type ResumeProposalV1 as ResumeProposalV1Type,
  type ProviderAttemptV1 as ProviderAttemptV1Type,
  type TailoringProvider,
} from "./contract";
import {
  buildFailure,
  encodeFailureDetail,
  failureCodeForReason,
  isExplicitOnlyFailureCode,
  launchSubcodeForSpawnCode,
  LeaseLostError,
  type FailureCode,
} from "./failures";
import type { EditedPlanInput } from "./draft";
import { orchestrateTailoring } from "./orchestrate";
import type { CandidateProfileInput } from "./schemas";
import {
  draftHashFor,
  hashStep2WorkflowInput,
  planHashFor,
  segmentTextHashFor,
  step2GenerationPolicies,
  verifyStep2VerdictCoverage,
  type Step2CoverageReport,
} from "./step2policy";
import {
  correctionDraftHashFor,
  correctionManifestHashFor,
  correctionPlanHashFor,
  correctionSegmentTextHashFor,
  hashStep2CorrectionWorkflowInput,
  step2CorrectionPolicies,
  validateCorrectionSegments,
  verifyCorrectionCoverage,
  type CorrectionCoverageReport,
} from "./step2CorrectionPolicy";
import {
  attachResumeVersion,
  beginTailorRun,
  failRequestRun,
  nextResumeVersion,
  recordAnalysis,
  releaseStaleRun,
  reopenTailorRun,
  type RunStart,
} from "./persist";
import { sha256HexUtf8 } from "./hash";
import { publishArtifacts } from "./publish";
import {
  TAILOR_QUEUE_SCHEMA_VERSION_V2,
  TailorQueuePayloadV2,
  canonicalKeywordSet,
  hashGenerationRequest,
  SteeringSnapshotV1,
  type TailorQueuePayloadV2 as TailorPayloadV2,
} from "./requests";
import {
  TAILOR_QUEUE_SCHEMA_VERSION_V3,
  TailorQueuePayloadV3,
  hashGenerationRequestV3,
  hashMasterText,
  hashWorkflowRequestInput,
  type TailorQueuePayloadV3 as TailorPayloadV3,
} from "./requestsV3";
import {
  backfillJobSalary,
  runSalaryFallback,
  type SalaryFallbackConfig,
} from "./salaryFallback";

const log = createLogger("tailor-handler");

/**
 * TAILOR queue handler (WO-1.2-D, extended by WO-1.3-F): accept v2
 * and v3 payloads, verify the pinned generation request (row
 * existence, hash match, same-job ownership, payload binding),
 * reopen-or-open a fenced run, execute the deterministic
 * orchestration, persist the linked analysis, publish artifacts,
 * and attach an immutable resume version.
 *
 * v2 runs keep their exact legacy behavior (prose error pairs, no
 * stage emission, exhaustion-only terminal moves). v3 runs verify
 * the immutable input extension, emit real stage boundaries through
 * the fenced progress table, renew the lease on a timer during the
 * provider await, persist versioned Failure envelopes, recover
 * analysis-only crashes from the saved proposal without a second
 * provider call, and fence publication on the live lease tuple.
 *
 * Provider work and rendering run outside any SQLite transaction;
 * every database write is a short fenced transaction. Outcomes:
 * SUCCEEDED converges (a SUCCEEDED request returns without work);
 * BLOCKED never retries (terminal corruption, fencing, or missing
 * provider); FAILED retries while attempts remain and moves the job
 * terminal on the final attempt — or immediately when the v3
 * failure is explicit-only (`terminal: true`).
 */

/** Attempt error when a pre-v1.2 payload reaches the worker. Never retries. */
export const LEGACY_QUEUE_REFUSED = "LEGACY_QUEUE_REFUSED";

export interface TailorHandlerDeps {
  artifactsDir: string;
  /** Null when no provider is configured: runs report BLOCKED. */
  provider: TailoringProvider | null;
  /**
   * R4-G salary sidecar. When set, runs missing salary text but existing
   * extraction text trigger one best-effort AI backfill before the fenced
   * run begins. Unset skips the step entirely (existing tests, offline use).
   */
  salaryFallback?: SalaryFallbackConfig;
  browser?: BrowserSupplier;
  /** Test seam; defaults to Chromium rendering through `browser`. */
  renderPdf?: (html: string) => Promise<{ bytes: Buffer }>;
  /** Test seam; defaults to the checked-in DOCX template. */
  docxTemplateBytes?: Buffer;
  clock?: () => string;
  /**
   * Renewal-timer factory (WO-1.3-F, v3 runs only). Defaults to one
   * `setInterval` per orchestration; tests inject a manual timer.
   */
  createRenewalTimer?: RenewalTimerFactory;
}

/**
 * One-shot interval owned by a single orchestration: the handler
 * starts it before the provider await and stops it in a `finally`.
 */
export interface RenewalTimer {
  stop(): void;
}

export type RenewalTimerFactory = (intervalMs: number, onTick: () => void) => RenewalTimer;

/** §6 renewal cadence: every min(30s, floor(lease/3)) during awaited work. */
export function renewalIntervalMs(leaseDurationMs: number): number {
  return Math.min(30_000, Math.floor(leaseDurationMs / 3));
}

function defaultRenewalTimer(intervalMs: number, onTick: () => void): RenewalTimer {
  const timer = setInterval(onTick, Math.max(1, intervalMs));
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}

interface VerifiedRequest {
  request: GenerationRequest;
  selectedKeywords: string[];
  directives: string | undefined;
  revisionNote: string | undefined;
}

type RequestVerification =
  | { ok: true; verified: VerifiedRequest }
  | { ok: false; errorCode: string; detail: string; requestId: string | null };

interface CheckedRequestRow {
  request: GenerationRequest;
  steering: SteeringSnapshotV1;
  selectedKeywords: string[];
}

type RequestRowCheck =
  | { ok: true; checked: CheckedRequestRow }
  | { ok: false; errorCode: string; detail: string; requestId: string | null };

interface QueueBindings {
  generationRequestId: string;
  jobId: string;
  extractionId: string;
  profileVersionId: string;
  jdSnapshotId: string;
  parentVersionId?: string;
}

/**
 * Shared request-row checks for v2 and v3 payloads: the row exists,
 * belongs to this item's job, carries the payload's pinned bindings,
 * and parses its steering/keywords. Terminal requests short-circuit —
 * a SUCCEEDED request converges without work, a FAILED one stays
 * failed. Hash verification is version-specific and lives with each
 * caller. Detail strings are the historical v2 texts, verbatim.
 */
function checkRequestRow(
  handle: DatabaseHandle,
  itemJobId: string | null,
  payload: QueueBindings,
): RequestRowCheck {
  const request = getGenerationRequest(handle, payload.generationRequestId);
  if (request === null) {
    return {
      ok: false,
      errorCode: "REQUEST_NOT_FOUND",
      detail:
        `generation request '${payload.generationRequestId}' does not exist; ` +
        "the item cannot execute without its pinned bindings",
      requestId: null,
    };
  }
  if (request.jobId !== payload.jobId || request.jobId !== itemJobId) {
    return {
      ok: false,
      errorCode: "REQUEST_JOB_MISMATCH",
      detail:
        `request '${request.id}' belongs to job '${request.jobId}' but the item ` +
        `targets job '${itemJobId ?? "none"}'; refusing to cross-execute`,
      requestId: request.id,
    };
  }
  if (
    payload.extractionId !== request.extractionId ||
    payload.profileVersionId !== request.profileVersionId ||
    payload.jdSnapshotId !== request.jdSnapshotId ||
    (payload.parentVersionId ?? null) !== request.parentVersionId
  ) {
    return {
      ok: false,
      errorCode: "REQUEST_BINDING_MISMATCH",
      detail:
        `queue payload bindings disagree with request '${request.id}'; ` +
        "the payload is treated as hostile and the item cannot execute",
      requestId: request.id,
    };
  }
  let steering: SteeringSnapshotV1;
  let selectedKeywords: unknown;
  try {
    steering = SteeringSnapshotV1.parse(JSON.parse(request.steeringSnapshotJson) as unknown);
    selectedKeywords = JSON.parse(request.selectedKeywordsJson) as unknown;
  } catch {
    return {
      ok: false,
      errorCode: "REQUEST_CORRUPT",
      detail: `request '${request.id}' carries unparseable steering or keywords; start a new run`,
      requestId: request.id,
    };
  }
  if (!Array.isArray(selectedKeywords) || !selectedKeywords.every((entry) => typeof entry === "string")) {
    return {
      ok: false,
      errorCode: "REQUEST_CORRUPT",
      detail: `request '${request.id}' carries malformed keywords; start a new run`,
      requestId: request.id,
    };
  }
  if (request.status === "SUCCEEDED") {
    const analysis = getAnalysisByRequest(handle, request.id);
    if (analysis === null) {
      return {
        ok: false,
        errorCode: "REQUEST_CORRUPT",
        detail:
          `request '${request.id}' is SUCCEEDED but its analysis is missing; ` +
          "the database is corrupt and needs operator attention",
        requestId: request.id,
      };
    }
  }
  if (request.status === "FAILED") {
    return {
      ok: false,
      errorCode: "REQUEST_ALREADY_FAILED",
      detail:
        `request '${request.id}' already failed (${request.errorCode ?? "unknown"}): ` +
        `${request.errorDetail ?? "no detail"}; start a new run instead of retrying`,
      requestId: request.id,
    };
  }
  return { ok: true, checked: { request, steering, selectedKeywords } };
}

/**
 * Verify a v2 pinned request: the shared row checks plus the v2 hash
 * recomputed from the stored fields. Unchanged by WO-1.3-F.
 */
function verifyGenerationRequest(
  handle: DatabaseHandle,
  itemJobId: string | null,
  payload: TailorPayloadV2,
): RequestVerification {
  const row = checkRequestRow(handle, itemJobId, payload);
  if (!row.ok) {
    return row;
  }
  const { request, steering, selectedKeywords } = row.checked;
  if (payload.payloadHash !== request.payloadHash) {
    return {
      ok: false,
      errorCode: "REQUEST_BINDING_MISMATCH",
      detail:
        `queue payload bindings disagree with request '${request.id}'; ` +
        "the payload is treated as hostile and the item cannot execute",
      requestId: request.id,
    };
  }
  const recomputed = hashGenerationRequest({
    requestIdentity: request.requestIdentity,
    jobId: request.jobId,
    extractionId: request.extractionId,
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    jdSnapshotId: request.jdSnapshotId,
    parentVersionId: request.parentVersionId,
    requestKind: request.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION",
    steeringSnapshot: steering,
    selectedKeywords,
    directivesText: request.directivesText,
    revisionNote: request.revisionNote,
  });
  if (recomputed !== request.payloadHash) {
    return {
      ok: false,
      errorCode: "REQUEST_HASH_MISMATCH",
      detail:
        `request '${request.id}' fails hash verification; the row was tampered with ` +
        "or half-written and cannot execute",
      requestId: request.id,
    };
  }
  return {
    ok: true,
    verified: {
      request,
      selectedKeywords,
      directives: request.directivesText ?? undefined,
      revisionNote: request.revisionNote ?? undefined,
    },
  };
}

/**
 * S2-D frozen edited-plan bundle: the verified draft, plan,
 * verdicts, and coverage the worker compiles. Exclusive with the
 * v1 focus pair — a request carries exactly one steering form.
 */
interface VerifiedStep2Bundle {
  format: "v2";
  draft: Step2DraftV1Type;
  plan: PreparationPlanV1Type;
  validation: Step2ValidationV1Type;
  coverage: Step2CoverageReport;
  master: MasterBullet[];
  profilePayloadHash: string;
  evidenceHash: string;
}

/**
 * S2-CP-B frozen correction bundle: the verified v2 draft, v2
 * plan, `step2-claims/2` verdicts, structural coverage, and the
 * frozen provenance manifest the worker compiles. Provenance
 * never blocks compilation; structural soundness does.
 */
interface VerifiedStep2BundleV3 {
  format: "v3";
  draft: Step2DraftV2Type;
  plan: PreparationPlanV2Type;
  validation: Step2ValidationV2Type;
  coverage: CorrectionCoverageReport;
  manifest: Step2ProvenanceEntryV2Type[];
  master: MasterBullet[];
  masterSummary: string;
  profilePayloadHash: string;
  evidenceHash: string;
}

interface VerifiedRequestV3 extends VerifiedRequest {
  focus?: FocusV1Type;
  recommendations?: RecommendationV1Type;
  step2?: VerifiedStep2Bundle | VerifiedStep2BundleV3;
  inputHash: string;
  candidateSnapshotId: string;
}

type RequestVerificationV3 =
  | { ok: true; verified: VerifiedRequestV3 }
  | {
      ok: false;
      code: FailureCode;
      stage: TailoringStage | null;
      /** Server-private log detail; never persisted to error_detail. */
      logDetail: string;
      requestId: string | null;
    };

function v3Refused(
  logDetail: string,
  requestId: string | null,
  code: FailureCode = "INPUT_STALE",
): Extract<RequestVerificationV3, { ok: false }> {
  return { ok: false, code, stage: null, logDetail, requestId };
}

/**
 * Verify an edited-plan (v2 draft) request (WO-1.3-S2-D): the
 * frozen plan/draft/verdict binding recomputed from immutable
 * rows — draft/plan parsing, edited-inputs agreement, policy
 * lineage, plan/draft hashes, plan-row pinning, captured-evidence
 * digest (never the active pointer), JD freshness over the live
 * extraction bytes, verdict coverage with every included segment
 * supported, advisory budget counts (never a refusal),
 * master-text hash, the v2/v3 request hashes, and the empty
 * keyword/directive pin. The worker never reads live workspace
 * state. Every disagreement is INPUT_STALE: the fix is a new
 * request, never a retry of this one.
 */
function verifyStep2GenerationRequest(
  handle: DatabaseHandle,
  checked: { request: GenerationRequest; steering: SteeringSnapshotV1; selectedKeywords: string[] },
  inputs: TailoringRequestInputs,
  step2: Step2GenerationInput,
): RequestVerificationV3 {
  const { request, steering, selectedKeywords } = checked;
  if (selectedKeywords.length !== 0 || request.directivesText !== null) {
    return v3Refused(
      `request '${request.id}' is an edited-plan run but carries legacy keywords/guidance; start a new run`,
      request.id,
    );
  }
  let draft: Step2DraftV1Type;
  let plan: PreparationPlanV1Type;
  try {
    draft = Step2DraftV1.parse(JSON.parse(inputs.focusJson) as unknown);
    plan = PreparationPlanV1.parse(JSON.parse(inputs.recommendationsJson) as unknown);
  } catch {
    return v3Refused(
      `request '${request.id}' carries unparseable frozen draft/plan; start a new run`,
      request.id,
    );
  }
  try {
    const edited = Step2EditedInputsV1.parse(JSON.parse(step2.editedInputsJson) as unknown);
    const policies = Step2PolicyVersionsV1.parse(JSON.parse(step2.policyVersionsJson) as unknown);
    const expected = step2GenerationPolicies();
    if (
      edited.planId !== draft.planId ||
      edited.summaryText !== draft.summaryText ||
      edited.summarySource !== draft.summarySource ||
      canonicalJson(edited.operations) !== canonicalJson(draft.operations) ||
      policies.claims !== expected.claims ||
      policies.master !== expected.master ||
      policies.prompt !== expected.prompt
    ) {
      throw new Error("edited inputs disagree with the frozen draft");
    }
  } catch {
    return v3Refused(
      `request '${request.id}' carries edited inputs that disagree with its frozen draft; start a new run`,
      request.id,
    );
  }
  if (
    planHashFor(plan) !== step2.planHash ||
    draft.planHash !== step2.planHash ||
    draft.planId !== step2.planId ||
    draftHashFor(draft) !== step2.draftHash
  ) {
    return v3Refused(
      `request '${request.id}' fails plan/draft hash verification; the frozen inputs were ` +
        "tampered with or half-written and cannot execute",
      request.id,
    );
  }
  const planRow = readPlan(handle, step2.planId);
  if (planRow === null || planRow.planHash !== step2.planHash) {
    return v3Refused(
      `request '${request.id}' pins a plan row that no longer matches; start a new run`,
      request.id,
    );
  }
  const preparation = readPreparationByJob(handle, request.jobId);
  if (preparation === null) {
    return v3Refused(
      `request '${request.id}' has no preparation row; start a new run`,
      request.id,
    );
  }
  const evidence = verifyCapturedEvidence(handle, {
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    profilePayloadHash: preparation.profilePayloadHash,
    evidenceHash: preparation.evidenceHash,
  });
  if (evidence.ok !== true) {
    return v3Refused(
      `request '${request.id}' captured evidence no longer verifies; start a new run`,
      request.id,
    );
  }
  const job = getTailoringJob(handle, request.jobId);
  if (job === null || job.activeExtractionId !== plan.extractionId) {
    return v3Refused(
      `request '${request.id}' plan predates the active job description; start a new run`,
      request.id,
    );
  }
  const rawExtraction = readJobExtractionJson(handle, plan.extractionId);
  let jdHash: string | null = null;
  try {
    jdHash =
      rawExtraction === null
        ? null
        : sha256HexUtf8(
            canonicalText(
              parseStoredExtraction(JSON.parse(rawExtraction) as unknown).fields
                .descriptionText ?? "",
            ),
          );
  } catch {
    jdHash = null;
  }
  if (jdHash === null || jdHash !== plan.jdHash) {
    return v3Refused(
      `request '${request.id}' job description bytes changed under its frozen plan; start a new run`,
      request.id,
    );
  }
  const verdictRow = readDraftValidation(handle, step2.validationId);
  if (
    verdictRow === null ||
    verdictRow.planId !== step2.planId ||
    verdictRow.draftHash !== step2.draftHash
  ) {
    return v3Refused(
      `request '${request.id}' pins a verdict row that no longer matches; start a new run`,
      request.id,
    );
  }
  let validation: Step2ValidationV1Type;
  try {
    validation = Step2ValidationV1.parse(JSON.parse(verdictRow.verdictJson) as unknown);
  } catch {
    return v3Refused(
      `request '${request.id}' carries an unparseable frozen validation; start a new run`,
      request.id,
    );
  }
  if (
    validation.planHash !== step2.planHash ||
    validation.draftHash !== step2.draftHash ||
    validation.policyVersion !== "step2-claims/1"
  ) {
    return v3Refused(
      `request '${request.id}' validation disagrees with its frozen draft; start a new run`,
      request.id,
    );
  }
  const master = masterBulletsByRole(evidence.bound.payload);
  const derived = deriveStep2Segments({
    plan,
    master,
    summaryText: draft.summaryText,
    operations: draft.operations,
  });
  const coverage = verifyStep2VerdictCoverage({ derived, validation });
  if (!coverage.covered || !coverage.allSupported) {
    return v3Refused(
      `request '${request.id}' carries unsupported included text; edit the draft and start a new run`,
      request.id,
    );
  }
  // Length guidance is advisory: the frozen budget counts ride
  // along for audit, but overflow never refuses the run.
  if (hashMasterText(inputs.masterText) !== inputs.masterTextHash) {
    return v3Refused(
      `request '${request.id}' carries a master projection whose hash disagrees; start a new run`,
      request.id,
    );
  }
  const v2input = {
    requestIdentity: request.requestIdentity,
    jobId: request.jobId,
    extractionId: request.extractionId,
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    jdSnapshotId: request.jdSnapshotId,
    parentVersionId: request.parentVersionId,
    requestKind: request.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION",
    steeringSnapshot: steering,
    selectedKeywords,
    directivesText: request.directivesText,
    revisionNote: request.revisionNote,
  };
  const recomputedInput = hashStep2WorkflowInput({
    workspaceRevision: inputs.workspaceRevision,
    planId: step2.planId,
    planHash: step2.planHash,
    draftHash: step2.draftHash,
    validationId: step2.validationId,
    candidateSnapshotId: inputs.candidateSnapshotId,
    masterText: inputs.masterText,
    masterTextHash: inputs.masterTextHash,
    projectionVersion: "master-text/1",
    policies: step2GenerationPolicies(),
  });
  if (recomputedInput !== inputs.inputHash) {
    return v3Refused(
      `request '${request.id}' fails input-hash verification; the frozen inputs were ` +
        "tampered with or half-written and cannot execute",
      request.id,
    );
  }
  if (hashGenerationRequestV3(v2input, inputs.inputHash) !== request.payloadHash) {
    return v3Refused(
      `request '${request.id}' fails v3 hash verification; the row was tampered with ` +
        "or half-written and cannot execute",
      request.id,
    );
  }
  return {
    ok: true,
    verified: {
      request,
      selectedKeywords,
      directives: undefined,
      revisionNote: request.revisionNote ?? undefined,
      step2: {
        format: "v2",
        draft,
        plan,
        validation,
        coverage,
        master,
        profilePayloadHash: preparation.profilePayloadHash,
        evidenceHash: preparation.evidenceHash,
      },
      inputHash: inputs.inputHash,
      candidateSnapshotId: inputs.candidateSnapshotId,
    },
  };
}

/**
 * Compile the verified bundle into the deterministic compiler
 * input: the frozen summary plus final bullets in display order.
 * Untouched master rows render snapshot fact bytes verbatim;
 * every other bullet renders its own op's supported verdict text
 * with that verdict's fact binding (matched by operation id, never
 * by text). Any skew throws — the caller fails the run loudly.
 */
function compileStep2EditedPlan(input: {
  profile: CandidateProfileInput;
  master: MasterBullet[];
  draft: Step2DraftV1Type;
  plan: PreparationPlanV1Type;
  coverage: Step2CoverageReport;
}): EditedPlanInput {
  const groups = applyEditedBullets({
    master: input.master,
    plan: input.plan,
    operations: input.draft.operations,
  });
  for (const group of groups) {
    if (group.roleId === "") {
      throw new Error("edited plan carries unplaceable unlinked bullets");
    }
  }
  const bySegment = new Map(
    input.coverage.segments.map((segment) => [segment.segmentId, segment]),
  );
  const summary = bySegment.get("summary");
  if (summary === undefined || !summary.supported) {
    throw new Error("edited summary has no supported verdict");
  }
  if (segmentTextHashFor(input.draft.summaryText) !== summary.textHash) {
    throw new Error("edited summary bytes disagree with their verdict");
  }
  const approved = new Map<string, CandidateProfileInput["verified_facts"][number]>();
  for (const fact of input.profile.verified_facts) {
    if (fact.verification_status === "approved") {
      approved.set(fact.fact_id, fact);
    }
  }
  const bullets: EditedPlanInput["bullets"] = [];
  for (const group of groups) {
    for (const bullet of group.bullets) {
      if (bullet.sourceOperationId === null) {
        if (bullet.factId === null) {
          throw new Error("untouched bullet carries no master fact");
        }
        const fact = approved.get(bullet.factId);
        if (fact === undefined) {
          throw new Error(`master fact '${bullet.factId}' is not approved in the bound snapshot`);
        }
        bullets.push({
          roleId: bullet.roleId,
          text: fact.text,
          factIds: [fact.fact_id],
          strategy: "verbatim",
        });
        continue;
      }
      const verdict = bySegment.get(`op:${bullet.sourceOperationId}`);
      if (verdict === undefined || !verdict.supported) {
        throw new Error(`bullet from op '${bullet.sourceOperationId}' has no supported verdict`);
      }
      if (segmentTextHashFor(bullet.text) !== verdict.textHash) {
        throw new Error(`bullet from op '${bullet.sourceOperationId}' disagrees with its verdict`);
      }
      bullets.push({
        roleId: bullet.roleId,
        text: bullet.text,
        factIds: [...verdict.factIds],
        strategy: "edited_plan",
      });
    }
  }
  return {
    summary: { text: input.draft.summaryText, factIds: [...summary.factIds] },
    bullets,
  };
}

/**
 * Verify a correction (v3 draft) request (WO-1.3-S2-CP-B): the
 * frozen v2 plan/draft/verdict/manifest binding recomputed from
 * immutable rows — draft/plan parsing, edited-inputs agreement,
 * policy lineage, plan/draft/manifest hashes, plan-row pinning,
 * captured-evidence digest (never the active pointer), JD
 * freshness over the live extraction bytes, re-derived
 * `step2-claims/2` verdicts with covered and structurally sound
 * segments, advisory budget counts (never a refusal),
 * master-text hash, the v2/v3 request hashes, and the empty
 * keyword/directive pin. The worker never reads live workspace
 * state. Structural failures are CLAIM_VALIDATION; every other
 * disagreement is INPUT_STALE: the fix is a new request, never
 * a retry of this one.
 */
function verifyStep2GenerationRequestV3(
  handle: DatabaseHandle,
  checked: { request: GenerationRequest; steering: SteeringSnapshotV1; selectedKeywords: string[] },
  inputs: TailoringRequestInputs,
  step2: Step2GenerationInput,
): RequestVerificationV3 {
  const { request, steering, selectedKeywords } = checked;
  if (selectedKeywords.length !== 0 || request.directivesText !== null) {
    return v3Refused(
      `request '${request.id}' is an edited-plan run but carries legacy keywords/guidance; start a new run`,
      request.id,
    );
  }
  let draft: Step2DraftV2Type;
  let plan: PreparationPlanV2Type;
  try {
    draft = Step2DraftV2.parse(JSON.parse(inputs.focusJson) as unknown);
    plan = PreparationPlanV2.parse(JSON.parse(inputs.recommendationsJson) as unknown);
  } catch {
    return v3Refused(
      `request '${request.id}' carries unparseable frozen draft/plan; start a new run`,
      request.id,
    );
  }
  let manifest: Step2ProvenanceEntryV2Type[];
  try {
    const edited = Step2EditedInputsV2.parse(JSON.parse(step2.editedInputsJson) as unknown);
    const policies = Step2PolicyVersionsV2.parse(JSON.parse(step2.policyVersionsJson) as unknown);
    const expected = step2CorrectionPolicies();
    if (
      edited.planId !== draft.planId ||
      edited.summaryText !== draft.summaryText ||
      edited.summaryOrigin !== draft.summaryOrigin ||
      canonicalJson(edited.operations) !== canonicalJson(draft.operations) ||
      policies.claims !== expected.claims ||
      policies.master !== expected.master ||
      policies.prompt !== expected.prompt
    ) {
      throw new Error("edited inputs disagree with the frozen draft");
    }
    manifest = edited.provenanceManifest;
  } catch {
    return v3Refused(
      `request '${request.id}' carries edited inputs that disagree with its frozen draft; start a new run`,
      request.id,
    );
  }
  if (
    correctionPlanHashFor(plan) !== step2.planHash ||
    draft.planHash !== step2.planHash ||
    draft.planId !== step2.planId ||
    correctionDraftHashFor(draft) !== step2.draftHash
  ) {
    return v3Refused(
      `request '${request.id}' fails plan/draft hash verification; the frozen inputs were ` +
        "tampered with or half-written and cannot execute",
      request.id,
    );
  }
  const planRow = readPlan(handle, step2.planId);
  if (planRow === null || planRow.planHash !== step2.planHash) {
    return v3Refused(
      `request '${request.id}' pins a plan row that no longer matches; start a new run`,
      request.id,
    );
  }
  const preparation = readPreparationByJob(handle, request.jobId);
  if (preparation === null) {
    return v3Refused(
      `request '${request.id}' has no preparation row; start a new run`,
      request.id,
    );
  }
  const evidence = verifyCapturedEvidence(handle, {
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    profilePayloadHash: preparation.profilePayloadHash,
    evidenceHash: preparation.evidenceHash,
  });
  if (evidence.ok !== true) {
    return v3Refused(
      `request '${request.id}' captured evidence no longer verifies; start a new run`,
      request.id,
    );
  }
  const job = getTailoringJob(handle, request.jobId);
  if (job === null || job.activeExtractionId !== plan.extractionId) {
    return v3Refused(
      `request '${request.id}' plan predates the active job description; start a new run`,
      request.id,
    );
  }
  const rawExtraction = readJobExtractionJson(handle, plan.extractionId);
  let jdHash: string | null = null;
  try {
    jdHash =
      rawExtraction === null
        ? null
        : sha256HexUtf8(
            canonicalText(
              parseStoredExtraction(JSON.parse(rawExtraction) as unknown).fields
                .descriptionText ?? "",
            ),
          );
  } catch {
    jdHash = null;
  }
  if (jdHash === null || jdHash !== plan.jdHash) {
    return v3Refused(
      `request '${request.id}' job description bytes changed under its frozen plan; start a new run`,
      request.id,
    );
  }
  const verdictRow = readDraftValidation(handle, step2.validationId);
  if (
    verdictRow === null ||
    verdictRow.planId !== step2.planId ||
    verdictRow.draftHash !== step2.draftHash
  ) {
    return v3Refused(
      `request '${request.id}' pins a verdict row that no longer matches; start a new run`,
      request.id,
    );
  }
  const storedValidation = parseStoredValidation(verdictRow.verdictJson);
  if (storedValidation === null || storedValidation.version !== 2) {
    return v3Refused(
      `request '${request.id}' carries an unparseable frozen validation; start a new run`,
      request.id,
    );
  }
  const validation = storedValidation.validation;
  if (
    validation.planHash !== step2.planHash ||
    validation.draftHash !== step2.draftHash ||
    validation.policyVersion !== "step2-claims/2"
  ) {
    return v3Refused(
      `request '${request.id}' validation disagrees with its frozen draft; start a new run`,
      request.id,
    );
  }
  const master = masterBulletsByRole(evidence.bound.payload);
  const masterSummary = evidence.bound.payload.summary ?? "";
  const derived = deriveCorrectionSegments({
    plan,
    master,
    masterSummary,
    summaryText: draft.summaryText,
    summaryOrigin: draft.summaryOrigin,
    operations: draft.operations,
  });
  // The worker re-derives verdicts over the frozen bytes (never
  // trusting the persisted row alone) and requires covered,
  // structurally sound segments. Provenance never blocks.
  const versionRow = getProfileVersion(handle, request.profileVersionId);
  if (versionRow === null) {
    return v3Refused(
      `request '${request.id}' captured profile version is gone; start a new run`,
      request.id,
    );
  }
  const employmentOf = new Map<string, string>();
  const metricsByFact = new Map<string, string[]>();
  for (const achievement of evidence.bound.payload.achievements) {
    if (achievement.employmentId !== undefined) {
      employmentOf.set(achievement.factId, achievement.employmentId);
    }
    metricsByFact.set(achievement.factId, [...achievement.metrics]);
  }
  const now = utcNow();
  const recomputed = validateCorrectionSegments({
    segments: derived,
    plan,
    planHash: step2.planHash,
    draftHash: step2.draftHash,
    boundProfileVersionId: request.profileVersionId,
    snapshotFacts: listFactsByVersion(handle, request.profileVersionId).map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      verification: fact.verification,
      profileVersionId: request.profileVersionId,
      employmentId: employmentOf.get(fact.factId) ?? null,
      metrics: metricsByFact.get(fact.factId) ?? [],
    })),
    master,
    masterSummary,
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
  const coverage = verifyCorrectionCoverage({ derived, validation: recomputed });
  if (!coverage.covered || !coverage.allStructuralOk) {
    return v3Refused(
      `request '${request.id}' carries structurally blocked included text; edit the draft and start a new run`,
      request.id,
      "CLAIM_VALIDATION",
    );
  }
  // Length guidance is advisory: the recomputed budget counts
  // ride along for audit, but overflow never refuses the run.
  if (hashMasterText(inputs.masterText) !== inputs.masterTextHash) {
    return v3Refused(
      `request '${request.id}' carries a master projection whose hash disagrees; start a new run`,
      request.id,
    );
  }
  const v2input = {
    requestIdentity: request.requestIdentity,
    jobId: request.jobId,
    extractionId: request.extractionId,
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    jdSnapshotId: request.jdSnapshotId,
    parentVersionId: request.parentVersionId,
    requestKind: request.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION",
    steeringSnapshot: steering,
    selectedKeywords,
    directivesText: request.directivesText,
    revisionNote: request.revisionNote,
  };
  const recomputedInput = hashStep2CorrectionWorkflowInput({
    workspaceRevision: inputs.workspaceRevision,
    planId: step2.planId,
    planHash: step2.planHash,
    draftHash: step2.draftHash,
    validationId: step2.validationId,
    provenanceManifestHash: correctionManifestHashFor(manifest),
    candidateSnapshotId: inputs.candidateSnapshotId,
    masterText: inputs.masterText,
    masterTextHash: inputs.masterTextHash,
    projectionVersion: "master-text/1",
    policies: step2CorrectionPolicies(),
  });
  if (recomputedInput !== inputs.inputHash) {
    return v3Refused(
      `request '${request.id}' fails input-hash verification; the frozen inputs were ` +
        "tampered with or half-written and cannot execute",
      request.id,
    );
  }
  if (hashGenerationRequestV3(v2input, inputs.inputHash) !== request.payloadHash) {
    return v3Refused(
      `request '${request.id}' fails v3 hash verification; the row was tampered with ` +
        "or half-written and cannot execute",
      request.id,
    );
  }
  return {
    ok: true,
    verified: {
      request,
      selectedKeywords,
      directives: undefined,
      revisionNote: request.revisionNote ?? undefined,
      step2: {
        format: "v3",
        draft,
        plan,
        validation,
        coverage,
        manifest,
        master,
        masterSummary,
        profilePayloadHash: preparation.profilePayloadHash,
        evidenceHash: preparation.evidenceHash,
      },
      inputHash: inputs.inputHash,
      candidateSnapshotId: inputs.candidateSnapshotId,
    },
  };
}

/**
 * Compile the verified correction bundle into the deterministic
 * compiler input: the frozen summary plus final bullets in display
 * order. Untouched master rows render snapshot fact bytes
 * verbatim; every other bullet renders its own op's exact bytes
 * with that manifest entry's anchor binding (matched by operation
 * id, never by text). Manifest text hashes must equal the
 * rendered bytes — any skew throws and the run fails loudly.
 * Provenance labels travel with the manifest for review; they
 * never alter rendering.
 */
function compileStep2EditedPlanV3(input: {
  profile: CandidateProfileInput;
  master: MasterBullet[];
  draft: Step2DraftV2Type;
  plan: PreparationPlanV2Type;
  manifest: Step2ProvenanceEntryV2Type[];
}): EditedPlanInput {
  const groups = applyEditedBullets({
    master: input.master,
    plan: input.plan,
    operations: input.draft.operations,
  });
  for (const group of groups) {
    if (group.roleId === "") {
      throw new Error("edited plan carries unplaceable unlinked bullets");
    }
  }
  const bySegment = new Map(input.manifest.map((entry) => [entry.segmentId, entry]));
  let summaryFactIds: string[] = [];
  if (input.draft.summaryText !== "") {
    const summary = bySegment.get("summary");
    if (summary === undefined || summary.kind !== "summary") {
      throw new Error("edited summary has no manifest entry");
    }
    if (correctionSegmentTextHashFor(input.draft.summaryText) !== summary.textHash) {
      throw new Error("edited summary bytes disagree with their manifest entry");
    }
    summaryFactIds = [...summary.anchorFactIds];
  }
  const approved = new Map<string, CandidateProfileInput["verified_facts"][number]>();
  for (const fact of input.profile.verified_facts) {
    if (fact.verification_status === "approved") {
      approved.set(fact.fact_id, fact);
    }
  }
  const bullets: EditedPlanInput["bullets"] = [];
  for (const group of groups) {
    for (const bullet of group.bullets) {
      if (bullet.sourceOperationId === null) {
        if (bullet.factId === null) {
          throw new Error("untouched bullet carries no master fact");
        }
        const fact = approved.get(bullet.factId);
        if (fact === undefined) {
          throw new Error(`master fact '${bullet.factId}' is not approved in the bound snapshot`);
        }
        bullets.push({
          roleId: bullet.roleId,
          text: fact.text,
          factIds: [fact.fact_id],
          strategy: "verbatim",
        });
        continue;
      }
      const entry = bySegment.get(`op:${bullet.sourceOperationId}`);
      if (entry === undefined || entry.kind !== "bullet") {
        throw new Error(`bullet from op '${bullet.sourceOperationId}' has no manifest entry`);
      }
      if (correctionSegmentTextHashFor(bullet.text) !== entry.textHash) {
        throw new Error(`bullet from op '${bullet.sourceOperationId}' disagrees with its manifest entry`);
      }
      bullets.push({
        roleId: bullet.roleId,
        text: bullet.text,
        factIds: [...entry.anchorFactIds],
        strategy: "edited_plan",
      });
    }
  }
  return {
    summary: { text: input.draft.summaryText, factIds: summaryFactIds },
    bullets,
  };
}

/**
 * Verify a v3 pinned request (WO-1.3-F): the shared row checks, then
 * the immutable input extension — payload/row input-hash agreement,
 * strict focus/recommendation parsing, input-hash recomputation from
 * the frozen components, master-text hash, the v2 hash the payload
 * carries, the v3 hash the row carries, and the keyword/guidance
 * projections G froze from the focus. Every disagreement is
 * INPUT_STALE: the fix is a new request, never a retry of this one.
 */
function verifyGenerationRequestV3(
  handle: DatabaseHandle,
  itemJobId: string | null,
  payload: TailorPayloadV3,
): RequestVerificationV3 {
  const row = checkRequestRow(handle, itemJobId, payload);
  if (!row.ok) {
    return v3Refused(`${row.errorCode}: ${row.detail}`, row.requestId);
  }
  const { request, steering, selectedKeywords } = row.checked;
  const inputs = readRequestInputs(handle, request.id);
  if (inputs === null) {
    return v3Refused(
      `request '${request.id}' has no immutable input extension; start a new run`,
      request.id,
    );
  }
  if (payload.inputHash !== inputs.inputHash) {
    return v3Refused(
      `queue payload input hash disagrees with request '${request.id}'; ` +
        "the payload is treated as hostile and the item cannot execute",
      request.id,
    );
  }
  // S2-D: edited-plan requests carry a `step2_generation_inputs`
  // row and verify through the frozen plan/draft/verdict binding
  // instead of the v1 focus pair. Old rows never have that row.
  // S2-CP-B: v3 correction drafts discriminate by the frozen
  // draft's schemaVersion and verify through the provenance-aware
  // binding; v1 paths never compile them.
  const step2row = readStep2GenerationInputs(handle, request.id);
  if (step2row !== null) {
    let draftVersion: unknown;
    try {
      draftVersion = (JSON.parse(inputs.focusJson) as { schemaVersion?: unknown }).schemaVersion;
    } catch {
      draftVersion = null;
    }
    if (draftVersion === "step2-draft/v2") {
      return verifyStep2GenerationRequestV3(handle, { request, steering, selectedKeywords }, inputs, step2row);
    }
    return verifyStep2GenerationRequest(handle, { request, steering, selectedKeywords }, inputs, step2row);
  }
  let focus: FocusV1Type;
  let recommendations: RecommendationV1Type;
  try {
    focus = FocusV1.parse(JSON.parse(inputs.focusJson) as unknown);
    recommendations = RecommendationV1.parse(JSON.parse(inputs.recommendationsJson) as unknown);
  } catch {
    return v3Refused(
      `request '${request.id}' carries unparseable frozen focus; start a new run`,
      request.id,
    );
  }
  const recomputedInput = hashWorkflowRequestInput({
    workspaceRevision: inputs.workspaceRevision,
    focus,
    recommendations,
    candidateSnapshotId: inputs.candidateSnapshotId,
    masterText: inputs.masterText,
    masterTextHash: inputs.masterTextHash,
    projectionVersion: "master-text/1",
  });
  if (recomputedInput !== inputs.inputHash) {
    return v3Refused(
      `request '${request.id}' fails input-hash verification; the frozen inputs were ` +
        "tampered with or half-written and cannot execute",
      request.id,
    );
  }
  if (hashMasterText(inputs.masterText) !== inputs.masterTextHash) {
    return v3Refused(
      `request '${request.id}' carries a master projection whose hash disagrees; start a new run`,
      request.id,
    );
  }
  const v2input = {
    requestIdentity: request.requestIdentity,
    jobId: request.jobId,
    extractionId: request.extractionId,
    profileId: request.profileId,
    profileVersionId: request.profileVersionId,
    jdSnapshotId: request.jdSnapshotId,
    parentVersionId: request.parentVersionId,
    requestKind: request.requestKind as "INITIAL" | "NEW_VERSION" | "REVISION",
    steeringSnapshot: steering,
    selectedKeywords,
    directivesText: request.directivesText,
    revisionNote: request.revisionNote,
  };
  if (hashGenerationRequest(v2input) !== payload.payloadHash) {
    return v3Refused(
      `request '${request.id}' fails hash verification; the row was tampered with ` +
        "or half-written and cannot execute",
      request.id,
    );
  }
  if (hashGenerationRequestV3(v2input, inputs.inputHash) !== request.payloadHash) {
    return v3Refused(
      `request '${request.id}' fails v3 hash verification; the row was tampered with ` +
        "or half-written and cannot execute",
      request.id,
    );
  }
  const phraseTextById = new Map(recommendations.phrases.map((phrase) => [phrase.id, phrase.text]));
  const selectedTexts: string[] = [];
  for (const phraseId of focus.selectedPhraseIds) {
    const text = phraseTextById.get(phraseId);
    if (text === undefined) {
      return v3Refused(
        `request '${request.id}' selects an unknown recommendation phrase; start a new run`,
        request.id,
      );
    }
    selectedTexts.push(text);
  }
  const projected = canonicalKeywordSet(selectedTexts);
  if (
    projected.length !== selectedKeywords.length ||
    projected.some((term, index) => term !== selectedKeywords[index])
  ) {
    return v3Refused(
      `request '${request.id}' keywords disagree with its frozen focus; start a new run`,
      request.id,
    );
  }
  if ((request.directivesText ?? "") !== focus.additionalGuidance) {
    return v3Refused(
      `request '${request.id}' guidance disagrees with its frozen focus; start a new run`,
      request.id,
    );
  }
  return {
    ok: true,
    verified: {
      request,
      selectedKeywords,
      directives: request.directivesText ?? undefined,
      revisionNote: request.revisionNote ?? undefined,
      focus,
      recommendations,
      inputHash: inputs.inputHash,
      candidateSnapshotId: inputs.candidateSnapshotId,
    },
  };
}

/**
 * Terminal failure: move the job and fail the request atomically. When
 * the job moved concurrently (fenced), the request bookkeeping is
 * still failed so the run cannot strand a live request. v3 callers
 * pass the precise Failure code as the reason with a versioned
 * detail envelope; v2 callers pass legacy prose pairs.
 */
function terminalFail(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    requestId: string;
    rowVersion: number;
    to: "FAILED" | "BLOCKED";
    reasonCode: ReasonCode;
    errorDetail: string;
    now: string;
  },
): void {
  const moved = failRequestRun(handle, input);
  if (!moved.ok) {
    failGenerationRequest(handle, {
      requestId: input.requestId,
      errorCode: input.reasonCode,
      errorDetail: input.errorDetail,
      now: input.now,
    });
  }
}

/** True when a SQLite error is the v1.3 `LEASE_LOST` fence abort. */
export function isLeaseLostViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("LEASE_LOST");
}

const PROGRESS_STAGE_SEQ: Record<TailoringStage, 1 | 2 | 3 | 4 | 5> = {
  PREPARING_INPUTS: 1,
  WAITING_FOR_PROVIDER: 2,
  VALIDATING_PROPOSAL: 3,
  RENDERING_ARTIFACTS: 4,
  PUBLISHING_RESULT: 5,
};

export interface ProgressEmitter {
  /** Orchestration hook: the three middle stages at real boundaries. */
  emit(stage: "WAITING_FOR_PROVIDER" | "VALIDATING_PROPOSAL" | "RENDERING_ARTIFACTS"): void;
  /** Handler-owned boundaries: seq 1 after valid inputs, seq 5 before attach. */
  emitStage(stage: TailoringStage): void;
  /** Last stage emitted (null before seq 1); stages failure detail. */
  readonly lastStage: TailoringStage | null;
}

/**
 * Fenced stage emitter (WO-1.3-F, v3 runs only). Each emission is one
 * short transaction rechecking the live lease tuple; a dead lease
 * raises LeaseLostError so the run aborts write-free. Any other
 * trigger rejection (sequence/source bugs) propagates as-is — those
 * are handler bugs, never lease loss.
 */
export function createProgressEmitter(
  handle: DatabaseHandle,
  input: {
    requestId: string;
    workItemId: string;
    attemptId: string;
    leaseToken: string;
    source: "provider" | "cached";
    clock: () => string;
  },
): ProgressEmitter {
  let lastStage: TailoringStage | null = null;
  const emitStage = (stage: TailoringStage): void => {
    try {
      appendProgressFenced(handle, {
        requestId: input.requestId,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        seq: PROGRESS_STAGE_SEQ[stage],
        stage,
        source: input.source,
        leaseToken: input.leaseToken,
        recordedAt: input.clock(),
      });
    } catch (error: unknown) {
      if (isLeaseLostViolation(error)) {
        throw new LeaseLostError();
      }
      throw error;
    }
    lastStage = stage;
  };
  return {
    emit: (stage) => emitStage(stage),
    emitStage,
    get lastStage() {
      return lastStage;
    },
  };
}

/**
 * Fail one v3 request's bookkeeping with a versioned Failure envelope.
 * Returns the persisted detail so the outcome carries identical bytes.
 */
function failRequestV3(
  handle: DatabaseHandle,
  input: {
    requestId: string;
    code: FailureCode;
    stage: TailoringStage | null;
    retryAfterSeconds?: number | null;
    launchSubcode?: string | null;
    now: string;
  },
): string {
  const detail = encodeFailureDetail(
    buildFailure(input.code, {
      stage: input.stage,
      occurredAt: input.now,
      retryAfterSeconds: input.retryAfterSeconds ?? null,
      launchSubcode: launchSubcodeForSpawnCode(input.launchSubcode ?? null),
    }),
  );
  failGenerationRequest(handle, {
    requestId: input.requestId,
    errorCode: input.code,
    errorDetail: detail,
    now: input.now,
  });
  return detail;
}

function failedOutcomeV3(
  code: FailureCode,
  stage: TailoringStage | null,
  now: string,
  extra: {
    retryAfterSeconds?: number | null;
    launchSubcode?: string | null;
    terminal?: boolean;
    inputHash?: string;
    outputHash?: string;
  } = {},
): HandlerOutcome {
  return {
    result: "FAILED",
    errorCode: code,
    errorDetail: encodeFailureDetail(
      buildFailure(code, {
        stage,
        occurredAt: now,
        retryAfterSeconds: extra.retryAfterSeconds ?? null,
        launchSubcode: launchSubcodeForSpawnCode(extra.launchSubcode ?? null),
      }),
    ),
    ...(extra.terminal === true ? { terminal: true as const } : {}),
    ...(extra.inputHash === undefined ? {} : { inputHash: extra.inputHash }),
    ...(extra.outputHash === undefined ? {} : { outputHash: extra.outputHash }),
  };
}

interface CachedProposal {
  proposal: ResumeProposalV1Type;
  attempt: ProviderAttemptV1Type;
}

/**
 * Rebuild the validated proposal from a persisted analysis row for
 * crash recovery (WO-1.3-F §6): the canonical requirements map back
 * onto the proposal shape and strict-parse, so a corrupt row fails
 * closed (null) instead of executing invented requirements. The
 * analysis keeps its original attempt lineage; the new resume binds
 * to the publishing attempt at attach time.
 */
export function restoreCachedProposal(analysis: JobAnalysis): CachedProposal | null {
  try {
    const stored = JSON.parse(analysis.requirementsJson) as unknown;
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
      return null;
    }
    const requirements = (stored as Record<string, unknown>)["requirements"];
    if (!Array.isArray(requirements)) {
      return null;
    }
    const attempt = ProviderAttemptV1.parse(JSON.parse(analysis.attemptJson ?? "null") as unknown);
    if (analysis.rationale === null) {
      return null;
    }
    const proposal = ResumeProposalV1.parse({
      schemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
      jdSnapshotId: analysis.jdSnapshotId,
      candidateSnapshotId: analysis.candidateSnapshotId,
      requirements: requirements.map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          requirement_id: record["requirement_id"],
          jd_quote: record["jd_quote"],
          ...(record["description"] === undefined ? {} : { description: record["description"] }),
          category: record["category"],
          importance: record["importance"],
          match_status: record["match_status"],
          evidence_fact_ids: record["evidence_fact_ids"],
          evidence_quotes: record["evidence_quotes"],
          review_status: record["review_status"],
          ...(record["analysis_notes"] === undefined
            ? {}
            : { analysis_notes: record["analysis_notes"] }),
        };
      }),
      rationale: analysis.rationale,
      questions: attempt.questions,
    });
    return { proposal, attempt };
  } catch {
    return null;
  }
}

/**
 * R4-G Step-2 pre-step. Best-effort and outcome-neutral: every guard
 * miss, sidecar failure, and write skip returns quietly so salary can
 * never fail (or delay fencing for) the tailoring run it precedes.
 */
async function backfillMissingSalary(
  handle: DatabaseHandle,
  jobId: string,
  extractionId: string,
  config: SalaryFallbackConfig,
): Promise<void> {
  let state;
  try {
    state = getJobSalaryState(handle, jobId);
  } catch {
    return;
  }
  if (state === null) {
    return;
  }
  if (state.activeExtractionId !== extractionId) {
    return;
  }
  if (state.salaryText !== null && state.salaryText.trim() !== "") {
    return;
  }
  if (state.descriptionText === null || state.descriptionText.trim() === "") {
    return;
  }
  const facts = await runSalaryFallback({
    config,
    request: {
      jobTitle: state.title,
      company: state.company,
      location: state.location,
      jdText: state.descriptionText,
    },
    onDiagnostic: (message) => log.warn("salary fallback skipped run input", { jobId, message }),
  });
  if (facts === null) {
    return;
  }
  try {
    const outcome = backfillJobSalary(handle, { jobId, extractionId, facts });
    if (outcome === "written") {
      log.info("salary fallback backfilled job", { jobId, model: facts.model });
    }
  } catch {
    // Best-effort: a write fault must not fail the tailoring run.
  }
}

export function createTailorHandler(deps: TailorHandlerDeps): WorkHandler {
  const clock = deps.clock ?? utcNow;
  const docxTemplateBytes = deps.docxTemplateBytes ?? loadDocxTemplateBytes();
  const renderPdf =
    deps.renderPdf ??
    (async (html: string) => {
      if (deps.browser === undefined) {
        throw new Error("no PDF renderer configured");
      }
      return renderPdfWithBrowser(html, await deps.browser());
    });
  return async (context: WorkHandlerContext): Promise<HandlerOutcome> => {
    const now = clock();
    let rawPayload: unknown;
    try {
      rawPayload =
        context.item.payloadJson === null ? null : (JSON.parse(context.item.payloadJson) as unknown);
    } catch {
      rawPayload = undefined;
    }
    const parsed = parseVersionedPayload(
      {
        [TAILOR_QUEUE_SCHEMA_VERSION_V2]: TailorQueuePayloadV2,
        [TAILOR_QUEUE_SCHEMA_VERSION_V3]: TailorQueuePayloadV3,
      },
      rawPayload,
    );
    if (!parsed.ok) {
      const schemaVersion =
        typeof rawPayload === "object" && rawPayload !== null
          ? (rawPayload as Record<string, unknown>)["schemaVersion"]
          : undefined;
      const legacy = schemaVersion === "tailor-queue/v1";
      log.error("tailor payload refused", {
        workItemId: context.item.id,
        legacy,
        error: parsed.error,
      });
      return {
        result: "BLOCKED",
        errorCode: legacy ? LEGACY_QUEUE_REFUSED : "STALE_INPUT",
        errorDetail: legacy
          ? "legacy v1 queue payload refused: v1.2 runs require an explicit generation request; start one from the job"
          : `queue payload is unusable (${parsed.error}): ${parsed.detail}`,
      };
    }
    const isV3 = parsed.schemaVersion === TAILOR_QUEUE_SCHEMA_VERSION_V3;
    const payload = parsed.value as TailorPayloadV2 | TailorPayloadV3;
    const workAttemptId = context.item.currentAttemptId;
    if (workAttemptId === null) {
      throw new Error(`claimed item '${context.item.id}' carries no attempt id`);
    }
    // Attempts remaining after this one decide retryable vs terminal:
    // the claim already incremented the counter, matching completion's
    // exhaustion formula on the same leased row.
    const attemptsExhausted = context.item.attemptCount >= context.item.maxAttempts;

    let request: GenerationRequest;
    let selectedKeywords: string[];
    let directives: string | undefined;
    let revisionNote: string | undefined;
    let focus: FocusV1Type | undefined;
    let recommendations: RecommendationV1Type | undefined;
    let step2: VerifiedStep2Bundle | VerifiedStep2BundleV3 | undefined;
    let frozenCandidateSnapshotId: string | undefined;
    if (isV3) {
      const verification = verifyGenerationRequestV3(
        context.handle,
        context.item.jobId,
        payload as TailorPayloadV3,
      );
      if (!verification.ok) {
        log.error("generation request verification failed", {
          workItemId: context.item.id,
          errorCode: verification.code,
          detail: verification.logDetail,
        });
        if (!context.heartbeat()) {
          return failedOutcomeV3("LEASE_LOST", null, clock());
        }
        let detail: string;
        if (verification.requestId === null) {
          detail = encodeFailureDetail(
            buildFailure(verification.code, { stage: null, occurredAt: clock() }),
          );
        } else {
          // Release the job to READY so the human can start a fresh
          // run; a verification fault is never retried in place.
          const v3jobId = (payload as TailorPayloadV3).jobId;
          const job = getTailoringJob(context.handle, v3jobId);
          detail = encodeFailureDetail(
            buildFailure(verification.code, { stage: null, occurredAt: clock() }),
          );
          releaseStaleRun(context.handle, {
            jobId: v3jobId,
            requestId: verification.requestId,
            rowVersion: job?.rowVersion ?? -1,
            detail,
            now: clock(),
            errorCode: verification.code,
          });
        }
        return { result: "BLOCKED", errorCode: verification.code, errorDetail: detail };
      }
      request = verification.verified.request;
      selectedKeywords = verification.verified.selectedKeywords;
      directives = verification.verified.directives;
      revisionNote = verification.verified.revisionNote;
      focus = verification.verified.focus;
      recommendations = verification.verified.recommendations;
      step2 = verification.verified.step2;
      frozenCandidateSnapshotId = verification.verified.candidateSnapshotId;
    } else {
      const verification = verifyGenerationRequest(
        context.handle,
        context.item.jobId,
        payload as TailorPayloadV2,
      );
      if (!verification.ok) {
        if (verification.requestId !== null) {
          failGenerationRequest(context.handle, {
            requestId: verification.requestId,
            errorCode: verification.errorCode,
            errorDetail: verification.detail,
            now,
          });
        }
        log.error("generation request verification failed", {
          workItemId: context.item.id,
          errorCode: verification.errorCode,
        });
        return { result: "BLOCKED", errorCode: verification.errorCode, errorDetail: verification.detail };
      }
      request = verification.verified.request;
      selectedKeywords = verification.verified.selectedKeywords;
      directives = verification.verified.directives;
      revisionNote = verification.verified.revisionNote;
    }
    if (request.status === "SUCCEEDED") {
      // Idempotent completion: a crash between publish and attempt
      // completion replays here and converges without new output.
      const analysis = getAnalysisByRequest(context.handle, request.id);
      log.info("tailor run already complete", {
        workItemId: context.item.id,
        jobId: request.jobId,
        requestId: request.id,
        analysisId: analysis?.id ?? null,
      });
      return {
        result: "SUCCEEDED",
        inputHash: analysis?.inputHash ?? undefined,
        outputHash: analysis?.proposalHash ?? undefined,
      };
    }

    if (!context.heartbeat()) {
      if (isV3) {
        return failedOutcomeV3("LEASE_LOST", null, clock());
      }
      return { result: "FAILED", errorCode: "LEASE_EXPIRED", errorDetail: "lease lost before run" };
    }

    if (deps.provider === null) {
      if (isV3) {
        // Missing provider configuration blocks until a human
        // repairs Settings; the same input may retry explicitly.
        const detail = encodeFailureDetail(
          buildFailure("CONFIGURATION", { stage: null, occurredAt: clock() }),
        );
        const job = getTailoringJob(context.handle, request.jobId);
        if (job !== null) {
          terminalFail(context.handle, {
            jobId: request.jobId,
            requestId: request.id,
            rowVersion: job.rowVersion,
            to: "BLOCKED",
            reasonCode: "CONFIGURATION",
            errorDetail: detail,
            now: clock(),
          });
        } else {
          failGenerationRequest(context.handle, {
            requestId: request.id,
            errorCode: "CONFIGURATION",
            errorDetail: detail,
            now: clock(),
          });
        }
        return { result: "BLOCKED", errorCode: "CONFIGURATION", errorDetail: detail };
      }
      const job = getTailoringJob(context.handle, request.jobId);
      if (job !== null) {
        terminalFail(context.handle, {
          jobId: request.jobId,
          requestId: request.id,
          rowVersion: job.rowVersion,
          to: "BLOCKED",
          reasonCode: "PROVIDER_UNAVAILABLE",
          errorDetail: "no tailoring provider is configured; set TAILOR_PROVIDER_ARGV and retry",
          now,
        });
      } else {
        failGenerationRequest(context.handle, {
          requestId: request.id,
          errorCode: "PROVIDER_UNAVAILABLE",
          errorDetail: "no tailoring provider is configured; set TAILOR_PROVIDER_ARGV and retry",
          now,
        });
      }
      return {
        result: "BLOCKED",
        errorCode: "PROVIDER_UNAVAILABLE",
        errorDetail: "no tailoring provider is configured; set TAILOR_PROVIDER_ARGV and retry",
      };
    }
    const provider = deps.provider;

    if (deps.salaryFallback !== undefined) {
      await backfillMissingSalary(
        context.handle,
        request.jobId,
        request.extractionId,
        deps.salaryFallback,
      );
      if (!context.heartbeat()) {
        if (isV3) {
          return failedOutcomeV3("LEASE_LOST", null, clock());
        }
        return {
          result: "FAILED",
          errorCode: "LEASE_EXPIRED",
          errorDetail: "lease lost during salary fallback",
        };
      }
    }

    // §9 reopen: a RUNNING job under a fresh claim means the previous
    // attempt died without a terminal move; reset to PENDING so the
    // open below can proceed (the version bump fences zombie output).
    reopenTailorRun(context.handle, { jobId: request.jobId, now });
    const begun = beginTailorRun(context.handle, {
      jobId: request.jobId,
      request,
      now,
    });
    if (!begun.ok) {
      if (isV3) {
        if (!context.heartbeat()) {
          return failedOutcomeV3("LEASE_LOST", null, clock());
        }
        if (begun.error === "job-not-found") {
          const detail = failRequestV3(context.handle, {
            requestId: request.id,
            code: "INPUT_STALE",
            stage: null,
            now: clock(),
          });
          log.error("tailor run refused: job gone", {
            workItemId: context.item.id,
            detail: begun.detail,
          });
          return { result: "BLOCKED", errorCode: "INPUT_STALE", errorDetail: detail };
        }
        if (begun.error === "jd-stale") {
          const job = getTailoringJob(context.handle, request.jobId);
          const detail = encodeFailureDetail(
            buildFailure("INPUT_STALE", { stage: null, occurredAt: clock() }),
          );
          releaseStaleRun(context.handle, {
            jobId: request.jobId,
            requestId: request.id,
            rowVersion: job?.rowVersion ?? -1,
            detail,
            now: clock(),
            errorCode: "INPUT_STALE",
          });
          return { result: "BLOCKED", errorCode: "INPUT_STALE", errorDetail: detail };
        }
        if (begun.error === "profile-gone") {
          const detail = encodeFailureDetail(
            buildFailure("PROFILE_UNAVAILABLE", { stage: null, occurredAt: clock() }),
          );
          const job = getTailoringJob(context.handle, request.jobId);
          if (job !== null) {
            terminalFail(context.handle, {
              jobId: request.jobId,
              requestId: request.id,
              rowVersion: job.rowVersion,
              to: "FAILED",
              reasonCode: "PROFILE_UNAVAILABLE",
              errorDetail: detail,
              now: clock(),
            });
          } else {
            failGenerationRequest(context.handle, {
              requestId: request.id,
              errorCode: "PROFILE_UNAVAILABLE",
              errorDetail: detail,
              now: clock(),
            });
          }
          return { result: "BLOCKED", errorCode: "PROFILE_UNAVAILABLE", errorDetail: detail };
        }
        // Fenced or concurrently moved: someone else owns the job, so
        // only the request fails. Terminal — a retry would fence the
        // same way.
        const detail = failRequestV3(context.handle, {
          requestId: request.id,
          code: "INPUT_STALE",
          stage: null,
          now: clock(),
        });
        return { result: "BLOCKED", errorCode: "INPUT_STALE", errorDetail: detail };
      }
      if (begun.error === "job-not-found") {
        failGenerationRequest(context.handle, {
          requestId: request.id,
          errorCode: "STALE_INPUT",
          errorDetail: begun.detail,
          now,
        });
        return { result: "BLOCKED", errorCode: "STALE_INPUT", errorDetail: begun.detail };
      }
      if (begun.error === "jd-stale") {
        const job = getTailoringJob(context.handle, request.jobId);
        releaseStaleRun(context.handle, {
          jobId: request.jobId,
          requestId: request.id,
          rowVersion: job?.rowVersion ?? -1,
          detail: begun.detail,
          now,
        });
        return { result: "BLOCKED", errorCode: "STALE_INPUT", errorDetail: begun.detail };
      }
      if (begun.error === "profile-gone") {
        const job = getTailoringJob(context.handle, request.jobId);
        if (job !== null) {
          terminalFail(context.handle, {
            jobId: request.jobId,
            requestId: request.id,
            rowVersion: job.rowVersion,
            to: "FAILED",
            reasonCode: "PROFILE_REQUIRED",
            errorDetail: begun.detail,
            now,
          });
        } else {
          failGenerationRequest(context.handle, {
            requestId: request.id,
            errorCode: "PROFILE_REQUIRED",
            errorDetail: begun.detail,
            now,
          });
        }
        return { result: "BLOCKED", errorCode: "PROFILE_REQUIRED", errorDetail: begun.detail };
      }
      // Fenced or concurrently moved: someone else owns the job, so only
      // the request fails. Terminal — a retry would fence the same way.
      failGenerationRequest(context.handle, {
        requestId: request.id,
        errorCode: "STALE_INPUT",
        errorDetail: begun.detail,
        now,
      });
      return { result: "BLOCKED", errorCode: "STALE_INPUT", errorDetail: begun.detail };
    }
    const start: RunStart = begun.start;

    const jdSnapshot = getJdSnapshotById(context.handle, start.jdSnapshotId);
    const candidateSnapshot = getCandidateSnapshotById(context.handle, start.candidateSnapshotId);
    if (jdSnapshot === null || candidateSnapshot === null) {
      if (isV3) {
        // Immutable rows cannot vanish; retrying cannot heal corruption.
        if (!context.heartbeat()) {
          return failedOutcomeV3("LEASE_LOST", null, clock());
        }
        const detail = encodeFailureDetail(
          buildFailure("INPUT_STALE", { stage: "PREPARING_INPUTS", occurredAt: clock() }),
        );
        terminalFail(context.handle, {
          jobId: request.jobId,
          requestId: request.id,
          rowVersion: start.fenceVersion,
          to: "FAILED",
          reasonCode: "INPUT_STALE",
          errorDetail: detail,
          now: clock(),
        });
        return { result: "FAILED", errorCode: "INPUT_STALE", errorDetail: detail, terminal: true };
      }
      // Immutable rows cannot vanish; retrying cannot heal corruption.
      terminalFail(context.handle, {
        jobId: request.jobId,
        requestId: request.id,
        rowVersion: start.fenceVersion,
        to: "FAILED",
        reasonCode: "STALE_INPUT",
        errorDetail: "bound snapshots vanished mid-run",
        now: clock(),
      });
      return {
        result: "BLOCKED",
        errorCode: "STALE_INPUT",
        errorDetail: "bound snapshots vanished mid-run",
      };
    }
    let profile: ReturnType<typeof adaptSnapshotProfile>;
    try {
      const snapshot = CandidateSnapshotV1.parse(
        JSON.parse(candidateSnapshot.canonicalJson) as unknown,
      );
      if (sha256HexUtf8(canonicalJson(snapshot)) !== candidateSnapshot.sha256) {
        throw new Error("snapshot bytes do not match the recorded hash");
      }
      profile = adaptSnapshotProfile(snapshot);
    } catch (error: unknown) {
      if (isV3) {
        if (!context.heartbeat()) {
          return failedOutcomeV3("LEASE_LOST", null, clock());
        }
        const detail = encodeFailureDetail(
          buildFailure("INPUT_STALE", { stage: "PREPARING_INPUTS", occurredAt: clock() }),
        );
        log.error("tailor run refused: snapshot corrupt", {
          workItemId: context.item.id,
          detail: (error as Error).message,
        });
        terminalFail(context.handle, {
          jobId: request.jobId,
          requestId: request.id,
          rowVersion: start.fenceVersion,
          to: "FAILED",
          reasonCode: "INPUT_STALE",
          errorDetail: detail,
          now: clock(),
        });
        return { result: "FAILED", errorCode: "INPUT_STALE", errorDetail: detail, terminal: true };
      }
      terminalFail(context.handle, {
        jobId: request.jobId,
        requestId: request.id,
        rowVersion: start.fenceVersion,
        to: "FAILED",
        reasonCode: "STALE_INPUT",
        errorDetail: `bound candidate snapshot is corrupt: ${(error as Error).message}`,
        now: clock(),
      });
      return {
        result: "BLOCKED",
        errorCode: "STALE_INPUT",
        errorDetail: `bound candidate snapshot is corrupt: ${(error as Error).message}`,
      };
    }

    if (isV3 && start.candidateSnapshotId !== frozenCandidateSnapshotId) {
      // The resolved snapshot disagrees with the frozen input hash —
      // bound bytes drifted or corrupted after submission.
      if (!context.heartbeat()) {
        return failedOutcomeV3("LEASE_LOST", null, clock());
      }
      const detail = encodeFailureDetail(
        buildFailure("INPUT_STALE", { stage: "PREPARING_INPUTS", occurredAt: clock() }),
      );
      terminalFail(context.handle, {
        jobId: request.jobId,
        requestId: request.id,
        rowVersion: start.fenceVersion,
        to: "FAILED",
        reasonCode: "INPUT_STALE",
        errorDetail: detail,
        now: clock(),
      });
      return { result: "FAILED", errorCode: "INPUT_STALE", errorDetail: detail, terminal: true };
    }

    // S2-D: compile the verified edited bundle against the bound
    // snapshot profile. Any skew between the frozen verdicts and
    // the snapshot fails the run before any provider call — the
    // fix is a new request, never a retry of this one. S2-CP-B:
    // correction bundles compile against the frozen provenance
    // manifest instead of verdict fact sets.
    let editedPlan: EditedPlanInput | undefined;
    if (isV3 && step2 !== undefined) {
      try {
        editedPlan =
          step2.format === "v3"
            ? compileStep2EditedPlanV3({
                profile,
                master: step2.master,
                draft: step2.draft,
                plan: step2.plan,
                manifest: step2.manifest,
              })
            : compileStep2EditedPlan({
                profile,
                master: step2.master,
                draft: step2.draft,
                plan: step2.plan,
                coverage: step2.coverage,
              });
      } catch (error: unknown) {
        if (!context.heartbeat()) {
          return failedOutcomeV3("LEASE_LOST", null, clock());
        }
        const detail = encodeFailureDetail(
          buildFailure("INPUT_STALE", { stage: "PREPARING_INPUTS", occurredAt: clock() }),
        );
        log.error("tailor run refused: edited plan skew", {
          workItemId: context.item.id,
          detail: (error as Error).message,
        });
        terminalFail(context.handle, {
          jobId: request.jobId,
          requestId: request.id,
          rowVersion: start.fenceVersion,
          to: "FAILED",
          reasonCode: "INPUT_STALE",
          errorDetail: detail,
          now: clock(),
        });
        return { result: "FAILED", errorCode: "INPUT_STALE", errorDetail: detail, terminal: true };
      }
    }

    // Analysis-only crash recovery (v3): a persisted analysis from a
    // dead attempt resumes from the saved proposal — no second
    // provider call. The whole attempt is then source-tagged cached.
    let cached: CachedProposal | undefined;
    let progressSource: "provider" | "cached" = "provider";
    if (isV3) {
      const prior = getAnalysisByRequest(context.handle, request.id);
      if (prior !== null) {
        const restored = restoreCachedProposal(prior);
        if (restored === null) {
          if (!context.heartbeat()) {
            return failedOutcomeV3("LEASE_LOST", null, clock());
          }
          const detail = encodeFailureDetail(
            buildFailure("INTERNAL", { stage: "PREPARING_INPUTS", occurredAt: clock() }),
          );
          log.error("tailor run refused: saved analysis corrupt", {
            workItemId: context.item.id,
            analysisId: prior.id,
          });
          terminalFail(context.handle, {
            jobId: request.jobId,
            requestId: request.id,
            rowVersion: start.fenceVersion,
            to: "FAILED",
            reasonCode: "INTERNAL",
            errorDetail: detail,
            now: clock(),
          });
          return { result: "FAILED", errorCode: "INTERNAL", errorDetail: detail, terminal: true };
        }
        cached = restored;
        progressSource = "cached";
        log.info("tailor run resuming from saved proposal", {
          workItemId: context.item.id,
          analysisId: prior.id,
          originalAttemptId: prior.workAttemptId,
        });
      }
    }

    const emitter = isV3
      ? createProgressEmitter(context.handle, {
          requestId: request.id,
          workItemId: context.item.id,
          attemptId: workAttemptId,
          leaseToken: context.item.leaseToken,
          source: progressSource,
          clock,
        })
      : null;
    // Everything from seq 1 through publication runs under the lease:
    // any LeaseLostError aborts write-free (v2 never throws it).
    try {
      if (emitter !== null) {
        emitter.emitStage("PREPARING_INPUTS");
      }
      if (!context.heartbeat()) {
        if (isV3) {
          return failedOutcomeV3("LEASE_LOST", emitter?.lastStage ?? null, clock());
        }
        return { result: "FAILED", errorCode: "LEASE_EXPIRED", errorDetail: "lease lost before provider" };
      }
      const orchestrationInputs = {
        jobId: request.jobId,
        jobTitle: start.job.title,
        jobCompany: start.job.company,
        // The pinned snapshot text — not the live row — is the
        // generation input; live-row drift is fenced at attach time.
        jobDescription: jdSnapshot.jdText,
        profile,
        jdSnapshot: { id: jdSnapshot.id, jdText: jdSnapshot.jdText, createdAt: jdSnapshot.createdAt },
        candidateSnapshot: {
          id: candidateSnapshot.id,
          snapshotHash: candidateSnapshot.sha256,
          createdAt: candidateSnapshot.createdAt,
        },
        profileId: request.profileId,
        selectedKeywords,
        directives,
        revisionNote,
        ...(isV3 && focus !== undefined && recommendations !== undefined
          ? { focus, recommendations }
          : {}),
        ...(isV3 && editedPlan !== undefined ? { editedPlan } : {}),
      };
      let orchestrated: Awaited<ReturnType<typeof orchestrateTailoring>>;
      if (isV3 && emitter !== null) {
        // One renewal timer across the provider/render await; a failed
        // tick aborts the run after the await settles — publication is
        // forbidden once liveness is unverifiable.
        const createTimer = deps.createRenewalTimer ?? defaultRenewalTimer;
        let renewalLost = false;
        const timer = createTimer(
          renewalIntervalMs(context.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
          () => {
            try {
              if (!context.heartbeat()) {
                renewalLost = true;
              }
            } catch (error: unknown) {
              renewalLost = true;
              log.warn("lease renewal tick failed", {
                workItemId: context.item.id,
                detail: (error as Error).message,
              });
            }
          },
        );
        try {
          orchestrated = await orchestrateTailoring(orchestrationInputs, {
            provider,
            renderPdf,
            docxTemplateBytes,
            progress: emitter,
            ...(cached === undefined ? {} : { cached }),
          });
        } finally {
          timer.stop();
        }
        if (renewalLost) {
          throw new LeaseLostError();
        }
        // The lease may have died between the last tick and the
        // settle: recheck before any persist, or the analysis write
        // below would strand output under a dead attempt.
        if (!context.heartbeat()) {
          throw new LeaseLostError();
        }
      } else {
        orchestrated = await orchestrateTailoring(orchestrationInputs, {
          provider,
          renderPdf,
          docxTemplateBytes,
        });
      }

      let analysisId: string | null = null;
      const accepted = orchestrated.ok ? orchestrated.value : orchestrated.proposal;
      if (accepted !== null) {
        try {
          analysisId = recordAnalysis(context.handle, {
            jobId: request.jobId,
            jdSnapshotId: start.jdSnapshotId,
            candidateSnapshotId: start.candidateSnapshotId,
            proposal: accepted,
            providerId: provider.providerId,
            promptVersion: accepted.attempt.promptVersion,
            proposalSchemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
            generationRequestId: request.id,
            workAttemptId,
          });
        } catch (error: unknown) {
          // A lost UNIQUE race converges onto the winner's analysis; any
          // other persist fault is retryable until attempts exhaust.
          const existing = getAnalysisByRequest(context.handle, request.id);
          if (existing !== null) {
            analysisId = existing.id;
          } else if (isV3 && emitter !== null) {
            log.error("analysis persist failed", {
              workItemId: context.item.id,
              jobId: request.jobId,
              detail: (error as Error).message,
            });
            if (!context.heartbeat()) {
              return failedOutcomeV3("LEASE_LOST", emitter.lastStage, clock());
            }
            const detail = encodeFailureDetail(
              buildFailure("INTERNAL", { stage: emitter.lastStage, occurredAt: clock() }),
            );
            if (attemptsExhausted) {
              terminalFail(context.handle, {
                jobId: request.jobId,
                requestId: request.id,
                rowVersion: start.fenceVersion,
                to: "FAILED",
                reasonCode: "INTERNAL",
                errorDetail: detail,
                now: clock(),
              });
            }
            return { result: "FAILED", errorCode: "INTERNAL", errorDetail: detail };
          } else {
            log.error("analysis persist failed", {
              workItemId: context.item.id,
              jobId: request.jobId,
              detail: (error as Error).message,
            });
            const detail = `analysis persist failed: ${(error as Error).message}`;
            if (attemptsExhausted) {
              terminalFail(context.handle, {
                jobId: request.jobId,
                requestId: request.id,
                rowVersion: start.fenceVersion,
                to: "FAILED",
                reasonCode: "STALE_INPUT",
                errorDetail: detail,
                now: clock(),
              });
            }
            return { result: "FAILED", errorCode: "STALE_INPUT", errorDetail: detail };
          }
        }
      }

      if (!orchestrated.ok) {
        const hashes =
          accepted === null
            ? {}
            : { inputHash: accepted.inputHash, outputHash: accepted.proposalHash };
        if (isV3 && emitter !== null) {
          const code = failureCodeForReason(orchestrated.reason);
          const terminal = isExplicitOnlyFailureCode(code);
          const stage = orchestrated.stage ?? emitter.lastStage;
          log.error("tailor run orchestration failed", {
            workItemId: context.item.id,
            errorCode: code,
            stage,
            detail: orchestrated.detail,
          });
          if (!context.heartbeat()) {
            return failedOutcomeV3("LEASE_LOST", emitter.lastStage, clock());
          }
          const detail = encodeFailureDetail(
            buildFailure(code, {
              stage,
              occurredAt: clock(),
              launchSubcode: launchSubcodeForSpawnCode(orchestrated.spawnCode),
            }),
          );
          if (terminal || attemptsExhausted) {
            terminalFail(context.handle, {
              jobId: request.jobId,
              requestId: request.id,
              rowVersion: start.fenceVersion,
              to: "FAILED",
              reasonCode: code,
              errorDetail: detail,
              now: clock(),
            });
          }
          return {
            result: "FAILED",
            errorCode: code,
            errorDetail: detail,
            ...(terminal ? { terminal: true as const } : {}),
            ...hashes,
          };
        }
        const reason = orchestrated.reason;
        if (attemptsExhausted) {
          terminalFail(context.handle, {
            jobId: request.jobId,
            requestId: request.id,
            rowVersion: start.fenceVersion,
            to: "FAILED",
            reasonCode: reason as ReasonCode,
            errorDetail: orchestrated.detail,
            now: clock(),
          });
        }
        return { result: "FAILED", errorCode: reason, errorDetail: orchestrated.detail, ...hashes };
      }
      const value = orchestrated.value;

      if (!context.heartbeat()) {
        if (isV3) {
          return failedOutcomeV3("LEASE_LOST", emitter?.lastStage ?? null, clock(), {
            inputHash: value.inputHash,
            outputHash: value.contentHash,
          });
        }
        return {
          result: "FAILED",
          errorCode: "LEASE_EXPIRED",
          errorDetail: "lease lost before artifact publish",
          inputHash: value.inputHash,
          outputHash: value.contentHash,
        };
      }
      if (analysisId === null) {
        throw new Error("internal: analysis missing after successful orchestration");
      }
      // Reserve the next version before publishing: byte paths embed the
      // version, and the fenced attach re-verifies this reservation.
      const reserved = nextResumeVersion(context.handle, request.jobId);
      let published: ReturnType<typeof publishArtifacts>;
      try {
        published = publishArtifacts({
          artifactsDir: deps.artifactsDir,
          jobKey: request.jobId,
          versionNumber: reserved.versionNumber,
          contentHash: value.contentHash,
          markdown: value.markdown,
          docx: value.docx,
          pdf: value.pdf,
        });
      } catch (error: unknown) {
        if (isV3 && emitter !== null) {
          log.error("artifact publish failed", {
            workItemId: context.item.id,
            jobId: request.jobId,
            detail: (error as Error).message,
          });
          if (!context.heartbeat()) {
            return failedOutcomeV3("LEASE_LOST", emitter.lastStage, clock());
          }
          const detail = encodeFailureDetail(
            buildFailure("PUBLISH_FAILED", { stage: "PUBLISHING_RESULT", occurredAt: clock() }),
          );
          if (attemptsExhausted) {
            terminalFail(context.handle, {
              jobId: request.jobId,
              requestId: request.id,
              rowVersion: start.fenceVersion,
              to: "FAILED",
              reasonCode: "PUBLISH_FAILED",
              errorDetail: detail,
              now: clock(),
            });
          }
          return {
            result: "FAILED",
            errorCode: "PUBLISH_FAILED",
            errorDetail: detail,
            inputHash: value.inputHash,
            outputHash: value.contentHash,
          };
        }
        const detail = `artifact publish failed: ${(error as Error).message}`;
        if (attemptsExhausted) {
          terminalFail(context.handle, {
            jobId: request.jobId,
            requestId: request.id,
            rowVersion: start.fenceVersion,
            to: "FAILED",
            reasonCode: "STALE_INPUT",
            errorDetail: detail,
            now: clock(),
          });
        }
        return {
          result: "FAILED",
          errorCode: "STALE_INPUT",
          errorDetail: detail,
          inputHash: value.inputHash,
          outputHash: value.contentHash,
        };
      }

      if (emitter !== null) {
        emitter.emitStage("PUBLISHING_RESULT");
      }
      const attached = attachResumeVersion(context.handle, {
        start,
        extractionId: request.extractionId,
        analysisId,
        result: value,
        artifacts: published.records,
        expectedVersion: reserved,
        workAttemptId,
        now: clock(),
        ...(isV3
          ? {
              lease: {
                workItemId: context.item.id,
                attemptId: workAttemptId,
                leaseToken: context.item.leaseToken,
              },
              ...(step2 !== undefined
                ? {
                    capturedEvidence: {
                      profileId: request.profileId,
                      profileVersionId: request.profileVersionId,
                      profilePayloadHash: step2.profilePayloadHash,
                      evidenceHash: step2.evidenceHash,
                    },
                  }
                : {
                    profileId: request.profileId,
                    profileVersionId: request.profileVersionId,
                  }),
            }
          : {}),
      });
      if (!attached.ok) {
        if (attached.error === "lease-lost") {
          // The lease died under the run: no bookkeeping, no retry
          // from here — recovery owns the outcome.
          return failedOutcomeV3("LEASE_LOST", emitter?.lastStage ?? null, clock(), {
            inputHash: value.inputHash,
            outputHash: value.contentHash,
          });
        }
        if (attached.error === "assessment-blocked") {
          // Evidence-integrity violation at publication: the version
          // was NOT attached (zero writes). Fail terminally without
          // retry — retrying cannot repair forged evidence.
          log.error("tailor run attach assessment-blocked", {
            workItemId: context.item.id,
            detail: attached.detail,
          });
          if (isV3) {
            const detail = failRequestV3(context.handle, {
              requestId: request.id,
              code: "CLAIM_VALIDATION",
              stage: "PUBLISHING_RESULT",
              now: clock(),
            });
            return {
              result: "FAILED",
              errorCode: "CLAIM_VALIDATION",
              errorDetail: detail,
              inputHash: value.inputHash,
              outputHash: value.contentHash,
            };
          }
          failGenerationRequest(context.handle, {
            requestId: request.id,
            errorCode: "CLAIM_VALIDATION",
            errorDetail: attached.detail,
            now: clock(),
          });
          return {
            result: "FAILED",
            errorCode: "CLAIM_VALIDATION",
            errorDetail: attached.detail,
            inputHash: value.inputHash,
            outputHash: value.contentHash,
          };
        }
        if (isV3) {
          // The job moved under the run (human verdict, rejection)
          // or the profile deactivated: fail the request so it
          // cannot strand a live row, leave the job to its owner,
          // and never retry into the same fence.
          if (!context.heartbeat()) {
            return failedOutcomeV3("LEASE_LOST", emitter?.lastStage ?? null, clock());
          }
          const code: FailureCode =
            attached.fence === "profile" ? "PROFILE_UNAVAILABLE" : "INPUT_STALE";
          log.error("tailor run attach fenced", {
            workItemId: context.item.id,
            fence: attached.fence,
            detail: attached.detail,
          });
          const detail = failRequestV3(context.handle, {
            requestId: request.id,
            code,
            stage: "PUBLISHING_RESULT",
            now: clock(),
          });
          return {
            result: "BLOCKED",
            errorCode: code,
            errorDetail: detail,
            inputHash: value.inputHash,
            outputHash: value.contentHash,
          };
        }
        // The job moved under the run (human verdict, rejection): fail the
        // request so it cannot strand a live row, leave the job to its
        // owner, and never retry into the same fence.
        failGenerationRequest(context.handle, {
          requestId: request.id,
          errorCode: "STALE_INPUT",
          errorDetail: attached.detail,
          now: clock(),
        });
        return {
          result: "BLOCKED",
          errorCode: "STALE_INPUT",
          errorDetail: attached.detail,
          inputHash: value.inputHash,
          outputHash: value.contentHash,
        };
      }
      if (attached.reused && attached.versionNumber !== reserved.versionNumber) {
        // Idempotent rerun: ensure the existing version's files are
        // present (identical bytes are reused, never rewritten).
        try {
          publishArtifacts({
            artifactsDir: deps.artifactsDir,
            jobKey: request.jobId,
            versionNumber: attached.versionNumber,
            contentHash: value.contentHash,
            markdown: value.markdown,
            docx: value.docx,
            pdf: value.pdf,
          });
        } catch (error: unknown) {
          log.error("artifact re-verify failed after dedupe attach", {
            workItemId: context.item.id,
            jobId: request.jobId,
            detail: (error as Error).message,
          });
        }
      }
      log.info("tailor run attached", {
        workItemId: context.item.id,
        workAttemptId,
        jobId: request.jobId,
        requestId: request.id,
        resumeVersionId: attached.resumeVersionId,
        versionNumber: attached.versionNumber,
        reused: attached.reused,
        analysisId,
      });
      return {
        result: "SUCCEEDED",
        inputHash: value.inputHash,
        outputHash: value.contentHash,
      };
    } catch (error: unknown) {
      if (error instanceof LeaseLostError) {
        return failedOutcomeV3("LEASE_LOST", emitter?.lastStage ?? null, clock());
      }
      throw error;
    }
  };
}
