import { z } from "zod";
import type {
  PreparationInputV2 as PreparationInput,
  PreparationProposalV2 as PreparationProposal,
} from "../domain/step2Correction";
import { FocusV1, RecommendationV1 } from "../domain/tailoringWorkspace";
import { CandidateProfileInput } from "./schemas";

/**
 * Provider-neutral tailoring contract (architecture section 7).
 *
 * The agent is a proposal generator, never the authority for facts,
 * approval, or stored paths. `TailoringInputV1` is constructed
 * server-side from immutable snapshots and hashed; `ResumeProposalV1`
 * is the only shape a provider may return. Both schemas are strict:
 * unknown keys — including any approval, path, hash, template, or
 * coverage field the provider invents — fail validation instead of
 * being silently accepted.
 */

export const TAILORING_INPUT_SCHEMA_VERSION = "tailoring-input/v1";
export const TAILORING_INPUT_SCHEMA_VERSION_V2 = "tailoring-input/v2";
export const RESUME_PROPOSAL_SCHEMA_VERSION = "resume-proposal/v1";
export const RESUME_CONTENT_SCHEMA_VERSION = "resume-content/v1";
export const PROVIDER_ATTEMPT_SCHEMA_VERSION = "provider-attempt/v1";
export const AUDIT_SUMMARY_SCHEMA_VERSION = "audit-summary/v1";
export const TAILOR_PROMPT_VERSION = "tailor-prompt/v1";
export const TAILOR_PROMPT_VERSION_V2 = "tailor-prompt/v2";
export const TAILORING_POLICY_VERSION = "tailoring-policy/v1";
export const ANALYSIS_REQUIREMENTS_SCHEMA_VERSION = "analysis-requirements/v1";
export const ANALYSIS_GAPS_SCHEMA_VERSION = "analysis-gaps/v1";

export const TailoringInputV1 = z
  .object({
    schemaVersion: z.literal(TAILORING_INPUT_SCHEMA_VERSION),
    jobId: z.string().min(1),
    jobTitle: z.string(),
    company: z.string(),
    jdSnapshotId: z.string().min(1),
    jdText: z.string().min(1).max(500_000),
    candidateSnapshotId: z.string().min(1),
    profile: CandidateProfileInput,
    approvedFactIds: z.array(z.string().min(1)).max(500),
    promptVersion: z.literal(TAILOR_PROMPT_VERSION),
    // Human guidance (R-ADR-013): hashed into input_hash with the rest of
    // the envelope, so every run's steering is lineage-bound. The provider
    // must treat these as ranking/wording steers only — claims still
    // require approved fact evidence.
    profileId: z.string().trim().min(1).max(64).optional(),
    selectedKeywords: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    directives: z.string().trim().max(1000).optional(),
    // D4: the mandatory revision note on REVISION runs, bound into
    // input_hash exactly like other steering (rank/wording only).
    revisionNote: z.string().trim().max(2000).optional(),
  })
  .strict();
export type TailoringInputV1 = z.infer<typeof TailoringInputV1>;

/**
 * v1.3 provider input (contracts §3.2): every v1 steering field plus
 * the exact frozen focus and recommendation snapshots. Queued v2
 * work keeps the v1 reader; new v3 work uses this envelope. The
 * revision-note bound is explicit at 4000 characters — callers must
 * not truncate v2 notes to the v1 2000-character bound.
 */
export const TailoringInputV2 = TailoringInputV1.omit({
  schemaVersion: true,
  promptVersion: true,
  revisionNote: true,
})
  .extend({
    schemaVersion: z.literal(TAILORING_INPUT_SCHEMA_VERSION_V2),
    promptVersion: z.literal(TAILOR_PROMPT_VERSION_V2),
    revisionNote: z.string().trim().min(1).max(4000).optional(),
    focus: FocusV1,
    recommendations: RecommendationV1,
  })
  .strict();
export type TailoringInputV2 = z.infer<typeof TailoringInputV2>;

