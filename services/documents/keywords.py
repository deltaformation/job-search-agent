"""Evidence-grounded keyword planning and coverage-first fact ranking (M8b).

Every keyword rendered anywhere (experience bullets, summary, skills rows)
must map to approved ``fact_id`` evidence from the bound candidate snapshot
or to a separately human-approved wording variant. Terms from ``gap`` or
``unsupported`` requirements are reported but never rendered.

Normalization is deliberately narrow (case/Unicode/punctuation/hyphen/
whitespace). It never infers synonyms. An acronym or alternate wording is
eligible only when both forms already appear in the same approved evidence
or a human-approved variant explicitly connects them.
"""
import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

RANKING_POLICY_VERSION = "coverage-first/v1"

_SUPPORTED_STATUS = {"matched", "partial"}
_UNSUPPORTED_STATUS = {"gap", "unsupported"}


def normalize_term(text: str) -> str:
    """Narrow normalization: casefold, Unicode NFKC, hyphens/punctuation to spaces."""
    cleaned = unicodedata.normalize("NFKC", str(text or ""))
    cleaned = cleaned.casefold()
    cleaned = cleaned.replace("-", " ").replace("/", " ")
    cleaned = re.sub(r"[^\w\s]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def normalize_fact_evidence(fact: Dict[str, Any]) -> Set[str]:
    """Normalized evidence phrases for one approved fact: full text plus tech terms."""
    phrases: Set[str] = set()
    text = normalize_term(fact.get("text", ""))
    if text:
        phrases.add(text)
    for tech in fact.get("technologies", []) or []:
        term = normalize_term(tech)
        if term:
            phrases.add(term)
    return phrases


def evidence_qualified_skills(
    profile: Dict[str, Any], cited_fact_ids: List[str]
) -> List[str]:
    """Verified skills whose exact term appears in cited fact text/technology metadata.

    Per the M8 clarification: direct skill-to-fact_id linkage does not exist,
    so a skill term qualifies only when its normalized form is a substring of
    (or equal to) normalized evidence from a cited approved fact.
    """
    facts_by_id = {
        f.get("fact_id"): f
        for f in (profile.get("verified_facts", []) or [])
        if isinstance(f, dict) and f.get("verification_status") == "approved"
    }
    evidence: Set[str] = set()
    for fid in cited_fact_ids:
        fact = facts_by_id.get(fid)
        if fact:
            evidence.update(normalize_fact_evidence(fact))
    qualified: List[str] = []
    for skill in (profile.get("skills", []) or []):
        if not isinstance(skill, dict) or skill.get("verified") is not True:
            continue
        name = str(skill.get("name", "") or "")
        term = normalize_term(name)
        if not term:
            continue
        pattern = re.compile(r"\b" + re.escape(term) + r"\b")
        if any(term == phrase or pattern.search(phrase) for phrase in evidence):
            qualified.append(name)
    return qualified


class CoverageFirstFactRanker:
    """Deterministic greedy set-cover over validated requirements.

    Selection order (lexicographic, no heuristic weights):
      1. unique supported ``required``-requirement coverage,
      2. unique supported ``preferred``-requirement coverage,
      3. exact evidence-backed JD phrase coverage,
      4. metric-bearing evidence,
      5. work-experience recency,
      6. stable ``fact_id`` alphabetical tie-break.

    A requirement earns coverage credit once; later facts citing only
    already-covered requirements gain no requirement credit
    (duplicate-coverage suppression). Raw JD tokens outside a validated
    requirement with approved evidence never influence ranking.
    """

    def __init__(
        self,
        max_per_role: int = 5,
        max_prior_role: int = 3,
        max_total: int = 14,
    ) -> None:
        self.max_per_role = max_per_role
        self.max_prior_role = max_prior_role
        self.max_total = max_total

    def rank(
        self,
        requirements: List[Dict[str, Any]],
        candidate_profile: Dict[str, Any],
    ) -> List[str]:
        facts_by_id = {
            f.get("fact_id"): f
            for f in (candidate_profile.get("verified_facts", []) or [])
            if isinstance(f, dict)
            and isinstance(f.get("fact_id"), str)
            and f.get("verification_status") == "approved"
        }
        if not facts_by_id:
            return []

        supported = [
            r for r in requirements
            if isinstance(r, dict) and (r.get("match_status") or r.get("status")) in _SUPPORTED_STATUS
        ]
        required_ids = {
            str(r.get("requirement_id"))
            for r in supported if r.get("importance", "required") == "required"
        }
        preferred_ids = {
            str(r.get("requirement_id"))
            for r in supported if r.get("importance") == "preferred"
        }
        req_quote: Dict[str, str] = {}
        for req in supported:
            rid = str(req.get("requirement_id"))
            quote = req.get("jd_quote") or ""
            req_quote[rid] = normalize_term(quote)

        # fact -> requirements it can cover (only via cited approved evidence).
        fact_reqs: Dict[str, Set[str]] = {}
        for req in supported:
            rid = str(req.get("requirement_id"))
            ids = req.get("evidence_fact_ids", req.get("matched_fact_ids", []))
            if not isinstance(ids, list):
                continue
            for fid in ids:
                if fid in facts_by_id:
                    fact_reqs.setdefault(fid, set()).add(rid)

        evidence_cache = {fid: normalize_fact_evidence(f) for fid, f in facts_by_id.items()}
        metric_bearing = {
            fid for fid, f in facts_by_id.items() if f.get("metrics")
        }

        experiences = list(candidate_profile.get("work_experience", []) or [])
        recency = {str(e.get("id")): i for i, e in enumerate(
            sorted(experiences,
                   key=lambda e: (1 if e.get("is_current") else 0,
                                  str(e.get("end_date") or ""),
                                  str(e.get("start_date") or "")),
                   reverse=True))}

        def phrase_hits(fid: str) -> int:
            phrases = evidence_cache[fid]
            count = 0
            for rid in fact_reqs.get(fid, set()):
                quote = req_quote.get(rid, "")
                if quote and any(quote in p or p in quote for p in phrases):
                    count += 1
            return count

        per_exp_cap: Dict[str, int] = {}
        current_ids = {str(e.get("id")) for e in experiences if e.get("is_current")}
        for exp in experiences:
            eid = str(exp.get("id"))
            per_exp_cap[eid] = self.max_per_role if eid in current_ids else self.max_prior_role

        selected: List[str] = []
        covered: Set[str] = set()
        used_per_exp: Dict[str, int] = {}
        candidates = set(facts_by_id)
        while candidates and len(selected) < self.max_total:
            best: Optional[str] = None
            best_key: Optional[Tuple] = None
            # Sorted iteration + strict comparison => stable fact_id order wins ties.
            for fid in sorted(candidates):
                reqs = fact_reqs.get(fid, set()) - covered
                new_required = len(reqs & required_ids)
                new_preferred = len(reqs & preferred_ids)
                exp_id = str(facts_by_id[fid].get("work_experience_id") or "")
                cap = per_exp_cap.get(exp_id, self.max_prior_role)
                if used_per_exp.get(exp_id, 0) >= cap:
                    continue
                key = (
                    new_required,
                    new_preferred,
                    phrase_hits(fid),
                    1 if fid in metric_bearing else 0,
                    -(recency.get(exp_id, 0)),
                )
                if best_key is None or key > best_key:
                    best = fid
                    best_key = key
            if best is None:
                break
            # Stop when the best remaining fact adds no new requirement coverage
            # and all supported requirements are already covered: leftover budget
            # must not stuff redundant bullets.
            assert best_key is not None
            if best_key[0] == 0 and best_key[1] == 0 and covered:
                remaining_uncovered = (required_ids | preferred_ids) - covered
                if not remaining_uncovered:
                    break
            selected.append(best)
            candidates.discard(best)
            covered.update(fact_reqs.get(best, set()))
            exp_id = str(facts_by_id[best].get("work_experience_id") or "")
            used_per_exp[exp_id] = used_per_exp.get(exp_id, 0) + 1
        return selected


class KeywordPlanner:
    """Build the deterministic ``KeywordPlanV1`` audit payload."""

    def plan(
        self,
        requirements: List[Dict[str, Any]],
        ranked_fact_ids: List[str],
        candidate_profile: Dict[str, Any],
        skill_terms: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        facts_by_id = {
            f.get("fact_id"): f
            for f in (candidate_profile.get("verified_facts", []) or [])
            if isinstance(f, dict)
        }
        selected = set(ranked_fact_ids)
        terms: List[Dict[str, Any]] = []
        covered_supported = 0
        total_supported = 0
        total_all = 0
        for req in requirements:
            if not isinstance(req, dict):
                continue
            total_all += 1
            status = req.get("match_status") or req.get("status")
            rid = str(req.get("requirement_id", ""))
            quote = str(req.get("jd_quote", "") or "")
            ids = req.get("evidence_fact_ids", req.get("matched_fact_ids", []))
            if not isinstance(ids, list):
                ids = []
            if status in _SUPPORTED_STATUS:
                total_supported += 1
                chosen = [fid for fid in ids if fid in selected]
                if chosen:
                    covered_supported += 1
                    decision = "include_exact"
                else:
                    decision = "omit_unsupported"
                terms.append({
                    "jd_term": quote,
                    "requirement_id": rid,
                    "jd_quote": quote,
                    "importance": req.get("importance", "required"),
                    "match_status": status,
                    "evidence_fact_ids": [fid for fid in ids if fid in facts_by_id],
                    "decision": decision,
                    "placement": "experience" if chosen else "omitted",
                    "rendered_phrase": quote if chosen else "",
                    "variant_id": None,
                })
            elif status in _UNSUPPORTED_STATUS:
                terms.append({
                    "jd_term": quote,
                    "requirement_id": rid,
                    "jd_quote": quote,
                    "importance": req.get("importance", "required"),
                    "match_status": status,
                    "evidence_fact_ids": [],
                    "decision": "omit_unsupported",
                    "placement": "omitted",
                    "rendered_phrase": "",
                    "variant_id": None,
                })
        omitted = [t["jd_term"] for t in terms if t["decision"] == "omit_unsupported"]
        report = {
            "supported_keyword_coverage": (covered_supported / total_supported) if total_supported else 0.0,
            "full_jd_keyword_coverage": (covered_supported / total_all) if total_all else 0.0,
            "covered_supported_requirements": covered_supported,
            "total_supported_requirements": total_supported,
            "total_requirements": total_all,
        }
        return {
            "plan_version": "KeywordPlanV1",
            "ranking_policy_version": RANKING_POLICY_VERSION,
            "ranked_fact_ids": list(ranked_fact_ids),
            "skill_terms": list(skill_terms or []),
            "terms": terms,
            "omitted_unsupported": omitted,
            "coverage_report": report,
        }
