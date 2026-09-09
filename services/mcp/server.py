import os
import sys
import json
from pathlib import Path
from typing import Optional, List, Dict, Any

# Ensure project root is in path
BASE_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

from mcp.server.mcpserver import MCPServer
from services.memory.repository import JobRepository
from services.intelligence.scorer import FitScorer
from services.discovery.scraper import fetch_jobs_from_boards
from services.documents.validator import ClaimValidator
from services.documents.tailor import ResumeTailor
from services.documents.renderer import DocumentRenderer

mcp = MCPServer("career-memory")
repo = JobRepository()
scorer = FitScorer()

@mcp.tool()
def get_candidate_profile() -> str:
    """
    Retrieve the canonical candidate profile, including verified career facts (fact_ids),
    work experience, verified skills, and preferences.
    """
    profile = repo.get_candidate_profile()
    if not profile:
        return json.dumps({"error": "No candidate profile configured."})
    return json.dumps(profile, indent=2, default=str)

@mcp.tool()
def get_jobs_feed(
    freshness: Optional[str] = None,
    min_score: Optional[float] = None,
    status: Optional[str] = None,
    max_age_hours: Optional[float] = None,
    limit: int = 20
) -> str:
    """
    Query the jobs pipeline with filters.
    
    Args:
        freshness: Filter by freshness bucket ('HOT', 'FRESH', 'RECENT', 'STALE').
        min_score: Minimum overall fit score (0-100).
        status: Job status ('NEW', 'QUALIFIED', 'REVIEW', 'TAILORING', 'READY', 'WAITING_FOR_HUMAN', 'SUBMITTED', 'SKIPPED').
        max_age_hours: Maximum posting age in hours (e.g., 24 for last 24h).
        limit: Maximum number of jobs to return.
    """
    jobs = repo.get_jobs(
        freshness=freshness,
        min_score=min_score,
        status=status,
        max_age_hours=max_age_hours,
        limit=limit
    )
    # Return concise summary for LLM context efficiency
    summary = []
    for j in jobs:
        summary.append({
            "job_id": str(j["job_id"]),
            "title": j["title"],
            "company": j["company"],
            "location": j["location"],
            "remote_type": j["remote_type"],
            "freshness": j["freshness_bucket"],
            "age_hours": j["age_hours"],
            "overall_score": float(j["overall_score"]) if j.get("overall_score") is not None else None,
            "recommendation": j.get("recommendation"),
            "status": j["status"],
            "apply_url": j.get("apply_url") or j.get("canonical_url")
        })
    return json.dumps({"count": len(summary), "jobs": summary}, indent=2, default=str)

@mcp.tool()
def get_job_details(job_id: str) -> str:
    """
    Retrieve full details for a job including complete description, ATS detection,
    provenance sources, score breakdown, strengths, gaps, and evidence facts.
    """
    job = repo.get_job_by_id(job_id)
    if not job:
        return json.dumps({"error": f"Job {job_id} not found."})
    return json.dumps(job, indent=2, default=str)

@mcp.tool()
def score_job_fit(job_id: str) -> str:
    """
    Evaluates or re-scores a job against the canonical candidate profile and verified facts.
    """
    job = repo.get_job_by_id(job_id)
    if not job:
        return json.dumps({"error": f"Job {job_id} not found."})
    profile = repo.get_candidate_profile()
    if not profile:
        return json.dumps({"error": "No candidate profile found."})
    
    score_result = scorer.score_job(job, profile)
    saved = repo.save_job_score(job_id, score_result)
    return json.dumps(saved, indent=2, default=str)

@mcp.tool()
def update_job_status(job_id: str, new_status: str, notes: Optional[str] = None) -> str:
    """
    Update a job's status in the application pipeline.
    
    Allowed statuses:
      NEW, QUALIFIED, REVIEW, TAILORING, READY, APPLICATION_STARTED,
      WAITING_FOR_HUMAN, SUBMITTED, SCREEN, INTERVIEW, FINAL, OFFER,
      SKIPPED, REJECTED, WITHDRAWN, EXPIRED
    """
    success = repo.update_job_status(job_id, new_status, {"notes": notes})
    if success:
        return json.dumps({"status": "success", "job_id": job_id, "new_status": new_status})
    return json.dumps({"status": "error", "message": f"Job {job_id} not found."})

@mcp.tool()
def search_and_ingest_jobs(
    role: str = "Senior Product Manager",
    location: str = "Toronto, ON",
    country: str = "Canada",
    hours_old: int = 72,
    results_wanted: int = 10
) -> str:
    """
    Execute live multi-board job search, normalize, deduplicate, tag freshness,
    compute candidate fit scores, and persist to database.
    """
    profile = repo.get_candidate_profile()

    pairs = fetch_jobs_from_boards(
        search_term=role,
        location=location,
        country=country,
        hours_old=hours_old,
        results_wanted=results_wanted
    )

    ingested = 0
    duplicates = 0
    qualified = 0

    for job_data, source_data in pairs:
        saved_job, is_new = repo.upsert_job(job_data, source_data)

        if is_new:
            ingested += 1
            if profile:
                score = scorer.score_job(saved_job, profile)
                repo.save_job_score(saved_job["job_id"], score)
                if score["overall_score"] >= 85:
                    qualified += 1
        else:
            duplicates += 1

    return json.dumps({
        "status": "success",
        "search_term": role,
        "location": location,
        "total_scraped": len(pairs),
        "new_ingested": ingested,
        "duplicates_merged": duplicates,
        "qualified_found": qualified
    }, indent=2)

@mcp.tool()
def get_agent_runs(limit: int = 5) -> str:
    """
    Get audit history of recent agent runs, scan durations, and ingestion metrics.
    """
    runs = repo.get_agent_runs(limit=limit)
    return json.dumps(runs, indent=2, default=str)