/** Union reader for the v1/v2 provider-input migration window. */
export const TailoringInputAnyVersion = z.discriminatedUnion("schemaVersion", [
  TailoringInputV1,
  TailoringInputV2,
]);
export type TailoringInputAnyVersion = z.infer<typeof TailoringInputAnyVersion>;

/**
 * Prompt versions accepted by attempt/audit readers. Historical v1
 * records keep their v1 label; v2 runs record v2.
 */
export const TailorPromptVersion = z.enum([TAILOR_PROMPT_VERSION, TAILOR_PROMPT_VERSION_V2]);
export type TailorPromptVersion = z.infer<typeof TailorPromptVersion>;

/** Requirement proposal shape (mirrors the canonical requirement model). */
export const ProposalRequirementV1 = z
  .object({
    requirement_id: z.string().trim().min(1).max(128),
    jd_quote: z.string().min(1).max(5000),
    description: z.unknown().optional(),
    category: z.enum([
      "experience",
      "skill",
      "responsibility",
      "domain",
      "location",
      "compensation",
      "screening",
      "other",
    ]),
    importance: z.enum(["required", "preferred", "unspecified"]),
    match_status: z.enum(["matched", "partial", "gap", "unsupported"]),
    evidence_fact_ids: z.array(z.string().min(1)).max(100),
    evidence_quotes: z.array(z.string().min(1)).max(100),
    review_status: z.enum(["proposed", "confirmed"]),
    analysis_notes: z.unknown().optional(),
  })
  .strict();
export type ProposalRequirementV1 = z.infer<typeof ProposalRequirementV1>;

