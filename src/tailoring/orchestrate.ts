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
import {
  RESUME_CONTENT_SCHEMA_VERSION,
  TAILOR_PROMPT_VERSION,
  TAILORING_INPUT_SCHEMA_VERSION,
  ProviderError,
  TailoringInputV1,
  type AuditSummaryV1,
  type ProviderAttemptV1,
  type ResumeContentV1,
  type ResumeProposalV1,
  type TailoringProvider,
} from "./contract";
import { buildTailoredDraft, type StructuredDraft } from "./draft";
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
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "STALE_INPUT"
  | "RENDER_FAILED";

export interface GapEntry {
  requirement_id: string;
  jd_quote: string;
  match_status: string;
  importance: string;
  category: string;
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
  draft: StructuredDraft;
  content: ResumeContentV1;
  plainText: string;
  markdown: Buffer;
  docx: Buffer;
  html: string;
  pdf: Buffer;
  contentHash: string;
}

export type OrchestrationResult =
  | { ok: true; value: OrchestrationSuccess }
  | {
      ok: false;
      reason: OrchestrationFailureReason;
      detail: string;
      proposal: AcceptedProposal | null;
    };

export interface OrchestrationInputs {
  jobId: string;
  jobTitle: string | null;
  jobCompany: string | null;
  jobDescription: string;
  profile: CandidateProfileInput;
  jdSnapshot: { id: string; jdText: string; createdAt: string };
  candidateSnapshot: { id: string; snapshotHash: string; createdAt: string };
}

export interface OrchestrationDeps {
  provider: TailoringProvider;
  renderPdf: (html: string) => Promise<{ bytes: Buffer }>;
  docxTemplateBytes: Buffer;
}

function fail(
  reason: OrchestrationFailureReason,
  detail: string,
  proposal: AcceptedProposal | null = null,
): OrchestrationResult {
  return { ok: false, reason, detail: detail.slice(0, 2000), proposal };
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
  let envelope: TailoringInputV1;
  try {
    const approvedFactIds = inputs.profile.verified_facts
      .filter((fact) => fact.verification_status === "approved")
      .map((fact) => fact.fact_id);
    envelope = TailoringInputV1.parse({
      schemaVersion: TAILORING_INPUT_SCHEMA_VERSION,
      jobId: inputs.jobId,
      jobTitle: inputs.jobTitle ?? "",
      company: inputs.jobCompany ?? "",
      jdSnapshotId: inputs.jdSnapshot.id,
      jdText: canonicalText(inputs.jobDescription),
      candidateSnapshotId: inputs.candidateSnapshot.id,
      profile: inputs.profile,
      approvedFactIds,
      promptVersion: TAILOR_PROMPT_VERSION,
    });
  } catch (error: unknown) {
    return fail(
      "STALE_INPUT",
      `cannot build tailoring input envelope: ${(error as Error).message}`,
    );
  }
  if (envelope.jdText === "") {
    return fail("STALE_INPUT", "job description is empty after canonicalization");
  }

  let proposal: ResumeProposalV1;
  let attempt: ProviderAttemptV1;
  try {
    const prepared = await deps.provider.prepare(envelope);
    proposal = prepared.proposal;
    attempt = prepared.attempt;
  } catch (error: unknown) {
    if (error instanceof ProviderError) {
      return fail(error.reason, error.detail);
    }
    return fail("PROVIDER_UNAVAILABLE", `provider failed: ${(error as Error).message}`);
  }

  if (
    proposal.jdSnapshotId !== inputs.jdSnapshot.id ||
    proposal.candidateSnapshotId !== inputs.candidateSnapshot.id
  ) {
    return fail(
      "PROVIDER_UNAVAILABLE",
      "provider proposal binds different snapshots than the requested inputs",
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
      "PROVIDER_UNAVAILABLE",
      `provider requirements failed validation: ${submission.errors.join("; ")}`,
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
      return fail("STALE_INPUT", `stale-input gate rejected bound snapshots: ${gate.message}`);
    }
    canonical = gate.requirements;
  } catch (error: unknown) {
    return fail("STALE_INPUT", `stale-input gate failed: ${(error as Error).message}`);
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
  const accepted: AcceptedProposal = {
    requirements: canonical,
    gaps,
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
    return fail("STALE_INPUT", (error as Error).message, accepted);
  }

  let draft: StructuredDraft;
  let rankedFactIds: string[];
  let citedFactIds: string[];
  let summaryStrategy: string;
  try {
    const built = buildTailoredDraft({
      profile: inputs.profile,
      requirements: canonical,
      jobId: inputs.jobId,
      jobTitle: inputs.jobTitle,
      jobCompany: inputs.jobCompany,
      asOf,
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
    );
  }

  const draftReport = validateDraft({ profile: inputs.profile, draft });
  if (!draftReport.valid) {
    return fail(
      "STALE_INPUT",
      `deterministic draft failed validation: ${draftReport.report.errors.join("; ")}`,
      accepted,
    );
  }

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
    return fail("RENDER_FAILED", `DOCX render failed: ${(error as Error).message}`, accepted);
  }
  const html = renderHtml(model);
  let pdf: Buffer;
  try {
    pdf = (await deps.renderPdf(html)).bytes;
  } catch (error: unknown) {
    return fail("RENDER_FAILED", `PDF render failed: ${(error as Error).message}`, accepted);
  }

  try {
    const { pageCount, text } = await extractPdfText(pdf);
    assertPageBudget(pageCount);
    assertMinExtractableText(text);
    const fragments = htmlBodyFragments(html);
    assertProjectionContains(fragments, text, "PDF");
    assertProjectionContains(fragments, stripMarkdownEmphasis(markdownText), "Markdown");
    assertProjectionContains(fragments, extractDocxParagraphs(docx).join("\n"), "DOCX");
  } catch (error: unknown) {
    return fail("RENDER_FAILED", (error as Error).message, accepted);
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
    promptVersion: TAILOR_PROMPT_VERSION,
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
      draft,
      content,
      plainText,
      markdown: Buffer.from(markdownText, "utf8"),
      docx,
      html,
      pdf,
      contentHash,
    },
  };
}
