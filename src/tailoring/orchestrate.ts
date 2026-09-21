import { canonicalText } from "../domain/canonical";
import {
  assertMinExtractableText,
  assertPageBudget,
  assertProjectionContains,
  htmlBodyFragments,
  stripMarkdownEmphasis,
} from "../resumes/checks";
import { RESUME_CONFIG } from "../resumes/config";
import { extractDocxParagraphs, renderDocx } from "../resumes/docx";
import { renderMarkdown } from "../resumes/markdown";
import { extractPdfText } from "../resumes/pdf";
import { renderHtml } from "../resumes/template";
import {
  buildCanonicalBaselineDraft,
  buildViewModel,
  renderPlainText,
} from "../resumes/viewModel";
import { summarizeChanges } from "./audit";
import type {
  FocusV1,
  RecommendationV1,
  TailoringStage,
} from "../domain/tailoringWorkspace";
import {
  RESUME_CONTENT_SCHEMA_VERSION,
  TAILOR_PROMPT_VERSION,
  TAILOR_PROMPT_VERSION_V2,
  TAILORING_INPUT_SCHEMA_VERSION,
  TAILORING_INPUT_SCHEMA_VERSION_V2,
  ProviderError,
  TailoringInputV1,
  TailoringInputV2,
  type AuditSummaryV1,
  type ProviderAttemptV1,
  type ProviderFailureReason,
  type ResumeContentV1,
  type ResumeProposalV1,
  type TailoringInputV1 as TailoringInputV1Type,
  type TailoringInputV2 as TailoringInputV2Type,
  type TailoringProvider,
} from "./contract";
import { buildTailoredDraft, type EditedPlanInput, type StructuredDraft } from "./draft";
import { evaluateDirectiveOutcomes, type DirectiveOutcome } from "./directives";
import {
  evaluateFocusOutcomes,
  summaryGapDrafts,
  type FocusSteeringOutcome,
} from "./focusSteering";
import { sha256HexUtf8 } from "./hash";
import {
  evidenceQualifiedSkills,
  planKeywords,
  planSkillRows,
  selectTopKeywords,
} from "./keywords";
import type { CandidateProfileInput } from "./schemas";
import { checkGenerationInputs, type CanonicalRequirement } from "./staleness";
import { validateDraft, validateSubmission } from "./validator";

/**
 * Deterministic tailoring orchestration (port of the `generate_documents`
 * success path, with the provider call in place of the legacy MCP draft
 * submission).
 *
 * Flow: build the immutable input envelope → provider proposal → strict
 * binding + rule validation → stale-input gate (canonicalization) →
 * rank/keyword-plan/compose → deterministic draft → draft validation →
 * one view model → Markdown/DOCX/HTML/PDF → page, text, and containment
 * checks → content hash, baseline diff, and audit summary.
 *
 * The provider proposal is the only non-deterministic input; everything
 * after it is a pure function of the bound snapshots. Failures are
 * reason-coded: provider faults stay provider faults, content/render
 * faults are `RENDER_FAILED`, and unreachable internal states report
 * `STALE_INPUT` loudly rather than inventing output.
 */

export type OrchestrationFailureReason =
  | ProviderFailureReason
  | "STALE_INPUT"
  | "RENDER_FAILED";

export interface GapEntry {
  requirement_id: string;
  jd_quote: string;
  match_status: string;
  importance: string;
  category: string;
  /**
   * D6: set on `category: "directive"` gaps to name the unbacked KPI
   * tokens. Additive under analysis-gaps/v1; readers ignore it when
   * absent.
   */
  explanation?: string;
}

export interface AcceptedProposal {
  requirements: CanonicalRequirement[];
  gaps: GapEntry[];
  attempt: ProviderAttemptV1;
  inputHash: string;
  proposalHash: string;
  rationale: string;
  model: string | null;
}