@mcp.tool()
def get_tailoring_context(job_id: str) -> str:
    """
    Retrieve candidate profile, verified facts inventory, and quarantined JD description
    for safe resume tailoring without risk of prompt injection.
    """
    job = repo.get_job_by_id(job_id)
    if not job:
        return json.dumps({"error": f"Job '{job_id}' not found."})
    profile = repo.get_candidate_profile()
    if not profile:
        return json.dumps({"error": "Candidate profile not found."})

    tailor = ResumeTailor(profile)
    context = tailor.create_tailoring_context(job)
    return json.dumps(context, indent=2, default=str)

@mcp.tool()
def submit_requirement_analysis(job_id: str, requirements: List[Dict[str, Any]]) -> str:
    """
    Validate and persist structured JD requirement breakdown before tailoring.
    Enforces that requirements marked 'matched' must cite verified fact IDs.
    """
    profile = repo.get_candidate_profile()
    if not profile:
        return json.dumps({"error": "Candidate profile not found."})

    validator = ClaimValidator(profile)
    is_valid, errors = validator.validate_requirement_analysis(requirements)
    if not is_valid:
        return json.dumps({"status": "error", "message": "Requirement analysis validation failed", "errors": errors}, indent=2)

    saved = repo.save_job_requirements(job_id, requirements)
    return json.dumps({"status": "success", "job_id": job_id, "saved_requirements_count": len(saved)}, indent=2, default=str)

@mcp.tool()
def submit_resume_draft(job_id: str, structured_resume: Dict[str, Any]) -> str:
    """
    Deterministically validate a structured resume draft against verified facts,
    generate plain text, compute content hash and diff against baseline,
    render ATS-friendly HTML and compile PDF (<= 2 pages).
    Sets status to 'AWAITING_HUMAN_REVIEW'.
    """
    profile = repo.get_candidate_profile()
    job = repo.get_job_by_id(job_id)
    if not profile or not job:
        return json.dumps({"error": f"Job '{job_id}' or profile not found."})

    # 1. Deterministic Claim Validation
    validator = ClaimValidator(profile)
    is_valid, report = validator.validate_draft(structured_resume)
    if not is_valid:
        return json.dumps({
            "status": "validation_failed",
            "message": "Draft contains unsupported claims, metric tampering, or unverified technologies.",
            "report": report
        }, indent=2)

    # 2. Plain Text & Content Hash
    tailor = ResumeTailor(profile)
    plain_text = tailor.generate_plain_text(structured_resume)
    content_hash = tailor.compute_content_hash(plain_text)

    # 3. Compute Diff Against Baseline
    base_draft = tailor.generate_tailored_draft({"job_id": job_id, "title": "Senior Technical Product Manager", "company": "General"})
    base_text = tailor.generate_plain_text(base_draft)
    diff = tailor.compute_diff(base_text, plain_text)

    # 4. Save Version Record
    resume_record = repo.save_resume_version({
        "job_id": job_id,
        "base_version": "canonical_v1",
        "content_hash": content_hash,
        "tailored_text": plain_text,
        "structured_content": structured_resume,
        "claim_evidence_map": structured_resume.get("claims", []),
        "fact_ids_used": report["verified_facts_referenced"],
        "diff_summary": diff,
        "validation_status": "VALIDATED",
        "validation_report": report
    })
    resume_id = str(resume_record["id"])
    ver_num = resume_record["version_number"]

    # 5. Render HTML & Compile PDF
    renderer = DocumentRenderer()
    html_content = renderer.render_resume_to_html(profile, structured_resume)
    try:
        html_path, pdf_path, page_count = renderer.compile_html_to_pdf(
            html_content=html_content,
            job_id=job_id,
            version_number=ver_num,
            content_hash=content_hash
        )
        repo.update_resume_validation(
            resume_id=resume_id,
            status="AWAITING_HUMAN_REVIEW",
            report=report,
            html_path=html_path,
            pdf_path=pdf_path
        )
        return json.dumps({
            "status": "success",
            "resume_version_id": resume_id,
            "version_number": ver_num,
            "content_hash": content_hash,
            "page_count": page_count,
            "html_path": html_path,
            "pdf_path": pdf_path,
            "validation_status": "AWAITING_HUMAN_REVIEW",
            "diff_summary": diff[:2000]
        }, indent=2, default=str)

    except Exception as e:
        repo.update_resume_validation(resume_id=resume_id, status="FAILED", report={"error": str(e)})
        return json.dumps({"status": "error", "message": f"Compilation failed: {str(e)}"}, indent=2)

@mcp.tool()
def get_tailoring_audit(job_id: str, version_number: Optional[int] = None) -> str:
    """
    Retrieve full audit of the tailored resume for a job including validation report,
    diff against baseline, referenced fact IDs, and file paths.
    """
    latest = repo.get_latest_resume_for_job(job_id)
    if not latest:
        return json.dumps({"error": f"No resume versions found for job '{job_id}'."})
    return json.dumps(latest, indent=2, default=str)

@mcp.tool()
def confirm_human_approval(resume_version_id: str, expected_content_hash: str, reviewer: str = "human") -> str:
    """
    Record explicit human approval for a resume version.
    Fails if the expected content hash does not match the database record.
    """
    success, message = repo.confirm_human_approval(resume_version_id, expected_content_hash, reviewer)
    if success:
        return json.dumps({
            "status": "approved",
            "resume_version_id": resume_version_id,
            "approval_signature": message,
            "message": "Human approval recorded successfully. Version is now locked and approved."
        }, indent=2)
    return json.dumps({"status": "error", "message": message}, indent=2)

if __name__ == "__main__":
    mcp.run(transport="stdio")
