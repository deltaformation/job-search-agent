"""Deterministic resume view model shared by HTML and plain-text projections.

Layout decisions live here and in the trusted template. ``ResumeTailor``
chooses content; this module shapes validated content for presentation; the
renderer only renders. Both projections consume the same model so section
order, dates, contacts, and claims cannot drift.
"""
from datetime import date
from typing import Any, Dict, List, Optional

from services.documents.keywords import evidence_qualified_skills

# Professional/earlier split: most recent experiences (current first, then by
# end/start date descending) fill `professional_experience` up to
# `max_detailed_roles`; the remainder form `earlier_career`. Never by company
# name. The rule is documented here so audits can reproduce it.
DEFAULT_MAX_DETAILED_ROLES = 3

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def format_month_year(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) >= 7 and text[4] == "-" and text[:4].isdigit():
        try:
            year = int(text[:4])
            month = int(text[5:7])
            if 1 <= month <= 12:
                return f"{_MONTHS[month - 1]} {year}"
        except ValueError:
            pass
    return text


def format_date_range(exp: Dict[str, Any]) -> str:
    start = format_month_year(exp.get("start_date"))
    end_raw = exp.get("end_date")
    if end_raw:
        end = format_month_year(end_raw)
    elif exp.get("is_current"):
        end = "Present"
    else:
        end = ""
    if start and end:
        return f"{start} - {end}"
    return start or end


def _sort_key(exp: Dict[str, Any]) -> tuple:
    current = 1 if exp.get("is_current") else 0
    return (current, str(exp.get("end_date") or ""), str(exp.get("start_date") or ""))


def format_linkedin_display(url: str) -> str:
    text = url.strip()
    for prefix in ("https://", "http://"):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
    return text.rstrip("/")


def build_contact_parts(profile: Dict[str, Any]) -> List[Dict[str, str]]:
    """Build contact parts in canonical order, omitting missing fields cleanly."""
    parts: List[Dict[str, str]] = []
    location = str(profile.get("location") or "").strip()
    if location:
        parts.append({"text": location})
    phone = str(profile.get("phone") or "").strip()
    if phone:
        parts.append({"text": phone, "href": f"tel:{phone}"})
    email = str(profile.get("email") or "").strip()
    if email:
        parts.append({"text": email, "href": f"mailto:{email}"})
    prefs = profile.get("preferences") or {}
    linkedin = str(prefs.get("linkedin_url") or "").strip()
    if linkedin:
        parts.append({"text": format_linkedin_display(linkedin), "href": linkedin})
    return parts


def build_view_model(
    profile: Dict[str, Any],
    structured_resume: Dict[str, Any],
    max_detailed_roles: int = DEFAULT_MAX_DETAILED_ROLES,
) -> Dict[str, Any]:
    """Map snapshot-backed profile fields and validated claims into sections."""
    claims = structured_resume.get("claims", []) if isinstance(structured_resume, dict) else []
    summary_claims = [c for c in claims if isinstance(c, dict) and c.get("section") == "summary"]
    exp_claims = [c for c in claims if isinstance(c, dict) and c.get("section") == "experience"]

    summary_copy = summary_claims[0].get("text", "") if summary_claims else ""

    experiences = list(profile.get("work_experience", []) or [])
    experiences.sort(key=_sort_key, reverse=True)
    by_id = {str(e.get("id")): e for e in experiences}

    bullets_by_exp: Dict[str, List[str]] = {}
    for ec in exp_claims:
        eid = str(ec.get("entity_id", ""))
        text = str(ec.get("text", ""))
        if eid and text:
            bullets_by_exp.setdefault(eid, []).append(text)

    def job_entry(exp: Dict[str, Any]) -> Dict[str, Any]:
        eid = str(exp.get("id"))
        return {
            "company": exp.get("company", ""),
            "role": exp.get("role", ""),
            "location": exp.get("location", "") or "",
            "dates": format_date_range(exp),
            "bullets": bullets_by_exp.get(eid, []),
        }

    professional_experience = [job_entry(e) for e in experiences[:max_detailed_roles]]
    earlier_career = [job_entry(e) for e in experiences[max_detailed_roles:]]
    # Never render empty job headers: drop entries with no bullets.
    professional_experience = [j for j in professional_experience if j["bullets"]]
    earlier_career = [j for j in earlier_career if j["bullets"]]

    # Skills rows are evidence-qualified: a verified skill renders only when its
    # exact term appears in the text/technology metadata of a cited fact.
    # (Direct skill-to-fact_id linkage does not exist; this is the enforced
    # substitute per the M8 clarification.)
    cited_fact_ids = [
        fid for c in claims
        for fid in (c.get("fact_ids", []) or [])
        if isinstance(fid, str)
    ]
    qualified_skills = evidence_qualified_skills(profile, cited_fact_ids)
    skill_rows = [{"label": "Core Competencies", "terms": qualified_skills}] if qualified_skills else []

    education_rows = []
    for edu in (profile.get("education", []) or []):
        if not isinstance(edu, dict):
            continue
        degree = str(edu.get("degree", "") or "")
        field = str(edu.get("field_of_study", "") or "")
        institution = str(edu.get("institution", "") or "")
        detail = f"{degree} in {field}" if degree and field else (degree or field)
        if institution and detail:
            detail = f"{detail}, {institution}"
        elif institution:
            detail = institution
        dates = str(edu.get("graduation_date", "") or edu.get("end_date", "") or "")
        education_rows.append({"school": institution, "detail": detail, "dates": dates})

    return {
        "header": {
            "full_name": profile.get("full_name", "Candidate"),
            "contact_parts": build_contact_parts(profile),
        },
        "summary_copy": summary_copy,
        "professional_experience": professional_experience,
        "earlier_career": earlier_career,
        "skill_rows": skill_rows,
        "education_rows": education_rows,
    }