export interface OrchestrationSuccess extends AcceptedProposal {
  /** D6 per-directive verdicts; unsupported lines also appear in `gaps`. */
  directiveOutcomes: DirectiveOutcome[];
  /**
   * v1.3 focus-steering verdicts (E3). Empty on v1 runs; unsupported
   * summary sentences also appear in `gaps` as `summary-{index}`.
   */
  focusOutcomes: FocusSteeringOutcome[];
  draft: StructuredDraft;
  content: ResumeContentV1;
  plainText: string;
  markdown: Buffer;
  docx: Buffer;
  html: string;
  pdf: Buffer;
  contentHash: string;
  /**
   * G render evidence for the atomic assessment: page budget,
   * content/contact presence, and the cross-format parity outcome.
   * Present on every success (the parity/page asserts above throw
   * otherwise, so success implies the gates ran).
   */
  renderEvidence: {
    pageCount: number;
    pageBudget: number;
    fragmentsChecked: number;
    contentPresent: boolean;
    contactPresent: boolean;
    parityPassed: boolean;
  };
}

export type OrchestrationResult =
  | { ok: true; value: OrchestrationSuccess }
  | {
      ok: false;
      /** Structured reason; maps to a Failure code without prose matching. */
      reason: OrchestrationFailureReason;
      detail: string;
      proposal: AcceptedProposal | null;
      /** Stage during which the failure occurred (null when unknown). */
      stage: TailoringStage | null;
      /** Raw spawn errno for LOCAL_LAUNCH; null otherwise. */
      spawnCode: string | null;
    };

export interface OrchestrationInputs {
  jobId: string;
  jobTitle: string | null;
  jobCompany: string | null;
  jobDescription: string;
  profile: CandidateProfileInput;
  jdSnapshot: { id: string; jdText: string; createdAt: string };
  candidateSnapshot: { id: string; snapshotHash: string; createdAt: string };
  /** Human guidance; bound into the hashed envelope when present. */
  profileId?: string;
  selectedKeywords?: string[];
  directives?: string;
  revisionNote?: string;
  /**
   * v1.3 frozen focus pair. Both must be present to select the v2
   * provider envelope; a lone focus or recommendation fails closed.
   */
  focus?: FocusV1;
  recommendations?: RecommendationV1;
  /**
   * S2-D frozen edited plan (summary plus final bullets). Selects
   * the v1 provider envelope for requirement analysis and renders
   * the draft from the edited content instead of ranker output.
   * Mutually exclusive with the focus pair.
   */
  editedPlan?: EditedPlanInput;
}

/**
 * Stage-boundary hooks (WO-1.3-F). The handler owns seq 1
 * (PREPARING_INPUTS, after valid immutable inputs load) and seq 5
 * (PUBLISHING_RESULT, after staged artifact validation); orchestration
 * emits 2/3/4 at the real boundaries below. Absent = no emission.
 */
export interface OrchestrationProgressHooks {
  emit(stage: "WAITING_FOR_PROVIDER" | "VALIDATING_PROPOSAL" | "RENDERING_ARTIFACTS"): void;
}

export interface OrchestrationDeps {
  provider: TailoringProvider;
  renderPdf: (html: string) => Promise<{ bytes: Buffer }>;
  docxTemplateBytes: Buffer;
  /**
   * Crash-recovery path: reuse a validated saved proposal (and its
   * original attempt lineage) instead of calling the provider. The
   * handler reconstructs both from the persisted analysis row.
   */
  cached?: { proposal: ResumeProposalV1; attempt: ProviderAttemptV1 };
  progress?: OrchestrationProgressHooks;
}

function fail(
  reason: OrchestrationFailureReason,
  detail: string,
  proposal: AcceptedProposal | null = null,
  stage: TailoringStage | null = null,
  spawnCode: string | null = null,
): OrchestrationResult {
  return { ok: false, reason, detail: detail.slice(0, 2000), proposal, stage, spawnCode };
}

function asOfDate(jdCreatedAt: string, candidateCreatedAt: string): string {
  // Tenure is computed as of the later bound snapshot, so identical
  // snapshots always produce identical summaries across reruns.
  const later = jdCreatedAt >= candidateCreatedAt ? jdCreatedAt : candidateCreatedAt;
  const date = later.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`snapshot created_at is not an ISO date: ${JSON.stringify(later)}`);
  }
  return date;
}

