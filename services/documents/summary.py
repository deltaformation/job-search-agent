"""Constrained summary composition for Milestone 8b.

Generic generative prose is prohibited. The only allowed strategies are:

- ``verbatim``: directly quotes one approved fact.
- ``approved_variant``: uses a separately human-approved wording variant.
- ``derived_template``: assembled from typed, reconstructable slots under the
  versioned ``summary/v1`` formula. The derivation manifest persists every
  input so validation can re-execute the formula and require byte-for-byte
  identity with the final text.

Checking that output words appear somewhere in cited facts is explicitly
insufficient: individually supported words can still form an unsupported
assertion. Only the fixed formula plus slot provenance checks are accepted.
"""
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from services.documents.keywords import normalize_term

FORMULA_VERSION = "summary/v1"

# Fixed neutral connectors owned by the versioned formula. They cannot
# introduce causality, ownership, scale, seniority, or outcomes.
_CONNECTOR_WITH = "with"
_CONNECTOR_SPECIALIZING = "Specializing in"


@dataclass
class SummaryResult:
    strategy: str  # "derived_template" | "verbatim" | "none"
    text: str
    fact_ids: List[str]
    derivation: Optional[Dict[str, Any]]
    fallback_reason: Optional[str]  # None when derived_template succeeds


def _parse_year_month(value: Any) -> Optional[Tuple[int, int]]:
    text = str(value or "").strip()
    if not text:
        return None
    parts = text.replace("/", "-").split("-")
    try:
        year = int(parts[0])
        month = int(parts[1]) if len(parts) > 1 else 1
        day = int(parts[2]) if len(parts) > 2 else 1
    except ValueError:
        return None
    if not 1 <= month <= 12 or year < 1900 or year > 2100:
        return None
    if len(parts) > 2 and not 1 <= day <= 29 and month == 2:
        # Day 30/31 never occurs in February, including leap years.
        return None
    if len(parts) > 2 and not 1 <= day <= 31:
        return None
    return year, month


def unioned_career_months(
    work_experiences: List[Dict[str, Any]],
    calculation_as_of: date,
) -> Tuple[int, List[Dict[str, Any]]]:
    """Union overlapping employment calendar months, capped at ``calculation_as_of``.

    Month granularity: any touched calendar month counts once; overlapping
    jobs never double-count. Returns (total_months, capped_intervals) where
    each interval records the work_experience_id and the capped start/end.
    """
    as_of_idx = calculation_as_of.year * 12 + (calculation_as_of.month - 1)
    covered: set[int] = set()
    intervals: List[Dict[str, Any]] = []
    for exp in work_experiences:
        if not isinstance(exp, dict):
            continue
        start = _parse_year_month(exp.get("start_date"))
        if start is None:
            continue
        start_idx = start[0] * 12 + (start[1] - 1)
        end_raw = exp.get("end_date")
        if end_raw:
            end = _parse_year_month(end_raw)
            if end is None:
                continue
            end_idx = end[0] * 12 + (end[1] - 1)
        else:
            end_idx = as_of_idx
        end_idx = min(end_idx, as_of_idx)
        if end_idx < start_idx:
            continue
        for idx in range(start_idx, end_idx + 1):
            covered.add(idx)
        intervals.append({
            "work_experience_id": str(exp.get("id") or ""),
            "start": f"{start[0]:04d}-{start[1]:02d}",
            "end": f"{end_idx // 12:04d}-{end_idx % 12 + 1:02d}",
        })
    intervals.sort(key=lambda i: (i["start"], i["end"], i["work_experience_id"]))
    return len(covered), intervals


def _duration_label(completed_years: int) -> str:
    unit = "year" if completed_years == 1 else "years"
    return f"{_CONNECTOR_WITH} {completed_years} {unit} of professional experience"


def _oxford_join(terms: List[str]) -> str:
    if len(terms) == 1:
        return terms[0]
    if len(terms) == 2:
        return f"{terms[0]} and {terms[1]}"
    return ", ".join(terms[:-1]) + f", and {terms[-1]}"


def build_derived_text(slot_values: Dict[str, Any]) -> str:
    """Re-execute the versioned formula. Single source of truth for composer + validator."""
    parts = [
        f"{slot_values['title_family']} {_duration_label(slot_values['completed_years'])}.",
        f"{_CONNECTOR_SPECIALIZING} {slot_values['domains_techs']}.",
        slot_values["proof_point"],
    ]
    if slot_values.get("target_label"):
        parts.append(slot_values["target_label"])
    return " ".join(parts)


