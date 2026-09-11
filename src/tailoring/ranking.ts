import { z } from "zod";
import { isRecord, pyString, pyTruthy } from "./primitives";
import { CandidateProfileInput } from "./schemas";
import { compareCodePoints, normalizeTerm } from "./text";

/**
 * CoverageFirstFactRanker port (`services/documents/keywords.py`).
 *
 * Greedy set-cover over supported requirements with lexicographic keys:
 * new required coverage, new preferred coverage, evidence-backed phrase
 * hits, metric-bearing evidence, experience recency; full ties resolve by
 * `fact_id` order (sorted iteration plus strict comparison). Per-experience
 * budgets cap current vs prior roles; the loop stops when the best
 * remaining fact adds no new coverage and nothing remains uncovered.
 */

export const RANKING_POLICY_VERSION = "coverage-first/v1";

const RankEnvelope = z.object({
  profile: z.unknown(),
  requirements: z.array(z.unknown()),
  config: z
    .object({
      maxPerRole: z.number().int().optional(),
      maxPriorRole: z.number().int().optional(),
      maxTotal: z.number().int().optional(),
    })
    .optional(),
});

export interface RankResult {
  factIds: string[];
}

function evidencePhrases(text: string, technologies: string[]): Set<string> {
  const phrases = new Set<string>();
  const full = normalizeTerm(text);
  if (full !== "") {
    phrases.add(full);
  }
  for (const tech of technologies) {
    const term = normalizeTerm(tech);
    if (term !== "") {
      phrases.add(term);
    }
  }
  return phrases;
}

function compareKeys(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] as number) !== (right[index] as number)) {
      return (left[index] as number) < (right[index] as number) ? -1 : 1;
    }
  }
  return 0;
}

