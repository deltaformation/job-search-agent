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

const SkillRowsEnvelope = z.object({
  profile: z.unknown(),
  requirements: z.array(z.unknown()),
  priorityQuotes: z.array(z.string()).optional(),
});

export interface SkillRowPlan {
  label: string;
  terms: string[];
}

/**
 * Categorized skill rows preserving the profile's skill taxonomy.
 *
 * Every verified profile skill is retained under its own category
 * (first-seen category order); within each row, skills matching the
 * supported JD requirement quotes sort first so JD keywords are
 * prominent, with profile order otherwise preserved. When
 * `priorityQuotes` (the Top-5 ATS keyword quotes) is provided, skills
 * matching a priority quote sort ahead of other JD-matched skills.
 * Unverified skills are excluded, exactly like the evidence gate.
 * Matching only orders — it never drops a verified skill.
 */
export function planSkillRows(input: {
  profile: unknown;
  requirements: unknown;
  priorityQuotes?: unknown;
}): SkillRowPlan[] {
  const envelope = SkillRowsEnvelope.parse(input);
  const profile = CandidateProfileInput.parse(envelope.profile);
  const quotes: string[] = [];
  for (const raw of envelope.requirements) {
    if (!isRecord(raw)) {
      continue;
    }
    const status = pyTruthy(raw["match_status"]) ? raw["match_status"] : raw["status"];
    if (status !== "matched" && status !== "partial") {
      continue;
    }
    const quote = pyTruthy(raw["jd_quote"]) ? normalizeTerm(pyString(raw["jd_quote"])) : "";
    if (quote !== "") {
      quotes.push(quote);
    }
  }
  const priority = (envelope.priorityQuotes ?? [])
    .map((quote) => normalizeTerm(quote))
    .filter((quote) => quote !== "");
  const matchLevel = (name: string): number => {
    const term = normalizeTerm(name);
    if (term === "") {
      return 0;
    }
    const hits = (pool: string[]): boolean =>
      pool.some((quote) => quote.includes(term) || term.includes(quote));
    if (priority.length > 0 && hits(priority)) {
      return 2;
    }
    return hits(quotes) ? 1 : 0;
  };
  const groups = new Map<string, Array<{ name: string; level: number; order: number }>>();
  let order = 0;
  for (const skill of profile.skills) {
    if (skill.verified !== true) {
      continue;
    }
    const name = pyTruthy(skill.name) ? pyString(skill.name) : "";
    if (name === "") {
      continue;
    }
    const rawCategory = skill.category === null || skill.category === undefined ? "" : skill.category;
    const label = pyTruthy(rawCategory) ? pyString(rawCategory).trim() : "";
    const key = label !== "" ? label : "Other";
    const list = groups.get(key) ?? [];
    list.push({ name, level: matchLevel(name), order: order++ });
    groups.set(key, list);
  }
  return [...groups.entries()].map(([label, entries]) => ({
    label,
    terms: [...entries]
      .sort((left, right) => right.level - left.level || left.order - right.order)
      .map((entry) => entry.name),
  }));
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

export const TOP_ATS_KEYWORD_LIMIT = 5;

export interface TopAtsKeyword {
  keyword: string;
  requirementId: string;
  category: string;
  importance: string;
  evidenced: boolean;
  evidenceFactIds: string[];
}

/**
 * Deterministic Top-5 ATS keyword selection over canonical (or stored
 * analysis) requirements. Gaps are included — an unevidenced top keyword
 * is an honest gap, never a resume claim — ordered required-first, then
 * evidenced before gaps, with the provider's requirement order breaking
 * ties. The quote is echoed verbatim; nothing is rephrased or invented.
 */
export function selectTopKeywords(
  requirements: unknown,
  limit: number = TOP_ATS_KEYWORD_LIMIT,
): TopAtsKeyword[] {
  const entries = Array.isArray(requirements) ? requirements : [];
  const importanceRank = (value: unknown): number => {
    if (!pyTruthy(value)) {
      return 2;
    }
    const text = pyString(value);
    if (text === "required") {
      return 0;
    }
    if (text === "preferred") {
      return 1;
    }
    return 2;
  };
  const matchRank = (value: unknown): number => {
    if (!pyTruthy(value)) {
      return 3;
    }
    const text = pyString(value);
    if (text === "matched") {
      return 0;
    }
    if (text === "partial") {
      return 1;
    }
    return 2;
  };
  const scored: Array<TopAtsKeyword & { importanceRank: number; matchRank: number; order: number }> =
    [];
  let order = 0;
  for (const raw of entries) {
    if (!isRecord(raw)) {
      continue;
    }
    const keyword = pyTruthy(raw["jd_quote"]) ? pyString(raw["jd_quote"]) : "";
    const requirementId = pyTruthy(raw["requirement_id"]) ? pyString(raw["requirement_id"]) : "";
    if (keyword === "" || requirementId === "") {
      continue;
    }
    const status = pyTruthy(raw["match_status"]) ? raw["match_status"] : raw["status"];
    const idsRaw = "evidence_fact_ids" in raw ? raw["evidence_fact_ids"] : [];
    const evidenceFactIds = Array.isArray(idsRaw)
      ? idsRaw.filter((fid): fid is string => typeof fid === "string")
      : [];
    scored.push({
      keyword,
      requirementId,
      category: pyTruthy(raw["category"]) ? pyString(raw["category"]) : "unknown",
      importance: pyTruthy(raw["importance"]) ? pyString(raw["importance"]) : "unspecified",
      evidenced: pyString(status) === "matched" || pyString(status) === "partial",
      evidenceFactIds,
      importanceRank: importanceRank(raw["importance"]),
      matchRank: matchRank(status),
      order: order++,
    });
  }
  scored.sort(
    (left, right) =>
      left.importanceRank - right.importanceRank ||
      left.matchRank - right.matchRank ||
      left.order - right.order,
  );
  const unique: typeof scored = [];
  const seenRequirementIds = new Set<string>();
  const seenKeywords = new Set<string>();
  for (const item of scored) {
    const normQuote = item.keyword.trim().toLowerCase();
    if (seenRequirementIds.has(item.requirementId) || seenKeywords.has(normQuote)) {
      continue;
    }
    seenRequirementIds.add(item.requirementId);
    seenKeywords.add(normQuote);
    unique.push(item);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique.map((entry) => ({
    keyword: entry.keyword,
    requirementId: entry.requirementId,
    category: entry.category,
    importance: entry.importance,
    evidenced: entry.evidenced,
    evidenceFactIds: entry.evidenceFactIds,
  }));
}

export type KeywordPlacement = "header" | "summary" | "skills" | "experience";

const PLACEMENT_STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "for",
  "from",
  "that",
  "this",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "will",
  "would",
  "should",
  "could",
  "you",
  "your",
  "our",
  "their",
  "they",
  "them",
  "than",
  "then",
  "such",
  "into",
  "over",
  "under",
  "plus",
  "per",
]);

