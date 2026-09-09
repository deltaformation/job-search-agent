#!/usr/bin/env python3
"""
CLI entrypoint to tailor, validate, and render an ATS-friendly resume for a job ID.
"""
import sys
import argparse
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository
from services.documents.validator import ClaimValidator
from services.documents.tailor import ResumeTailor
from services.documents.renderer import DocumentRenderer

def tailor_job(job_id: str, reviewer: str = "human"):
    repo = JobRepository()
    profile = repo.get_candidate_profile()
    if not profile:
        print("Error: Candidate profile not found.")
        sys.exit(1)

    job = repo.get_job_by_id(job_id)
    if not job:
        print(f"Error: Job '{job_id}' not found.")
        sys.exit(1)

    print(f"\n--- TAILORING RESUME FOR: {job['title']} @ {job['company']} ---")
    print(f"Job ID: {job_id}")
    print(f"Freshness: {job.get('freshness_bucket', 'N/A')} | Fit Score: {job.get('overall_score', 'N/A')}")

    # 1. Snapshot JD and Profile
    repo.save_candidate_snapshot(str(profile["id"]), profile)
    cleaned_desc = (job.get("description") or "").replace("\x00", "").strip()
    repo.save_jd_snapshot(job_id, job.get("description") or "", cleaned_desc)

    # 2. Synthesize Tailored Draft (Option A: Verbatim Facts)
    tailor = ResumeTailor(profile)
    draft = tailor.generate_tailored_draft(job)

    # 3. Validate Claims Deterministically
    validator = ClaimValidator(profile)
    is_valid, report = validator.validate_draft(draft)
    print(f"\nValidation Result: {'PASSED' if is_valid else 'FAILED'}")
    print(f"Validated Claims: {report['validated_claims']}/{report['total_claims']}")
    print(f"Referenced Facts: {', '.join(report['verified_facts_referenced'])}")

    if not is_valid:
        print("\nErrors encountered during validation:")
        for err in report["errors"]:
            print(f"  ❌ {err}")
        sys.exit(1)

    # 4. Generate Plain Text and Content Hash
    plain_text = tailor.generate_plain_text(draft)
    content_hash = tailor.compute_content_hash(plain_text)

    # 5. Compute Diff Against Baseline
    # Build baseline canonical resume text
    base_draft = tailor.generate_tailored_draft({"job_id": job_id, "title": "Senior Technical Product Manager", "company": "General"})
    base_text = tailor.generate_plain_text(base_draft)
    diff = tailor.compute_diff(base_text, plain_text)

    # 6. Render HTML and Compile PDF
    renderer = DocumentRenderer()
    html_content = renderer.render_resume_to_html(profile, draft)
    
    # Save initial version record
    resume_record = repo.save_resume_version({
        "job_id": job_id,
        "base_version": "canonical_v1",
        "content_hash": content_hash,
        "tailored_text": plain_text,
        "structured_content": draft,
        "claim_evidence_map": draft.get("claims", []),
        "fact_ids_used": report["verified_facts_referenced"],
        "diff_summary": diff,
        "validation_status": "VALIDATED",
        "validation_report": report
    })
    resume_id = str(resume_record["id"])
    ver_num = resume_record["version_number"]

    # Compile PDF
    try:
        html_path, pdf_path, page_count = renderer.compile_html_to_pdf(
            html_content=html_content,
            job_id=job_id,
            version_number=ver_num,
            content_hash=content_hash
        )
        # Update record to AWAITING_HUMAN_REVIEW
        repo.update_resume_validation(
            resume_id=resume_id,
            status="AWAITING_HUMAN_REVIEW",
            report=report,
            html_path=html_path,
            pdf_path=pdf_path
        )
        print(f"\n✅ Artifacts Generated Successfully:")
        print(f"   HTML: {html_path}")
        print(f"   PDF:  {pdf_path} ({page_count} page(s))")
        print(f"   Version ID: {resume_id} (Version {ver_num})")
        print(f"   Content Hash: {content_hash}")
        print(f"   Status: AWAITING_HUMAN_REVIEW")

        if diff:
            print("\n--- DIFF SUMMARY (Baseline vs. Tailored) ---")
            print(diff[:1500])

        return resume_id, content_hash, pdf_path

    except Exception as e:
        repo.update_resume_validation(
            resume_id=resume_id,
            status="FAILED",
            report={"error": str(e)}
        )
        print(f"❌ Failed to render PDF: {e}")
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Tailor resume for a job.")
    parser.add_argument("--job-id", required=True, help="Job UUID to tailor for")
    parser.add_argument("--reviewer", default="human", help="Reviewer identifier")
    args = parser.parse_args()

    tailor_job(args.job_id, args.reviewer)

if __name__ == "__main__":
    main()