/** Port of `CoverageFirstFactRanker.rank`. */
export function rankFacts(input: {
  profile: unknown;
  requirements: unknown;
  config?: { maxPerRole?: number; maxPriorRole?: number; maxTotal?: number };
}): RankResult {
  const envelope = RankEnvelope.parse(input);
  const profile = CandidateProfileInput.parse(envelope.profile);
  const maxPerRole = envelope.config?.maxPerRole ?? 5;
  const maxPriorRole = envelope.config?.maxPriorRole ?? 3;
  const maxTotal = envelope.config?.maxTotal ?? 14;

  const factsById = new Map<string, (typeof profile.verified_facts)[number]>();
  for (const fact of profile.verified_facts) {
    if (fact.verification_status === "approved") {
      factsById.set(fact.fact_id, fact);
    }
  }
  if (factsById.size === 0) {
    return { factIds: [] };
  }

  const supported: Array<Record<string, unknown>> = [];
  for (const raw of envelope.requirements) {
    if (!isRecord(raw)) {
      continue;
    }
    const status = pyTruthy(raw["match_status"]) ? raw["match_status"] : raw["status"];
    if (status === "matched" || status === "partial") {
      supported.push(raw);
    }
  }

  const ridKey = (req: Record<string, unknown>): string => pyString(req["requirement_id"] ?? null);
  const requiredIds = new Set<string>();
  const preferredIds = new Set<string>();
  for (const req of supported) {
    const importance = req["importance"] === undefined ? "required" : req["importance"];
    if (importance === "required") {
      requiredIds.add(ridKey(req));
    }
    if (req["importance"] === "preferred") {
      preferredIds.add(ridKey(req));
    }
  }
  const reqQuote = new Map<string, string>();
  for (const req of supported) {
    reqQuote.set(ridKey(req), normalizeTerm(req["jd_quote"]));
  }

  const factReqs = new Map<string, Set<string>>();
  for (const req of supported) {
    const rid = ridKey(req);
    const ids =
      "evidence_fact_ids" in req ? req["evidence_fact_ids"] : (req["matched_fact_ids"] ?? []);
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const fid of ids) {
      if (typeof fid === "string" && factsById.has(fid)) {
        const set = factReqs.get(fid) ?? new Set<string>();
        set.add(rid);
        factReqs.set(fid, set);
      }
    }
  }

  const evidenceCache = new Map<string, Set<string>>();
  const metricBearing = new Set<string>();
  for (const [fid, fact] of factsById) {
    evidenceCache.set(fid, evidencePhrases(fact.text, fact.technologies));
    if (fact.metrics.length > 0) {
      metricBearing.add(fid);
    }
  }

  const experiences = profile.work_experience;
  const recencyOrder = [...experiences]
    .map((exp, index) => ({ exp, index }))
    .sort((left, right) => {
      const leftKey: [number, string, string] = [
        pyTruthy(left.exp.is_current) ? 1 : 0,
        pyTruthy(left.exp.end_date) ? pyString(left.exp.end_date) : "",
        pyTruthy(left.exp.start_date) ? pyString(left.exp.start_date) : "",
      ];
      const rightKey: [number, string, string] = [
        pyTruthy(right.exp.is_current) ? 1 : 0,
        pyTruthy(right.exp.end_date) ? pyString(right.exp.end_date) : "",
        pyTruthy(right.exp.start_date) ? pyString(right.exp.start_date) : "",
      ];
      for (let i = 0; i < 3; i += 1) {
        const l = leftKey[i] as number | string;
        const r = rightKey[i] as number | string;
        if (typeof l === "number" && typeof r === "number") {
          if (l !== r) {
            return r - l;
          }
        } else if (String(l) !== String(r)) {
          return compareCodePoints(String(r), String(l));
        }
      }
      return right.index - left.index;
    });
  const recency = new Map<string, number>();
  recencyOrder.forEach(({ exp }, index) => {
    recency.set(pyString(exp.id ?? null), index);
  });

  const phraseHits = (fid: string): number => {
    const phrases = evidenceCache.get(fid) ?? new Set<string>();
    let count = 0;
    for (const rid of factReqs.get(fid) ?? new Set<string>()) {
      const quote = reqQuote.get(rid) ?? "";
      if (quote !== "" && [...phrases].some((p) => p.includes(quote) || quote.includes(p))) {
        count += 1;
      }
    }
    return count;
  };

  const currentIds = new Set<string>();
  for (const exp of experiences) {
    if (pyTruthy(exp.is_current)) {
      currentIds.add(pyString(exp.id ?? null));
    }
  }
  const perExpCap = new Map<string, number>();
  for (const exp of experiences) {
    const eid = pyString(exp.id ?? null);
    perExpCap.set(eid, currentIds.has(eid) ? maxPerRole : maxPriorRole);
  }

  const selected: string[] = [];
  const covered = new Set<string>();
  const usedPerExp = new Map<string, number>();
  const candidates = new Set(factsById.keys());
  while (candidates.size > 0 && selected.length < maxTotal) {
    let best: string | null = null;
    let bestKey: number[] | null = null;
    for (const fid of [...candidates].sort(compareCodePoints)) {
      const reqs = new Set([...(factReqs.get(fid) ?? new Set<string>())].filter((rid) => !covered.has(rid)));
      let newRequired = 0;
      let newPreferred = 0;
      for (const rid of reqs) {
        if (requiredIds.has(rid)) {
          newRequired += 1;
        }
        if (preferredIds.has(rid)) {
          newPreferred += 1;
        }
      }
      const fact = factsById.get(fid) as (typeof profile.verified_facts)[number];
      const expId = pyTruthy(fact.work_experience_id) ? pyString(fact.work_experience_id) : "";
      const cap = perExpCap.get(expId) ?? maxPriorRole;
      if ((usedPerExp.get(expId) ?? 0) >= cap) {
        continue;
      }
      const key = [
        newRequired,
        newPreferred,
        phraseHits(fid),
        metricBearing.has(fid) ? 1 : 0,
        -(recency.get(expId) ?? 0),
      ];
      if (bestKey === null || compareKeys(key, bestKey) > 0) {
        best = fid;
        bestKey = key;
      }
    }
    if (best === null || bestKey === null) {
      break;
    }
    if (bestKey[0] === 0 && bestKey[1] === 0 && covered.size > 0) {
      const remaining = new Set([...requiredIds, ...preferredIds].filter((rid) => !covered.has(rid)));
      if (remaining.size === 0) {
        break;
      }
    }
    selected.push(best);
    candidates.delete(best);
    for (const rid of factReqs.get(best) ?? new Set<string>()) {
      covered.add(rid);
    }
    const fact = factsById.get(best) as (typeof profile.verified_facts)[number];
    const expId = pyTruthy(fact.work_experience_id) ? pyString(fact.work_experience_id) : "";
    usedPerExp.set(expId, (usedPerExp.get(expId) ?? 0) + 1);
  }
  return { factIds: selected };
}
