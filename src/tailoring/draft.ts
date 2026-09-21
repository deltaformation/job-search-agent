import type { FocusV1, RecommendationV1 } from "../domain/tailoringWorkspace";
import { RESUME_CONFIG } from "../resumes/config";
import { orderRankedFactsWithFocus } from "./focusSteering";
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
 * `validateDraft` downstream. Optional v1.3 focus steering only reorders
 * the ranker's eligible output before section selection; budgets, claims,
 * and summary strategies are unchanged. Optional S2-D edited-plan input
 * instead renders the frozen edited summary plus the exact final bullets
 * (verbatim master rows and verdict-bound edited rows); bullet
 * counts are advisory length guidance, never trimmed and never a
 * failure — every deliberately kept bullet renders as is, because
 * the worker must never silently drop chosen content.
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

/**
 * S2-D frozen edited plan, compiled by the worker from immutable
 * generation inputs (never live workspace state). The summary and
 * every non-verbatim bullet were pinned to supported verdicts
 * upstream; `verbatim` bullets repeat snapshot fact bytes exactly.
 */
export interface EditedPlanBullet {
  roleId: string;
  text: string;
  factIds: string[];
  strategy: "verbatim" | "edited_plan";
}

export interface EditedPlanInput {
  summary: { text: string; factIds: string[] };
  bullets: EditedPlanBullet[];
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
  focusSteering?: { focus: FocusV1; recommendations: RecommendationV1 };
  editedPlan?: EditedPlanInput;
}): TailoredDraft {
  const { profile } = input;
  const budgets = {
    maxPerRole: RESUME_CONFIG.maxExperienceBullets,
    maxPriorRole: RESUME_CONFIG.maxPriorRoleBullets,
    maxTotal: RESUME_CONFIG.maxTotalBullets,
  };
  const legacyRanked = rankFacts({
    profile,
    requirements: input.requirements,
    config: budgets,
  }).factIds;
  if (input.focusSteering !== undefined && input.editedPlan !== undefined) {
    throw new Error("internal: focus steering and an edited plan are mutually exclusive");
  }
  const ranked =
    input.focusSteering === undefined
      ? legacyRanked
      : orderRankedFactsWithFocus({
          rankedFactIds: legacyRanked,
          profile,
          focus: input.focusSteering.focus,
          recommendations: input.focusSteering.recommendations,
        }).rankedFactIds;

  if (input.editedPlan !== undefined) {
    return buildEditedDraft({
      profile,
      rankedFactIds: legacyRanked,
      jobId: input.jobId,
      jobTitle: input.jobTitle,
      jobCompany: input.jobCompany,
      editedPlan: input.editedPlan,
    });
  }

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

  appendEducationClaims(profile, claims);
  numberDraftClaims(claims);

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

/**
 * S2-D edited-plan draft: the frozen edited summary plus the exact
 * final bullets in employment order. Untouched master rows render
 * their snapshot fact bytes verbatim; every other bullet renders
 * its verdict-bound text under `edited_plan`. Per-role and total
 * bullet counts are advisory length guidance — rendered as is,
 * never trimmed, never a failure. Unknown roles still refuse:
 * no employment can carry them, and generation never drops
 * content silently.
 */
function buildEditedDraft(input: {
  profile: CandidateProfileInput;
  rankedFactIds: string[];
  jobId: string;
  jobTitle: string | null;
  jobCompany: string | null;
  editedPlan: EditedPlanInput;
}): TailoredDraft {
  const { profile, editedPlan } = input;
  if (editedPlan.summary.text.trim() === "") {
    throw new Error("internal: edited plan carries no summary text");
  }
  // Anchorless summaries are legitimate: correction
  // master-summary segments carry no fact anchors (their lineage
  // is the verified captured binding, not cited facts). Bullets
  // below still require ≥1 anchor each.
  const approved = new Map<string, CandidateProfileInput["verified_facts"][number]>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      approved.set(fact.fact_id, fact);
    }
  }
  const unionEvidence = (factIds: string[]): { technologies: string[]; metrics: string[] } => {
    const technologies: string[] = [];
    const metrics: string[] = [];
    for (const fid of factIds) {
      const fact = approved.get(fid);
      if (fact === undefined) {
        throw new Error(`internal: edited plan cites unapproved fact_id '${fid}'`);
      }
      for (const technology of fact.technologies) {
        if (!technologies.includes(technology)) {
          technologies.push(technology);
        }
      }
      for (const metric of fact.metrics) {
        if (!metrics.includes(metric)) {
          metrics.push(metric);
        }
      }
    }
    return { technologies, metrics };
  };

  const claims: Array<Record<string, unknown>> = [];
  const summaryEvidence = unionEvidence(editedPlan.summary.factIds);
  claims.push({
    section: "summary",
    text: editedPlan.summary.text,
    fact_ids: [...editedPlan.summary.factIds],
    claimed_technologies: summaryEvidence.technologies,
    claimed_metrics: summaryEvidence.metrics,
    generation_strategy: "edited_plan",
  });

  const byRole = new Map<string, EditedPlanBullet[]>();
  for (const bullet of editedPlan.bullets) {
    const list = byRole.get(bullet.roleId) ?? [];
    list.push(bullet);
    byRole.set(bullet.roleId, list);
  }
  const citedFactIds: string[] = [...editedPlan.summary.factIds];
  for (const exp of profile.work_experience) {
    const expId = pyString(exp.id ?? null);
    const bullets = byRole.get(expId) ?? [];
    for (const bullet of bullets) {
      if (bullet.factIds.length === 0) {
        throw new Error("internal: edited bullet cites no facts");
      }
      if (bullet.strategy === "verbatim" && bullet.factIds.length !== 1) {
        throw new Error("internal: verbatim edited bullet must cite exactly one fact");
      }
      const evidence = unionEvidence(bullet.factIds);
      citedFactIds.push(...bullet.factIds);
      claims.push({
        section: "experience",
        entity_id: expId,
        company: exp.company,
        role: exp.role,
        dates: { start: pyString(exp.start_date), end: employmentEnd(exp) },
        text: bullet.text,
        fact_ids: [...bullet.factIds],
        claimed_technologies: evidence.technologies,
        claimed_metrics: evidence.metrics,
        generation_strategy: bullet.strategy,
      });
    }
  }
  const knownRoles = new Set(profile.work_experience.map((exp) => pyString(exp.id ?? null)));
  for (const roleId of byRole.keys()) {
    if (!knownRoles.has(roleId)) {
      throw new Error(
        `internal: edited plan targets unknown role '${roleId}'; refusing to drop chosen content`,
      );
    }
  }

  appendEducationClaims(profile, claims);
  numberDraftClaims(claims);

  return {
    draft: {
      job_id: input.jobId,
      target_role: input.jobTitle,
      target_company: input.jobCompany,
      claims,
    },
    rankedFactIds: input.rankedFactIds,
    citedFactIds,
    summaryStrategy: "edited_plan",
    summaryFallbackReason: null,
  };
}

function appendEducationClaims(
  profile: CandidateProfileInput,
  claims: Array<Record<string, unknown>>,
): void {
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
}

function numberDraftClaims(claims: Array<Record<string, unknown>>): void {
  claims.forEach((claim, index) => {
    if (!isRecord(claim)) {
      throw new Error("internal: draft claim must be an object");
    }
    claim["claim_id"] = `claim_${String(index + 1).padStart(3, "0")}`;
  });
}