export async function orchestrateTailoring(
  inputs: OrchestrationInputs,
  deps: OrchestrationDeps,
): Promise<OrchestrationResult> {
  let envelope: TailoringInputV1Type | TailoringInputV2Type;
  try {
    const approvedFactIds = inputs.profile.verified_facts
      .filter((fact) => fact.verification_status === "approved")
      .map((fact) => fact.fact_id);
    const base = {
      jobId: inputs.jobId,
      jobTitle: inputs.jobTitle ?? "",
      company: inputs.jobCompany ?? "",
      jdSnapshotId: inputs.jdSnapshot.id,
      jdText: canonicalText(inputs.jobDescription),
      candidateSnapshotId: inputs.candidateSnapshot.id,
      profile: inputs.profile,
      approvedFactIds,
      ...(inputs.profileId === undefined ? {} : { profileId: inputs.profileId }),
      ...(inputs.selectedKeywords === undefined ? {} : { selectedKeywords: inputs.selectedKeywords }),
      ...(inputs.directives === undefined ? {} : { directives: inputs.directives }),
      ...(inputs.revisionNote === undefined ? {} : { revisionNote: inputs.revisionNote }),
    };
    if (inputs.editedPlan !== undefined && (inputs.focus !== undefined || inputs.recommendations !== undefined)) {
      return fail(
        "STALE_INPUT",
        "an edited plan cannot combine with frozen focus steering",
        null,
        "PREPARING_INPUTS",
      );
    }
    if (inputs.focus === undefined && inputs.recommendations === undefined) {
      envelope = TailoringInputV1.parse({
        ...base,
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION,
        promptVersion: TAILOR_PROMPT_VERSION,
      });
    } else if (inputs.focus !== undefined && inputs.recommendations !== undefined) {
      envelope = TailoringInputV2.parse({
        ...base,
        schemaVersion: TAILORING_INPUT_SCHEMA_VERSION_V2,
        promptVersion: TAILOR_PROMPT_VERSION_V2,
        focus: inputs.focus,
        recommendations: inputs.recommendations,
      });
    } else {
      return fail(
        "STALE_INPUT",
        "frozen focus requires both the focus draft and its recommendation snapshot",
        null,
        "PREPARING_INPUTS",
      );
    }
  } catch (error: unknown) {
    return fail(
      "STALE_INPUT",
      `cannot build tailoring input envelope: ${(error as Error).message}`,
      null,
      "PREPARING_INPUTS",
    );
  }
  if (envelope.jdText === "") {
    return fail(
      "STALE_INPUT",
      "job description is empty after canonicalization",
      null,
      "PREPARING_INPUTS",
    );
  }

  deps.progress?.emit("WAITING_FOR_PROVIDER");
  let proposal: ResumeProposalV1;
  let attempt: ProviderAttemptV1;
  if (deps.cached !== undefined) {
    proposal = deps.cached.proposal;
    attempt = deps.cached.attempt;
  } else {
    try {
      const prepared = await deps.provider.prepare(envelope);
      proposal = prepared.proposal;
      attempt = prepared.attempt;
    } catch (error: unknown) {
      if (error instanceof ProviderError) {
        return fail(error.reason, error.detail, null, "WAITING_FOR_PROVIDER", error.spawnCode);
      }
      return fail(
        "PROVIDER_UNAVAILABLE",
        `provider failed: ${(error as Error).message}`,
        null,
        "WAITING_FOR_PROVIDER",
      );
    }
  }

  deps.progress?.emit("VALIDATING_PROPOSAL");
  if (
    proposal.jdSnapshotId !== inputs.jdSnapshot.id ||
    proposal.candidateSnapshotId !== inputs.candidateSnapshot.id
  ) {
    return fail(
      "INVALID_RESPONSE",
      "provider proposal binds different snapshots than the requested inputs",
      null,
      "VALIDATING_PROPOSAL",
    );
  }

  const submission = validateSubmission({
    profile: inputs.profile,
    analysisData: {
      jd_snapshot_id: proposal.jdSnapshotId,
      candidate_snapshot_id: proposal.candidateSnapshotId,
      requirements: proposal.requirements,
    },
    jdSnapshot: { id: inputs.jdSnapshot.id, cleaned_text: inputs.jdSnapshot.jdText },
    candidateSnapshot: { id: inputs.candidateSnapshot.id },
  });
  if (!submission.valid) {
    return fail(
      "INVALID_RESPONSE",
      `provider requirements failed validation: ${submission.errors.join("; ")}`,
      null,
      "VALIDATING_PROPOSAL",
    );
  }

  let canonical: CanonicalRequirement[];
  try {
    const gate = checkGenerationInputs({
      job: { description: inputs.jobDescription },
      profile: inputs.profile,
      analysis: {
        id: "pending-analysis",
        jd_snapshot_id: proposal.jdSnapshotId,
        candidate_snapshot_id: proposal.candidateSnapshotId,
        requirements: proposal.requirements,
      },
      jdSnapshotsByHash: {
        [sha256HexUtf8(canonicalText(inputs.jobDescription))]: {
          id: inputs.jdSnapshot.id,
          cleaned_text: inputs.jdSnapshot.jdText,
        },
      },
      candidateSnapshot: {
        candidate_id: "local",
        snapshot_hash: inputs.candidateSnapshot.snapshotHash,
        profile_data: inputs.profile,
      },
      currentProfileHash: inputs.candidateSnapshot.snapshotHash,
      candidateId: "local",
    });
    if (gate.status !== "ok") {
      return fail(
        "STALE_INPUT",
        `stale-input gate rejected bound snapshots: ${gate.message}`,
        null,
        "VALIDATING_PROPOSAL",
      );
    }
    canonical = gate.requirements;
  } catch (error: unknown) {
    return fail(
      "STALE_INPUT",
      `stale-input gate failed: ${(error as Error).message}`,
      null,
      "VALIDATING_PROPOSAL",
    );
  }

  // The proposal is accepted from here on: later failures still return it
  // so the handler persists the analysis and its attempt record.
  const gaps: GapEntry[] = canonical
    .filter((req) => req.match_status === "gap" || req.match_status === "unsupported")
    .map((req) => ({
      requirement_id: req.requirement_id,
      jd_quote: req.jd_quote,
      match_status: req.match_status,
      importance: req.importance,
      category: req.category,
    }));
  // D6: human directives are evaluated against approved facts only.
  // Unsupported lines join the persisted gaps with an explicit
  // explanation; the deterministic draft below is built from approved
  // facts alone, so unbacked KPI tokens can never reach the resume.
  const approvedFactTexts = (inputs.profile.verified_facts ?? [])
    .filter((fact) => fact.verification_status === "approved")
    .map((fact) => [fact.text, ...fact.metrics, ...fact.technologies].join("\n"));
  const directiveOutcomes: DirectiveOutcome[] = evaluateDirectiveOutcomes(
    inputs.directives,
    approvedFactTexts,
  );
  const directiveGaps: GapEntry[] = directiveOutcomes
    .filter((outcome) => outcome.status === "unsupported")
    .map((outcome) => ({
      requirement_id: `directive-${outcome.index}`,
      jd_quote: outcome.directive,
      match_status: "unsupported",
      importance: "required",
      category: "directive",
      explanation: outcome.explanation ?? undefined,
    }));
  const summaryGapEntries: GapEntry[] =
    inputs.focus === undefined || inputs.recommendations === undefined
      ? []
      : summaryGapDrafts({ profile: inputs.profile, summaryDirection: inputs.focus.summaryDirection }).map(
          (draft) => ({
            requirement_id: draft.requirementId,
            jd_quote: draft.sentence,
            match_status: "unsupported",
            importance: "required",
            category: "summary",
            explanation: draft.explanation,
          }),
        );
  const accepted: AcceptedProposal = {
    requirements: canonical,
    gaps: [...gaps, ...directiveGaps, ...summaryGapEntries],
    attempt,
    inputHash: attempt.inputHash,
    proposalHash: attempt.proposalHash,
    rationale: proposal.rationale,
    model: attempt.model,
  };

  let asOf: string;
  try {
    asOf = asOfDate(inputs.jdSnapshot.createdAt, inputs.candidateSnapshot.createdAt);
  } catch (error: unknown) {
    return fail("STALE_INPUT", (error as Error).message, accepted, "RENDERING_ARTIFACTS");
  }

  let draft: StructuredDraft;
  let rankedFactIds: string[];
  let citedFactIds: string[];
  let summaryStrategy: string;
  deps.progress?.emit("RENDERING_ARTIFACTS");
  try {
    const built = buildTailoredDraft({
      profile: inputs.profile,
      requirements: canonical,
      jobId: inputs.jobId,
      jobTitle: inputs.jobTitle,
      jobCompany: inputs.jobCompany,
      asOf,
      ...(inputs.focus === undefined || inputs.recommendations === undefined
        ? {}
        : { focusSteering: { focus: inputs.focus, recommendations: inputs.recommendations } }),
      ...(inputs.editedPlan === undefined ? {} : { editedPlan: inputs.editedPlan }),
    });
    draft = built.draft;
    rankedFactIds = built.rankedFactIds;
    citedFactIds = built.citedFactIds;
    summaryStrategy = built.summaryStrategy;
  } catch (error: unknown) {
    return fail(
      "STALE_INPUT",
      `deterministic draft assembly failed: ${(error as Error).message}`,
      accepted,
      "RENDERING_ARTIFACTS",
    );
  }

  const draftReport = validateDraft({
    profile: inputs.profile,
    draft,
    ...(inputs.editedPlan === undefined
      ? {}
      : {
          editedPlan: {
            texts: [
              { text: inputs.editedPlan.summary.text, factIds: inputs.editedPlan.summary.factIds },
              ...inputs.editedPlan.bullets
                .filter((bullet) => bullet.strategy === "edited_plan")
                .map((bullet) => ({ text: bullet.text, factIds: bullet.factIds })),
            ],
          },
        }),
  });
  if (!draftReport.valid) {
    return fail(
      "STALE_INPUT",
      `deterministic draft failed validation: ${draftReport.report.errors.join("; ")}`,
      accepted,
      "RENDERING_ARTIFACTS",
    );
  }

  const summaryClaim = draft.claims.find((claim) => claim["section"] === "summary");
  const renderedSummaryText =
    typeof summaryClaim?.["text"] === "string" ? (summaryClaim["text"] as string) : "";
  const summaryFactIds = Array.isArray(summaryClaim?.["fact_ids"])
    ? ((summaryClaim["fact_ids"] as unknown[]).filter(
        (factId): factId is string => typeof factId === "string",
      ))
    : [];
  const focusOutcomes: FocusSteeringOutcome[] =
    inputs.focus === undefined || inputs.recommendations === undefined
      ? []
      : evaluateFocusOutcomes({
          profile: inputs.profile,
          focus: inputs.focus,
          recommendations: inputs.recommendations,
          requirements: canonical.map((requirement) => ({
            requirementId: requirement.requirement_id,
            jdQuote: requirement.jd_quote,
            matchStatus: requirement.match_status,
            evidenceFactIds: [...requirement.evidence_fact_ids],
          })),
          gaps: gaps.map((gap) => ({
            requirementId: gap.requirement_id,
            jdQuote: gap.jd_quote,
            matchStatus: gap.match_status,
            category: gap.category,
          })),
          rankedFactIds,
          citedFactIds,
          renderedSummaryText,
          summaryFactIds,
          jdText: envelope.jdText,
        });

  const skillTerms = evidenceQualifiedSkills({ profile: inputs.profile, citedFactIds });
  const keywordPlan = planKeywords({
    profile: inputs.profile,
    requirements: canonical,
    rankedFactIds,
    skillTerms: skillTerms.skills,
  });

  const topKeywordQuotes = selectTopKeywords(canonical).map((entry) => entry.keyword);
  const model = buildViewModel({
    profile: inputs.profile,
    draft,
    maxDetailedRoles: RESUME_CONFIG.maxDetailedRoles,
    skillRows: planSkillRows({
      profile: inputs.profile,
      requirements: canonical,
      priorityQuotes: topKeywordQuotes,
    }),
  });
  const plainText = renderPlainText(model);
  const contentHash = sha256HexUtf8(plainText.trim());

  const baselineModel = buildViewModel({
    profile: inputs.profile,
    draft: buildCanonicalBaselineDraft(inputs.profile),
    maxDetailedRoles: RESUME_CONFIG.maxDetailedRoles,
  });
  const baselineText = renderPlainText(baselineModel);
  const changeSummary = summarizeChanges({
    baselineText,
    tailoredText: plainText,
    baselineSummary: baselineModel.summary_copy,
    tailoredSummary: model.summary_copy,
  });

  const markdownText = renderMarkdown(model);
  let docx: Buffer;
  try {
    docx = renderDocx(model, deps.docxTemplateBytes);
  } catch (error: unknown) {
    return fail(
      "RENDER_FAILED",
      `DOCX render failed: ${(error as Error).message}`,
      accepted,
      "RENDERING_ARTIFACTS",
    );
  }
  const html = renderHtml(model);
  let pdf: Buffer;
  try {
    pdf = (await deps.renderPdf(html)).bytes;
  } catch (error: unknown) {
    return fail(
      "RENDER_FAILED",
      `PDF render failed: ${(error as Error).message}`,
      accepted,
      "RENDERING_ARTIFACTS",
    );
  }

  let renderEvidence: OrchestrationSuccess["renderEvidence"];
  try {
    const { pageCount, text } = await extractPdfText(pdf);
    assertPageBudget(pageCount);
    assertMinExtractableText(text);
    const fragments = htmlBodyFragments(html);
    assertProjectionContains(fragments, text, "PDF");
    assertProjectionContains(fragments, stripMarkdownEmphasis(markdownText), "Markdown");
    assertProjectionContains(fragments, extractDocxParagraphs(docx).join("\n"), "DOCX");
    const bulletCount =
      model.professional_experience.reduce((total, job) => total + job.bullets.length, 0) +
      model.earlier_career.reduce((total, job) => total + job.bullets.length, 0);
    renderEvidence = {
      pageCount,
      pageBudget: RESUME_CONFIG.pageBudget,
      fragmentsChecked: fragments.length,
      contentPresent: model.summary_copy !== "" || bulletCount > 0,
      contactPresent: model.header.contact_parts.length > 0,
      parityPassed: true,
    };
  } catch (error: unknown) {
    return fail("RENDER_FAILED", (error as Error).message, accepted, "RENDERING_ARTIFACTS");
  }

  const supportedCount = canonical.length - gaps.length;
  const audit: AuditSummaryV1 = {
    schemaVersion: "audit-summary/v1",
    requirementsTotal: canonical.length,
    supportedCount,
    gapCount: gaps.length,
    validatedClaims: draftReport.report.validated_claims,
    totalClaims: draftReport.report.total_claims,
    factsReferenced: draftReport.report.verified_facts_referenced,
    contentHash,
    inputHash: attempt.inputHash,
    proposalHash: attempt.proposalHash,
    providerId: attempt.providerId,
    model: attempt.model,
    promptVersion: attempt.promptVersion,
    rationale: proposal.rationale,
    questions: proposal.questions,
  };
  const content: ResumeContentV1 = {
    schemaVersion: RESUME_CONTENT_SCHEMA_VERSION,
    draft: {
      job_id: draft.job_id,
      target_role: draft.target_role,
      target_company: draft.target_company,
      claims: draft.claims,
    },
    rankedFactIds,
    keywordCoverage: keywordPlan.coverage_report as unknown as Record<string, unknown>,
    omittedUnsupported: keywordPlan.omitted_unsupported,
    summaryStrategy,
    changeSummary,
    audit,
  };
  return {
    ok: true,
    value: {
      ...accepted,
      directiveOutcomes,
      focusOutcomes,
      draft,
      content,
      plainText,
      markdown: Buffer.from(markdownText, "utf8"),
      docx,
      html,
      pdf,
      contentHash,
      renderEvidence,
    },
  };
}
