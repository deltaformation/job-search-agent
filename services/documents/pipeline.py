"""Shared generation workflow used by MCP and the local CLI."""
import hashlib
import json
from typing import Any, Dict, List, Optional
from services.documents.tailor import ResumeTailor
from services.documents.validator import ClaimValidator
from services.documents.renderer import DocumentRenderer
from services.intelligence.models import CanonicalRequirement
from services.memory.repository import JobRepository


def generate_documents(repo: JobRepository, job_id: str, draft: Optional[Dict[str, Any]] = None,
                       renderer: Optional[DocumentRenderer] = None) -> Dict[str, Any]:
    job_id = str(job_id)
    profile = repo.get_candidate_profile()
    job = repo.get_job_by_id(job_id)
    if not profile or not job:
        raise ValueError("Job or candidate profile not found.")

    raw_jd = (job.get("description") or "").replace("\x00", "").strip()
    if not raw_jd:
        return {
            "status": "blocked",
            "message": "Job description is empty. Cannot generate tailored resume without a valid job description.",
            "blockers": ["EMPTY_JD"]
        }

    # Precondition 1: Analysis must exist
    analysis = repo.get_job_analysis(job_id)
    if not analysis or not analysis.get("id"):
        return {
            "status": "blocked",
            "message": "Resume generation requires a validated analysis bound to current JD and candidate profile snapshots.",
            "blockers": ["ANALYSIS_REQUIRED"]
        }

    # Precondition 2: JD snapshot must exist, be bound to analysis, and match current JD content
    current_jd_hash = hashlib.sha256(raw_jd.encode("utf-8")).hexdigest()
    jd_snapshot = repo.get_jd_snapshot_by_hash(job_id, current_jd_hash)

    if not jd_snapshot:
        current_jd_snapshot_id = repo.save_jd_snapshot(job_id, raw_jd, raw_jd)
    else:
        current_jd_snapshot_id = str(jd_snapshot["id"])

    if not jd_snapshot or str(analysis.get("jd_snapshot_id")) != current_jd_snapshot_id:
        return {
            "status": "blocked",
            "message": "Job description has changed since the current analysis was created. A new analysis is required.",
            "blockers": ["STALE_ANALYSIS_JD", "NEW_ANALYSIS_REQUIRED"],
            "new_jd_snapshot_id": current_jd_snapshot_id
        }

    # Precondition 3: Candidate profile snapshot must exist, be bound to analysis, and match current profile
    cand_snap_id = str(analysis.get("candidate_snapshot_id", ""))
    cand_snap = repo.get_candidate_snapshot(cand_snap_id) if cand_snap_id else None
    if not cand_snap:
        return {
            "status": "blocked",
            "message": "Bound candidate profile snapshot not found.",
            "blockers": ["CANDIDATE_SNAPSHOT_NOT_FOUND"]
        }
    if str(cand_snap.get("candidate_id")) != str(profile.get("id")):
        return {
            "status": "blocked",
            "message": "Bound candidate profile snapshot belongs to a different candidate.",
            "blockers": ["CANDIDATE_SNAPSHOT_MISMATCH"]
        }

    current_profile_hash = hashlib.sha256(
        json.dumps(profile, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    if cand_snap.get("snapshot_hash") != current_profile_hash:
        return {
            "status": "blocked",
            "message": "Candidate profile has changed since analysis was performed. A new analysis is required.",
            "blockers": ["STALE_ANALYSIS_PROFILE", "NEW_ANALYSIS_REQUIRED"]
        }

    # Precondition 4: Every cited fact in the analysis must exist in the bound candidate snapshot and be approved
    snap_profile = cand_snap.get("profile_data")
    if isinstance(snap_profile, str):
        try:
            snap_profile = json.loads(snap_profile)
        except json.JSONDecodeError:
            return {
                "status": "blocked",
                "message": "Bound candidate profile snapshot contains invalid JSON.",
                "blockers": ["INVALID_CANDIDATE_SNAPSHOT"]
            }
    if not isinstance(snap_profile, dict):
        return {
            "status": "blocked",
            "message": "Bound candidate profile snapshot is not a profile object.",
            "blockers": ["INVALID_CANDIDATE_SNAPSHOT"]
        }
    snapshot_facts = snap_profile.get("verified_facts") or []
    if not isinstance(snapshot_facts, list):
        return {
            "status": "blocked",
            "message": "Bound candidate profile snapshot has an invalid verified-facts inventory.",
            "blockers": ["INVALID_CANDIDATE_SNAPSHOT"]
        }
    approved_facts_in_snapshot = {
        fact["fact_id"]: fact for fact in snapshot_facts
        if isinstance(fact, dict)
        and isinstance(fact.get("fact_id"), str)
        and fact.get("verification_status") == "approved"
    }

    raw_requirements = analysis.get("requirements", [])
    if not isinstance(raw_requirements, list):
        return {
            "status": "blocked",
            "message": "Analysis requirements must be a list.",
            "blockers": ["INVALID_REQUIREMENT_ANALYSIS"]
        }
    canonical_requirements: List[Dict[str, Any]] = []
    cited_fact_ids: List[str] = []
    for req in raw_requirements:
        try:
            canon = CanonicalRequirement.model_validate(req)
            canonical_requirements.append(canon.model_dump())
            cited_fact_ids.extend(canon.evidence_fact_ids)
        except Exception as exc:
            return {
                "status": "blocked",
                "message": f"Invalid requirement in analysis: {exc}",
                "blockers": ["INVALID_REQUIREMENT_ANALYSIS"]
            }

    for fid in cited_fact_ids:
        if fid not in approved_facts_in_snapshot:
            return {
                "status": "blocked",
                "message": f"Analysis cites fact '{fid}' which does not exist or is not approved in the candidate snapshot.",
                "blockers": ["UNAPPROVED_OR_UNKNOWN_FACT"]
            }

    requirement_validator = ClaimValidator(snap_profile)
    requirements_valid, requirement_errors = requirement_validator.validate_requirement_analysis(
        canonical_requirements,
        jd_text=jd_snapshot.get("cleaned_text") or jd_snapshot.get("raw_text") or "",
    )
    if not requirements_valid:
        return {
            "status": "blocked",
            "message": "Analysis requirements do not match their bound snapshots.",
            "blockers": ["INVALID_REQUIREMENT_ANALYSIS"],
            "errors": requirement_errors,
        }

    tailor = ResumeTailor(profile)
    server_generated = draft is None
    if server_generated:
        draft = tailor.generate_tailored_draft(
            job, evidence_fact_ids=cited_fact_ids, requirements=canonical_requirements
        )
    if draft.get("job_id") != str(job["job_id"]):
        raise ValueError("Draft job_id does not match the requested job.")

    # M8 lineage inputs. All derived server-side from bound snapshots; an
    # agent-submitted draft can never inject template identity, keyword
    # coverage, variant approval, or summary derivation.
    from datetime import date as _date
    from services.documents.keywords import (
        RANKING_POLICY_VERSION,
        CoverageFirstFactRanker,
        KeywordPlanner,
        evidence_qualified_skills,
    )
    from services.documents.summary import compose_summary
    from services.documents.template_registry import load_resume_config
    resume_config = load_resume_config()
    ranker = CoverageFirstFactRanker(
        max_per_role=int(resume_config.get("max_experience_bullets", 5)),
        max_prior_role=int(resume_config.get("max_prior_role_bullets", 3)),
        max_total=int(resume_config.get("max_total_bullets", 14)),
    )
    ranked_ids = ranker.rank(canonical_requirements, profile)
    skill_terms = evidence_qualified_skills(profile, ranked_ids)
    keyword_plan = KeywordPlanner().plan(
        canonical_requirements, ranked_ids, profile, skill_terms
    )

    as_of_raw = str(analysis.get("created_at", "") or "")[:10]
    try:
        calculation_as_of = _date.fromisoformat(as_of_raw)
    except ValueError:
        jd_as_of = str((jd_snapshot.get("created_at", "") or ""))[:10]
        try:
            calculation_as_of = _date.fromisoformat(jd_as_of)
        except ValueError:
            calculation_as_of = _date.today()

    summary_derivation: Dict[str, Any] = {}
    summary_strategy = "agent_submitted"
    if server_generated:
        summary_result = compose_summary(
            profile, ranked_ids, str(job.get("title") or ""), calculation_as_of
        )
        summary_strategy = summary_result.strategy
        if summary_result.strategy == "derived_template":
            summary_derivation = summary_result.derivation or {}
        else:
            summary_derivation = {
                "strategy": summary_result.strategy,
                "fallback_reason": summary_result.fallback_reason,
                "formula_version": "summary/v1",
                "calculation_as_of": calculation_as_of.isoformat(),
            }
        # Replace the heuristic summary claim with the constrained composition.
        kept = [c for c in draft.get("claims", []) if c.get("section") != "summary"]
        if summary_result.strategy != "none":
            summary_claim: Dict[str, Any] = {
                "claim_id": "claim_000",
                "section": "summary",
                "text": summary_result.text,
                "fact_ids": summary_result.fact_ids,
                "generation_strategy": (
                    "derived_template" if summary_result.strategy == "derived_template"
                    else "verbatim"
                ),
            }
            if summary_result.derivation:
                summary_claim["derivation"] = summary_result.derivation
            kept.insert(0, summary_claim)
        for index, claim in enumerate(kept, start=1):
            claim["claim_id"] = f"claim_{index:03d}"
        draft["claims"] = kept
    else:
        existing_summary = next(
            (c for c in draft.get("claims", []) if c.get("section") == "summary"), None
        )
        if isinstance(existing_summary, dict) and isinstance(existing_summary.get("derivation"), dict):
            summary_derivation = existing_summary["derivation"]
            summary_strategy = str(existing_summary.get("generation_strategy", "agent_submitted"))

    try:
        approved_variants = repo.get_approved_variants(str(profile.get("id")))
    except Exception:
        approved_variants = []
    valid, report = ClaimValidator(profile, variants=approved_variants).validate_draft(draft)
    if not valid:
        return {"status": "validation_failed", "report": report}

    plain = tailor.generate_plain_text(draft)
    digest = tailor.compute_content_hash(plain)
    # Template-aware baseline: canonical untailored content through the same
    # view model and template, so diffs measure tailoring, not layout churn.
    from services.documents.view_model import (
        build_canonical_baseline_draft,
        build_view_model,
        render_plain_text,
    )
    baseline_vm = build_view_model(
        profile,
        build_canonical_baseline_draft(profile),
        max_detailed_roles=int(resume_config.get("max_detailed_roles", 3)),
    )
    baseline = render_plain_text(baseline_vm)

    renderer = renderer or DocumentRenderer()
    template_info = renderer.template_info()
    record = repo.save_resume_version({
        "job_id": job_id, "content_hash": digest, "tailored_text": plain,
        "structured_content": draft, "claim_evidence_map": draft["claims"],
        "fact_ids_used": report["verified_facts_referenced"],
        "diff_summary": tailor.compute_diff(baseline, plain),
        "validation_status": "VALIDATED", "validation_report": report,
        "profile_snapshot_id": cand_snap_id, "jd_snapshot_id": str(jd_snapshot["id"]),
        "analysis_id": str(analysis["id"]),
        "baseline_text": baseline, "requirements_snapshot": canonical_requirements,
        "template_id": template_info["template_id"],
        "template_version": template_info["template_version"],
        "template_hash": template_info["template_hash"],
        "render_schema_version": template_info["render_schema_version"],
        "ranking_policy_version": RANKING_POLICY_VERSION,
        "keyword_plan": keyword_plan,
        "keyword_coverage_report": keyword_plan["coverage_report"],
        "summary_derivation": summary_derivation,
    })
    resume_id = str(record["id"])
    try:
        html = renderer.render_resume_to_html(profile, draft, variants=approved_variants)
        html_path, pdf_path, pages = renderer.compile_html_to_pdf(html, job_id, record["version_number"], digest)
        updated = repo.update_resume_validation(resume_id, "AWAITING_HUMAN_REVIEW", report, html_path, pdf_path)
        if not updated:
            raise ValueError("Resume state changed during rendering.")
        return {"status": "success", "resume_version_id": resume_id, "version_number": record["version_number"],
                "content_hash": digest, "html_path": html_path, "pdf_path": pdf_path, "page_count": pages,
                "validation_status": "AWAITING_HUMAN_REVIEW", "diff_summary": record["diff_summary"],
                "template": template_info,
                "ranking_policy_version": RANKING_POLICY_VERSION,
                "summary_strategy": summary_strategy,
                "keyword_coverage": keyword_plan["coverage_report"],
                "omitted_unsupported": keyword_plan["omitted_unsupported"]}
    except Exception as exc:
        repo.update_resume_validation(resume_id, "FAILED", {"is_valid": False, "error": str(exc)})
        return {"status": "error", "resume_version_id": resume_id, "message": str(exc)}
