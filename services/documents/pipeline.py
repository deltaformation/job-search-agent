"""Shared generation workflow used by MCP and the local CLI."""
from typing import Any, Dict, Optional
from services.documents.tailor import ResumeTailor
from services.documents.validator import ClaimValidator
from services.documents.renderer import DocumentRenderer
from services.memory.repository import JobRepository


def generate_documents(repo: JobRepository, job_id: str, draft: Optional[Dict[str, Any]] = None,
                       renderer: Optional[DocumentRenderer] = None) -> Dict[str, Any]:
    job_id = str(job_id)
    profile = repo.get_candidate_profile()
    job = repo.get_job_by_id(job_id)
    if not profile or not job:
        raise ValueError("Job or candidate profile not found.")
    tailor = ResumeTailor(profile)
    analysis = repo.get_job_analysis(job_id)
    requirements = (
        analysis.get("requirements", [])
        if analysis
        else repo.get_job_requirements(job_id)
    )
    if draft is None:
        matched = [fid for r in requirements for fid in r.get("matched_fact_ids", [])]
        draft = tailor.generate_tailored_draft(job, matched_fact_ids=matched)
    if draft.get("job_id") != str(job["job_id"]):
        raise ValueError("Draft job_id does not match the requested job.")
    valid, report = ClaimValidator(profile).validate_draft(draft)
    if not valid:
        return {"status": "validation_failed", "report": report}
    plain = tailor.generate_plain_text(draft)
    digest = tailor.compute_content_hash(plain)
    baseline = tailor.generate_plain_text(tailor.generate_tailored_draft({"job_id": job_id}))
    profile_id = repo.save_candidate_snapshot(str(profile["id"]), profile)
    raw = job.get("description") or ""
    jd_id = repo.save_jd_snapshot(job_id, raw, raw.replace("\x00", "").strip())
    record = repo.save_resume_version({
        "job_id": job_id, "content_hash": digest, "tailored_text": plain,
        "structured_content": draft, "claim_evidence_map": draft["claims"],
        "fact_ids_used": report["verified_facts_referenced"],
        "diff_summary": tailor.compute_diff(baseline, plain),
        "validation_status": "VALIDATED", "validation_report": report,
        "profile_snapshot_id": profile_id, "jd_snapshot_id": jd_id,
        "analysis_id": str(analysis["id"]) if analysis else None,
        "baseline_text": baseline, "requirements_snapshot": requirements,
    })
    resume_id = str(record["id"])
    try:
        renderer = renderer or DocumentRenderer()
        html = renderer.render_resume_to_html(profile, draft)
        html_path, pdf_path, pages = renderer.compile_html_to_pdf(html, job_id, record["version_number"], digest)
        updated = repo.update_resume_validation(resume_id, "AWAITING_HUMAN_REVIEW", report, html_path, pdf_path)
        if not updated:
            raise ValueError("Resume state changed during rendering.")
        return {"status": "success", "resume_version_id": resume_id, "version_number": record["version_number"],
                "content_hash": digest, "html_path": html_path, "pdf_path": pdf_path, "page_count": pages,
                "validation_status": "AWAITING_HUMAN_REVIEW", "diff_summary": record["diff_summary"]}
    except Exception as exc:
        repo.update_resume_validation(resume_id, "FAILED", {"is_valid": False, "error": str(exc)})
        return {"status": "error", "resume_version_id": resume_id, "message": str(exc)}
