import { z } from "zod";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { RANKING_POLICY_VERSION } from "./ranking";
import { CandidateProfileInput } from "./schemas";
import { hasWordBoundary, normalizeTerm } from "./text";

/**
 * Keyword ports (`evidence_qualified_skills`, `KeywordPlanner.plan`).
 *
 * Terms from `gap`/`unsupported` requirements are reported but never
 * rendered; the planner echoes the requirement's own quote verbatim and
 * never invents synonyms. Non-record requirements are skipped exactly like
 * the oracle (without counting toward totals).
 */

const SkillsEnvelope = z.object({
  profile: z.unknown(),
  citedFactIds: z.array(z.string()),
});

export interface QualifiedSkills {
  skills: string[];
}

/** Port of `evidence_qualified_skills`. */
export function evidenceQualifiedSkills(input: {
  profile: unknown;
  citedFactIds: unknown;
}): QualifiedSkills {
  const envelope = SkillsEnvelope.parse(input);
  const profile = CandidateProfileInput.parse(envelope.profile);
  const factsById = new Map<string, (typeof profile.verified_facts)[number]>();
  for (const fact of profile.verified_facts) {
    factsById.set(fact.fact_id, fact);
  }
  const evidence = new Set<string>();
  for (const fid of envelope.citedFactIds) {
    const fact = factsById.get(fid);
    if (fact === undefined) {
      continue;
    }
    const full = normalizeTerm(fact.text);
    if (full !== "") {
      evidence.add(full);
    }
    for (const tech of fact.technologies) {
      const term = normalizeTerm(tech);
      if (term !== "") {
        evidence.add(term);
      }
    }
  }
  const qualified: string[] = [];
  for (const skill of profile.skills) {
    if (skill.verified !== true) {
      continue;
    }
    const name = pyTruthy(skill.name) ? pyString(skill.name) : "";
    const term = normalizeTerm(name);
    if (term === "") {
      continue;
    }
    if ([...evidence].some((phrase) => term === phrase || hasWordBoundary(term, phrase))) {
      qualified.push(name);
    }
  }
  return { skills: qualified };
}

const PlanEnvelope = z.object({
  profile: z.unknown(),
  requirements: z.array(z.unknown()),
  rankedFactIds: z.array(z.string()),
  skillTerms: z.unknown().optional(),
});

export interface KeywordTerm {
  jd_term: string;
  requirement_id: string;
  jd_quote: string;
  importance: unknown;
  match_status: string;
  evidence_fact_ids: string[];
  decision: string;
  placement: string;
  rendered_phrase: string;
  variant_id: null;
}

export interface KeywordPlan {
  plan_version: string;
  ranking_policy_version: string;
  ranked_fact_ids: string[];
  skill_terms: unknown[];
  terms: KeywordTerm[];
  omitted_unsupported: string[];
  coverage_report: {
    supported_keyword_coverage: number;
    full_jd_keyword_coverage: number;
    covered_supported_requirements: number;
    total_supported_requirements: number;
    total_requirements: number;
  };
}

/** Port of `KeywordPlanner.plan`. */
export function planKeywords(input: {
  profile: unknown;
  requirements: unknown;
  rankedFactIds: unknown;
  skillTerms?: unknown;
}): KeywordPlan {
  const envelope = PlanEnvelope.parse(input);
  const profile = CandidateProfileInput.parse(envelope.profile);
  const factsById = new Set(profile.verified_facts.map((fact) => fact.fact_id));
  const selected = new Set(envelope.rankedFactIds);
  const terms: KeywordTerm[] = [];
  let coveredSupported = 0;
  let totalSupported = 0;
  let totalAll = 0;

  for (const raw of envelope.requirements) {
    if (!isRecord(raw)) {
      continue;
    }
    totalAll += 1;
    const status = pyTruthy(raw["match_status"]) ? raw["match_status"] : raw["status"];
    const rid = "requirement_id" in raw ? pyString(raw["requirement_id"]) : "";
    const quote = pyTruthy(raw["jd_quote"]) ? pyString(raw["jd_quote"]) : "";
    const idsRaw = "evidence_fact_ids" in raw ? raw["evidence_fact_ids"] : (raw["matched_fact_ids"] ?? []);
    const ids = Array.isArray(idsRaw) ? idsRaw : [];
    const importance = "importance" in raw ? raw["importance"] : "required";
    if (status === "matched" || status === "partial") {
      totalSupported += 1;
      const chosen = ids.filter(
        (fid): fid is string => typeof fid === "string" && selected.has(fid),
      );
      if (chosen.length > 0) {
        coveredSupported += 1;
      }
      terms.push({
        jd_term: quote,
        requirement_id: rid,
        jd_quote: quote,
        importance,
        match_status: status,
        evidence_fact_ids: ids.filter(
          (fid): fid is string => typeof fid === "string" && factsById.has(fid),
        ),
        decision: chosen.length > 0 ? "include_exact" : "omit_unsupported",
        placement: chosen.length > 0 ? "experience" : "omitted",
        rendered_phrase: chosen.length > 0 ? quote : "",
        variant_id: null,
      });
    } else if (status === "gap" || status === "unsupported") {
      terms.push({
        jd_term: quote,
        requirement_id: rid,
        jd_quote: quote,
        importance,
        match_status: status,
        evidence_fact_ids: [],
        decision: "omit_unsupported",
        placement: "omitted",
        rendered_phrase: "",
        variant_id: null,
      });
    }
  }

  const omitted = terms.filter((term) => term.decision === "omit_unsupported").map((term) => term.jd_term);
  const skillTermsRaw = envelope.skillTerms;
  const skillTerms: unknown[] = Array.isArray(skillTermsRaw)
    ? [...skillTermsRaw]
    : typeof skillTermsRaw === "string"
      ? Array.from(skillTermsRaw)
      : [];
  return {
    plan_version: "KeywordPlanV1",
    ranking_policy_version: RANKING_POLICY_VERSION,
    ranked_fact_ids: [...envelope.rankedFactIds],
    skill_terms: skillTerms,
    terms,
    omitted_unsupported: omitted,
    coverage_report: {
      supported_keyword_coverage: totalSupported > 0 ? coveredSupported / totalSupported : 0.0,
      full_jd_keyword_coverage: totalAll > 0 ? coveredSupported / totalAll : 0.0,
      covered_supported_requirements: coveredSupported,
      total_supported_requirements: totalSupported,
      total_requirements: totalAll,
    },
  };
}