def render_plain_text(view_model: Dict[str, Any]) -> str:
    """Plain-text projection of the canonical view model (same order as HTML)."""
    lines: List[str] = []
    header = view_model.get("header", {})
    lines.append(str(header.get("full_name", "Candidate")).upper())
    parts = [p.get("text", "") for p in header.get("contact_parts", []) if p.get("text")]
    lines.append(" | ".join(parts))
    lines.append("-" * 60)

    if view_model.get("summary_copy"):
        lines.append("SUMMARY")
        lines.append(str(view_model["summary_copy"]))
        lines.append("")

    if view_model.get("professional_experience"):
        lines.append("PROFESSIONAL EXPERIENCE")
        for job in view_model["professional_experience"]:
            lines.append(f"{job['company']} | {job['dates']}")
            lines.append(f"{job['role']} | {job.get('location', '')}")
            for bullet in job["bullets"]:
                lines.append(f"  - {bullet}")
            lines.append("")

    if view_model.get("earlier_career"):
        lines.append("EARLIER CAREER")
        for job in view_model["earlier_career"]:
            lines.append(f"{job['company']} | {job['dates']}")
            lines.append(f"{job['role']} | {job.get('location', '')}")
            for bullet in job["bullets"]:
                lines.append(f"  - {bullet}")
            lines.append("")

    if view_model.get("skill_rows"):
        lines.append("SKILLS")
        for row in view_model["skill_rows"]:
            lines.append(f"{row['label']}: {', '.join(row['terms'])}")
        lines.append("")

    if view_model.get("education_rows"):
        lines.append("EDUCATION")
        for edu in view_model["education_rows"]:
            line = edu["detail"]
            if edu.get("dates"):
                line = f"{line} ({edu['dates']})"
            lines.append(line)
        lines.append("")

    return "\n".join(lines)


def build_canonical_baseline_draft(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Template-aware baseline: canonical untailored content, not an empty fake job.

    Uses the profile headline as the summary line (canonical identity, not a
    fact claim) and every approved fact as a verbatim experience claim in
    chronological order. Rendered through the same view model and template,
    so diffs measure tailoring rather than layout churn.
    """
    facts = [f for f in (profile.get("verified_facts", []) or [])
             if isinstance(f, dict) and f.get("verification_status") == "approved"]
    experiences = list(profile.get("work_experience", []) or [])
    experiences.sort(key=lambda e: str(e.get("start_date") or ""))
    order = {str(e.get("id")): i for i, e in enumerate(experiences)}
    facts.sort(key=lambda f: (order.get(str(f.get("work_experience_id")) or "", 0), str(f.get("fact_id"))))

    exp_by_id = {str(e.get("id")): e for e in experiences}
    claims: List[Dict[str, Any]] = []
    counter = 1
    headline = str(profile.get("headline") or "").strip()
    if headline:
        claims.append({
            "claim_id": f"claim_{counter:03d}",
            "section": "summary",
            "text": headline,
            "fact_ids": [],
            "generation_strategy": "headline",
        })
        counter += 1
    for fact in facts:
        exp = exp_by_id.get(str(fact.get("work_experience_id")) or "")
        if not exp:
            continue
        claims.append({
            "claim_id": f"claim_{counter:03d}",
            "section": "experience",
            "entity_id": str(exp.get("id")),
            "company": exp.get("company"),
            "role": exp.get("role"),
            "dates": {
                "start": str(exp.get("start_date")),
                "end": str(exp.get("end_date")) if exp.get("end_date") else ("Present" if exp.get("is_current") else ""),
            },
            "text": fact.get("text"),
            "fact_ids": [fact.get("fact_id")],
            "claimed_technologies": fact.get("technologies", []),
            "claimed_metrics": fact.get("metrics", []),
            "generation_strategy": "verbatim",
        })
        counter += 1
    for edu in (profile.get("education", []) or []):
        if not isinstance(edu, dict):
            continue
        claims.append({
            "claim_id": f"claim_{counter:03d}",
            "section": "education",
            "degree": edu.get("degree"),
            "institution": edu.get("institution"),
            "field_of_study": edu.get("field_of_study"),
            "text": f"{edu.get('degree')} in {edu.get('field_of_study')}, {edu.get('institution')}",
            "fact_ids": [],
            "claimed_technologies": [],
            "claimed_metrics": [],
            "generation_strategy": "verbatim",
        })
        counter += 1
    return {"job_id": "canonical-baseline", "target_role": None, "target_company": None, "claims": claims}
