import { z } from "zod";
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
export const RESUME_PROPOSAL_SCHEMA_VERSION = "resume-proposal/v1";
export const RESUME_CONTENT_SCHEMA_VERSION = "resume-content/v1";
export const PROVIDER_ATTEMPT_SCHEMA_VERSION = "provider-attempt/v1";
export const AUDIT_SUMMARY_SCHEMA_VERSION = "audit-summary/v1";
export const TAILOR_PROMPT_VERSION = "tailor-prompt/v1";
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
  })
  .strict();
export type TailoringInputV1 = z.infer<typeof TailoringInputV1>;

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
    promptVersion: z.literal(TAILOR_PROMPT_VERSION),
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
    promptVersion: z.literal(TAILOR_PROMPT_VERSION),
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

/** Reason-coded provider failure. Never carries provider output bytes. */
export type ProviderFailureReason = "PROVIDER_UNAVAILABLE" | "TIMEOUT";

export class ProviderError extends Error {
  readonly reason: ProviderFailureReason;
  readonly detail: string;
  constructor(reason: ProviderFailureReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ProviderError";
    this.reason = reason;
    this.detail = detail.slice(0, 2000);
  }
}

/**
 * Provider-neutral agent interface (architecture section 7). Domain code
 * depends only on this interface; vendor specifics live in adapters.
 */
export interface TailoringProvider {
  readonly providerId: string;
  prepare(input: TailoringInputV1): Promise<{ proposal: ResumeProposalV1; attempt: ProviderAttemptV1 }>;
}
