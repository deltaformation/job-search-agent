import { RESUME_CONFIG } from "../resumes/config";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { rankFacts } from "./ranking";
import { type CandidateProfileInput } from "./schemas";
import { composeSummary } from "./summary";

/**
 * Deterministic tailored-draft builder (port of the
 * `generate_tailored_draft` server path plus the pipeline's constrained
 * summary replacement).
 *
 * Fact ordering comes from the coverage-first ranker; experience claims
 * group by profile employment order with facts in rank order within
 * each role; the summary is the constrained composition (never the
 * heuristic verbatim pick); education claims are verbatim. Every claim
 * the builder emits must pass `validateDraft` downstream.
 */

export interface StructuredDraft {
  job_id: string;
  target_role: string | null;
  target_company: string | null;
  claims: Array<Record<string, unknown>>;
}

export interface TailoredDraft {
  draft: StructuredDraft;
  rankedFactIds: string[];
  summaryStrategy: string;
  summaryFallbackReason: string | null;
}

function employmentEnd(exp: {
  end_date?: string | null;
  is_current?: boolean;
}): string {
  if (pyTruthy(exp.end_date)) {
    return pyString(exp.end_date);
  }
  return exp.is_current === true ? "Present" : "";
}

export function buildTailoredDraft(input: {
  profile: CandidateProfileInput;
  requirements: unknown;
  jobId: string;
  jobTitle: string | null;
  jobCompany: string | null;
  asOf: string;
}): TailoredDraft {
  const { profile } = input;
  const ranked = rankFacts({
    profile,
    requirements: input.requirements,
    config: {
      maxPerRole: RESUME_CONFIG.maxExperienceBullets,
      maxPriorRole: RESUME_CONFIG.maxPriorRoleBullets,
      maxTotal: RESUME_CONFIG.maxTotalBullets,
    },
  }).factIds;

  const summary = composeSummary({
    profile,
    rankedFactIds: ranked,
    jobTitle: input.jobTitle ?? "",
    asOf: input.asOf,
  });

  const approved = new Map<string, CandidateProfileInput["verified_facts"][number]>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      approved.set(fact.fact_id, fact);
    }
  }

  const claims: Array<Record<string, unknown>> = [];
  if (summary.strategy !== "none") {
    const summaryClaim: Record<string, unknown> = {
      section: "summary",
      text: summary.text,
      fact_ids: [...summary.fact_ids],
      generation_strategy:
        summary.strategy === "derived_template" ? "derived_template" : "verbatim",
    };
    if (summary.derivation !== null) {
      summaryClaim["derivation"] = summary.derivation;
    }
    claims.push(summaryClaim);
  }

  for (const exp of profile.work_experience) {
    const expId = pyString(exp.id ?? null);
    for (const fid of ranked) {
      const fact = approved.get(fid) ?? null;
      if (fact === null) {
        throw new Error(`internal: ranked fact_id '${fid}' is not an approved profile fact`);
      }
      if (pyString(fact.work_experience_id ?? null) !== expId) {
        continue;
      }
      claims.push({
        section: "experience",
        entity_id: expId,
        company: exp.company,
        role: exp.role,
        dates: { start: pyString(exp.start_date), end: employmentEnd(exp) },
        text: fact.text,
        fact_ids: [fact.fact_id],
        claimed_technologies: [...fact.technologies],
        claimed_metrics: [...fact.metrics],
        generation_strategy: "verbatim",
      });
    }
  }

  for (const edu of profile.education) {
    claims.push({
      section: "education",
      degree: edu.degree,
      institution: edu.institution,
      field_of_study: edu.field_of_study,
      text: `${edu.degree} in ${edu.field_of_study}, ${edu.institution}`,
      fact_ids: [],
      claimed_technologies: [],
      claimed_metrics: [],
      generation_strategy: "verbatim",
    });
  }

  claims.forEach((claim, index) => {
    if (!isRecord(claim)) {
      throw new Error("internal: draft claim must be an object");
    }
    claim["claim_id"] = `claim_${String(index + 1).padStart(3, "0")}`;
  });

  return {
    draft: {
      job_id: input.jobId,
      target_role: input.jobTitle,
      target_company: input.jobCompany,
      claims,
    },
    rankedFactIds: ranked,
    summaryStrategy: summary.strategy,
    summaryFallbackReason: summary.fallback_reason,
  };
}
