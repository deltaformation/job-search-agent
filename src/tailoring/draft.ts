import { RESUME_CONFIG } from "../resumes/config";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { rankFacts } from "./ranking";
import { type CandidateProfileInput } from "./schemas";
import { composeSummary } from "./summary";
import { compareCodePoints } from "./text";

/**
 * Deterministic tailored-draft builder (port of the
 * `generate_tailored_draft` server path plus the pipeline's constrained
 * summary replacement, extended with baseline preservation).
 *
 * Fact ordering comes from the coverage-first ranker; experience claims
 * group by profile employment order with matched facts in rank order
 * first within each role, followed by the role's remaining approved
 * baseline facts up to the same per-role budget — tailoring prioritizes
 * and reorders, it never hollows roles out. A global total budget trims
 * backfilled bullets (never ranked ones) from the least-recent roles
 * first, and never below one bullet per fact-bearing role. The summary
 * is the constrained composition (never the heuristic verbatim pick);
 * education claims are verbatim. Every claim the builder emits must pass
 * `validateDraft` downstream.
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
  /** Every fact cited by the draft (ranked plus backfilled), in claim order. */
  citedFactIds: string[];
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

type ProfileFactRecord = CandidateProfileInput["verified_facts"][number];

interface RoleBudgets {
  maxPerRole: number;
  maxPriorRole: number;
  maxTotal: number;
}

/**
 * Per-role fact selection: ranked (JD-matched) facts first in rank order,
 * then the role's remaining approved baseline facts in profile order, up
 * to the same per-role budget the ranker used. The global total budget
 * trims backfilled bullets only — ranked facts are never trimmed (the
 * ranker already fit them) — from the least-recent roles first, and never
 * below one bullet per fact-bearing role, so no role vanishes.
 */
function selectRoleFacts(input: {
  profile: CandidateProfileInput;
  approved: Map<string, ProfileFactRecord>;
  ranked: string[];
  budgets: RoleBudgets;
}): Map<string, string[]> {
  const { profile, approved, ranked, budgets } = input;
  const rankedSet = new Set(ranked);
  const currentIds = new Set<string>();
  for (const exp of profile.work_experience) {
    if (pyTruthy(exp.is_current)) {
      currentIds.add(pyString(exp.id ?? null));
    }
  }
  const capFor = (expId: string): number =>
    currentIds.has(expId) ? budgets.maxPerRole : budgets.maxPriorRole;

  const byRole = new Map<string, string[]>();
  for (const exp of profile.work_experience) {
    byRole.set(pyString(exp.id ?? null), []);
  }
  for (const fid of ranked) {
    const expId = pyString(approved.get(fid)?.work_experience_id ?? null);
    // Ranked facts bound to unknown employment are skipped, matching the
    // legacy employment-outer claim loop.
    byRole.get(expId)?.push(fid);
  }
  for (const fact of profile.verified_facts) {
    if (fact.verification_status !== "approved" || rankedSet.has(fact.fact_id)) {
      continue;
    }
    const expId = pyString(fact.work_experience_id ?? null);
    const list = byRole.get(expId);
    if (list !== undefined && list.length < capFor(expId)) {
      list.push(fact.fact_id);
    }
  }

  const totalSelected = (): number => {
    let total = 0;
    for (const list of byRole.values()) {
      total += list.length;
    }
    return total;
  };
  let over = totalSelected() - budgets.maxTotal;
  if (over > 0) {
    const recencyRank = new Map<string, number>();
    const ordered = [...profile.work_experience].sort((left, right) => {
      const leftCurrent = pyTruthy(left.is_current) ? 1 : 0;
      const rightCurrent = pyTruthy(right.is_current) ? 1 : 0;
      if (leftCurrent !== rightCurrent) {
        return rightCurrent - leftCurrent;
      }
      const leftEnd = pyTruthy(left.end_date) ? pyString(left.end_date) : "";
      const rightEnd = pyTruthy(right.end_date) ? pyString(right.end_date) : "";
      if (leftEnd !== rightEnd) {
        return compareCodePoints(rightEnd, leftEnd);
      }
      return compareCodePoints(
        pyTruthy(right.start_date) ? pyString(right.start_date) : "",
        pyTruthy(left.start_date) ? pyString(left.start_date) : "",
      );
    });
    ordered.forEach((exp, index) => {
      recencyRank.set(pyString(exp.id ?? null), index);
    });
    const leastRecentFirst = [...byRole.keys()]
      .filter((expId) => (byRole.get(expId) ?? []).length > 0)
      .sort((left, right) => (recencyRank.get(right) ?? 0) - (recencyRank.get(left) ?? 0));
    for (const expId of leastRecentFirst) {
      if (over <= 0) {
        break;
      }
      const list = byRole.get(expId) ?? [];
      const rankedCount = list.filter((fid) => rankedSet.has(fid)).length;
      // Backfilled bullets sit after ranked ones; drop from the tail, but
      // never a role's last bullet and never a ranked bullet.
      const removable = list.length - Math.max(1, rankedCount);
      const drop = Math.min(Math.max(0, removable), over);
      if (drop > 0) {
        byRole.set(expId, list.slice(0, list.length - drop));
        over -= drop;
      }
    }
  }
  return byRole;
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
  const budgets = {
    maxPerRole: RESUME_CONFIG.maxExperienceBullets,
    maxPriorRole: RESUME_CONFIG.maxPriorRoleBullets,
    maxTotal: RESUME_CONFIG.maxTotalBullets,
  };
  const ranked = rankFacts({ profile, requirements: input.requirements, config: budgets }).factIds;

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

  const selectedByRole = selectRoleFacts({ profile, approved, ranked, budgets });
  const citedFactIds: string[] = [...summary.fact_ids];
  for (const exp of profile.work_experience) {
    const expId = pyString(exp.id ?? null);
    for (const fid of selectedByRole.get(expId) ?? []) {
      const fact = approved.get(fid) ?? null;
      if (fact === null) {
        throw new Error(`internal: selected fact_id '${fid}' is not an approved profile fact`);
      }
      citedFactIds.push(fid);
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
    citedFactIds,
    summaryStrategy: summary.strategy,
    summaryFallbackReason: summary.fallback_reason,
  };
}