export const ResumeProposalV1 = z
  .object({
    schemaVersion: z.literal(RESUME_PROPOSAL_SCHEMA_VERSION),
    jdSnapshotId: z.string().min(1),
    candidateSnapshotId: z.string().min(1),
    requirements: z.array(ProposalRequirementV1).min(1).max(200),
    rationale: z.string().min(1).max(2000),
    questions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict();
export type ResumeProposalV1 = z.infer<typeof ResumeProposalV1>;

/** Attempt record persisted per provider call (executable/config/exit detail). */
export const ProviderAttemptV1 = z
  .object({
    schemaVersion: z.literal(PROVIDER_ATTEMPT_SCHEMA_VERSION),
    providerId: z.string().min(1).max(128),
    model: z.string().max(256).nullable(),
    executable: z.string().max(1024).nullable(),
    argvHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    configVersion: z.string().min(1).max(64),
    promptVersion: TailorPromptVersion,
    proposalSchemaVersion: z.literal(RESUME_PROPOSAL_SCHEMA_VERSION),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    outputBytes: z.number().int().min(0),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    proposalHash: z.string().regex(/^[0-9a-f]{64}$/),
    questions: z.array(z.string().max(500)).max(20),
  })
  .strict();
export type ProviderAttemptV1 = z.infer<typeof ProviderAttemptV1>;

/** Structured audit summary embedded in each resume version's content. */
export const AuditSummaryV1 = z
  .object({
    schemaVersion: z.literal(AUDIT_SUMMARY_SCHEMA_VERSION),
    requirementsTotal: z.number().int().min(0),
    supportedCount: z.number().int().min(0),
    gapCount: z.number().int().min(0),
    validatedClaims: z.number().int().min(0),
    totalClaims: z.number().int().min(0),
    factsReferenced: z.array(z.string().min(1)),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    proposalHash: z.string().regex(/^[0-9a-f]{64}$/),
    providerId: z.string().min(1),
    model: z.string().nullable(),
    promptVersion: TailorPromptVersion,
    rationale: z.string().max(2000),
    questions: z.array(z.string().max(500)).max(20),
  })
  .strict();
export type AuditSummaryV1 = z.infer<typeof AuditSummaryV1>;

export const ResumeContentV1 = z
  .object({
    schemaVersion: z.literal(RESUME_CONTENT_SCHEMA_VERSION),
    draft: z
      .object({
        job_id: z.string().min(1),
        target_role: z.string().nullable(),
        target_company: z.string().nullable(),
        claims: z.array(z.record(z.string(), z.unknown())),
      })
      .strict(),
    rankedFactIds: z.array(z.string().min(1)),
    keywordCoverage: z.record(z.string(), z.unknown()),
    omittedUnsupported: z.array(z.string()),
    summaryStrategy: z.string().min(1),
    changeSummary: z
      .object({
        addedBullets: z.array(z.string()),
        removedBullets: z.array(z.string()),
        summaryChanged: z.boolean(),
        baselineLines: z.number().int().min(0),
        tailoredLines: z.number().int().min(0),
      })
      .strict(),
    audit: AuditSummaryV1,
  })
  .strict();
export type ResumeContentV1 = z.infer<typeof ResumeContentV1>;

/**
 * Reason-coded provider failure. Never carries provider output bytes.
 * Reasons mirror the sidecar exit contract so the worker maps failures
 * from actual codes, never prose. PROVIDER_UNAVAILABLE is the generic
 * bucket for unclassified provider faults and our own envelope bugs.
 */
export type ProviderFailureReason =
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "LOCAL_LAUNCH";

export class ProviderError extends Error {
  readonly reason: ProviderFailureReason;
  readonly detail: string;
  /**
   * Raw spawn errno (LOCAL_LAUNCH only, e.g. ENOENT/EACCES). Captured
   * from the actual spawn error so diagnostics can show a verified
   * subcode; null for every other reason.
   */
  readonly spawnCode: string | null;
  constructor(reason: ProviderFailureReason, detail: string, spawnCode: string | null = null) {
    super(`${reason}: ${detail}`);
    this.name = "ProviderError";
    this.reason = reason;
    this.detail = detail.slice(0, 2000);
    this.spawnCode = spawnCode;
  }
}

/**
 * Provider-neutral agent interface (architecture section 7). Domain code
 * depends only on this interface; vendor specifics live in adapters.
 */
export interface TailoringProvider {
  readonly providerId: string;
  prepare(
    input: TailoringInputV1 | TailoringInputV2,
  ): Promise<{ proposal: ResumeProposalV1; attempt: ProviderAttemptV1 }>;
}

/**
 * Step 2 preparation planning envelopes v1 (WO-1.3-S2-B, S2-A §9).
 * Single source of truth is `../domain/step2`; this module
 * re-exports so historical readers and tests share the exact
 * contract text.
 */
export {
  PREPARE_PROMPT_VERSION,
  PreparationInputV1,
  PreparationProposalV1,
  type PreparationInputV1 as PreparationInputV1Type,
  type PreparationProposalV1 as PreparationProposalV1Type,
} from "../domain/step2";

/**
 * Step 2 preparation planning envelopes v2 (WO-1.3-S2-CP-B,
 * correction contracts §9). Provider code consumes these; the
 * provider interface speaks v2 only.
 */
export {
  PREPARE_PROMPT_VERSION_V2,
  PreparationInputV2,
  PreparationProposalV2,
  type PreparationInputV2 as PreparationInputV2Type,
  type PreparationProposalV2 as PreparationProposalV2Type,
} from "../domain/step2Correction";

/** Attempt lineage the prepare adapter returns (stored as plan columns). */
export interface PreparationAttemptLineage {
  providerId: string;
  model: string | null;
  startedAt: string;
  finishedAt: string;
  outputBytes: number;
  inputHash: string;
  proposalHash: string;
}

/**
 * Provider-neutral preparation interface (S2-A §9): same
 * JSON-over-stdio discipline as TailoringProvider, planned-prompt
 * envelope in, validated proposal out. Never renders resumes.
 */
export interface PrepareProvider {
  readonly providerId: string;
  preparePlan(input: PreparationInput): Promise<{
    proposal: PreparationProposal;
    lineage: PreparationAttemptLineage;
  }>;
}