function significantTerms(quote: string): string[] {
  return normalizeTerm(quote)
    .split(" ")
    .filter((term) => term.length >= 3 && !PLACEMENT_STOPWORDS.has(term));
}

/**
 * Keyword-in-text test for the placement audit: an exact normalized
 * substring wins immediately, otherwise at least two significant quote
 * terms (or the single term when the quote has only one) must appear.
 * Purely presentational — evidence truth comes from fact citations,
 * never from this heuristic.
 */
export function quoteAppearsIn(text: string, quote: string): boolean {
  const haystack = normalizeTerm(text);
  const needle = normalizeTerm(quote);
  if (haystack === "" || needle === "") {
    return false;
  }
  if (haystack.includes(needle) || needle.includes(haystack)) {
    return true;
  }
  const terms = significantTerms(quote);
  if (terms.length === 0) {
    return false;
  }
  const words = new Set(haystack.split(" "));
  const hits = terms.filter((term) => words.has(term)).length;
  return hits >= Math.min(2, terms.length);
}

/**
 * Placement audit for one Top-5 keyword: which rendered resume sections
 * mention it. Skill rows reuse the planner's own match rule so the
 * audit agrees with what the renderer front-loaded.
 */
export function locateKeywordPlacements(input: {
  keyword: string;
  headerText: string;
  summaryText: string;
  skillTerms: string[];
  bulletTexts: string[];
}): KeywordPlacement[] {
  const { keyword, headerText, summaryText, skillTerms, bulletTexts } = input;
  const placements: KeywordPlacement[] = [];
  if (quoteAppearsIn(headerText, keyword)) {
    placements.push("header");
  }
  if (quoteAppearsIn(summaryText, keyword)) {
    placements.push("summary");
  }
  const needle = normalizeTerm(keyword);
  const skillHit =
    needle !== "" &&
    skillTerms.some((term) => {
      const normalized = normalizeTerm(term);
      return normalized !== "" && (needle.includes(normalized) || normalized.includes(needle));
    });
  if (skillHit) {
    placements.push("skills");
  }
  if (bulletTexts.some((bullet) => quoteAppearsIn(bullet, keyword))) {
    placements.push("experience");
  }
  return placements;
}