def compose_summary(
    profile: Dict[str, Any],
    ranked_fact_ids: List[str],
    job_title: str,
    calculation_as_of: date,
    max_domain_terms: int = 4,
) -> SummaryResult:
    """Compose a constrained summary or fall back to verbatim with a reason code."""
    facts_by_id = {
        f.get("fact_id"): f
        for f in (profile.get("verified_facts", []) or [])
        if isinstance(f, dict) and f.get("verification_status") == "approved"
    }
    ranked = [fid for fid in ranked_fact_ids if fid in facts_by_id]
    if not ranked:
        return SummaryResult("none", "", [], None, "NO_EVIDENCE")

    headline = str(profile.get("headline") or "").strip()
    target_titles = [str(t) for t in (profile.get("target_titles", []) or []) if str(t).strip()]
    title_family = headline or (target_titles[0] if target_titles else "")
    if not title_family:
        fact = facts_by_id[ranked[0]]
        return SummaryResult("verbatim", str(fact.get("text", "")), [fact["fact_id"]], None, "NO_TITLE")

    total_months, intervals = unioned_career_months(
        list(profile.get("work_experience", []) or []), calculation_as_of
    )
    completed_years = total_months // 12
    if completed_years < 1:
        fact = facts_by_id[ranked[0]]
        return SummaryResult("verbatim", str(fact.get("text", "")), [fact["fact_id"]], None, "THIN_TENURE")

    # Domains/technologies: exact phrases from cited facts, rank order, deduped.
    seen: set[str] = set()
    domain_terms: List[str] = []
    cited_ids: List[str] = []
    for fid in ranked:
        fact = facts_by_id[fid]
        cited_ids.append(fid)
        for tech in (fact.get("technologies", []) or []):
            term = str(tech or "").strip()
            key = normalize_term(term)
            if term and key not in seen:
                seen.add(key)
                domain_terms.append(term)
        if len(domain_terms) >= max_domain_terms:
            break
    if not domain_terms:
        fact = facts_by_id[ranked[0]]
        return SummaryResult("verbatim", str(fact.get("text", "")), [fact["fact_id"]], None, "NO_DOMAINS")
    domain_terms = domain_terms[:max_domain_terms]

    proof_fact = facts_by_id[ranked[0]]
    proof_point = str(proof_fact.get("text", "") or "")

    # The JD title may appear only as an explicitly labeled target, and only
    # when it matches the canonical allow-list (headline/target_titles).
    target_label = ""
    normalized_job = normalize_term(job_title)
    allow_list = {normalize_term(headline)} | {normalize_term(t) for t in target_titles}
    if normalized_job and normalized_job in allow_list:
        target_label = f"Targeting {str(job_title).strip()} roles."

    slot_values: Dict[str, Any] = {
        "title_family": title_family,
        "completed_years": completed_years,
        "domains_techs": _oxford_join(domain_terms),
        "proof_point": proof_point,
        "target_label": target_label,
    }
    derivation: Dict[str, Any] = {
        "formula_version": FORMULA_VERSION,
        "calculation_as_of": calculation_as_of.isoformat(),
        "employment_intervals": intervals,
        "total_months": total_months,
        "fact_ids": cited_ids,
        "proof_fact_id": proof_fact["fact_id"],
        "slot_values": slot_values,
        "final_text": "",
    }
    final_text = build_derived_text(slot_values)
    derivation["final_text"] = final_text
    return SummaryResult("derived_template", final_text, cited_ids, derivation, None)


def verify_derivation(manifest: Dict[str, Any], profile: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Re-execute the formula from the manifest and require byte-for-byte identity."""
    errors: List[str] = []
    if not isinstance(manifest, dict):
        return False, ["Summary derivation manifest must be an object."]
    if manifest.get("formula_version") != FORMULA_VERSION:
        return False, [f"Unsupported summary formula '{manifest.get('formula_version')}'."]

    try:
        as_of = date.fromisoformat(str(manifest.get("calculation_as_of", "")))
    except ValueError:
        return False, ["Derivation has an invalid calculation_as_of date."]

    total_months, _ = unioned_career_months(
        list(profile.get("work_experience", []) or []), as_of
    )
    if total_months != manifest.get("total_months"):
        errors.append("Derivation total_months does not match unioned employment intervals.")
    slots = manifest.get("slot_values", {})
    if slots.get("completed_years") != total_months // 12:
        errors.append("Derivation completed_years is inconsistent with unioned months.")

    headline = str(profile.get("headline") or "").strip()
    target_titles = [str(t) for t in (profile.get("target_titles", []) or [])]
    if slots.get("title_family") not in ([headline] + target_titles):
        errors.append("Derivation title_family is outside the canonical allow-list.")

    facts_by_id = {
        f.get("fact_id"): f
        for f in (profile.get("verified_facts", []) or [])
        if isinstance(f, dict) and f.get("verification_status") == "approved"
    }
    manifest_fact_ids = manifest.get("fact_ids", [])
    if not isinstance(manifest_fact_ids, list) or not manifest_fact_ids:
        errors.append("Derivation must cite at least one approved fact_id.")
        manifest_fact_ids = []
    for fid in manifest_fact_ids:
        if fid not in facts_by_id:
            errors.append(f"Derivation cites unknown or unapproved fact_id '{fid}'.")

    # Domains/techs must each appear verbatim in cited fact evidence.
    evidence_texts = [str(facts_by_id[fid].get("text", "")) for fid in manifest_fact_ids if fid in facts_by_id]
    evidence_techs = [str(t) for fid in manifest_fact_ids if fid in facts_by_id
                      for t in (facts_by_id[fid].get("technologies", []) or [])]
    import re as _re
    for raw in _re.split(r",", str(slots.get("domains_techs", ""))):
        term = _re.sub(r"^(and|or)\s+", "", raw.strip())
        if not term:
            continue
        if term not in evidence_texts and term not in evidence_techs and not any(
            term in text for text in evidence_texts
        ):
            errors.append(f"Derivation domain term '{term}' is not verbatim fact evidence.")

    proof_id = manifest.get("proof_fact_id")
    proof_fact = facts_by_id.get(proof_id) if isinstance(proof_id, str) else None
    if proof_fact is None:
        errors.append("Derivation proof_fact_id must reference a cited approved fact.")
    elif slots.get("proof_point") != str(proof_fact.get("text", "")):
        errors.append("Derivation proof_point must be one complete verbatim fact.")

    if errors:
        return False, errors
    rebuilt = build_derived_text(slots)
    if rebuilt != manifest.get("final_text"):
        return False, ["Derivation final_text is not byte-for-byte reconstructable."]
    return True, []
