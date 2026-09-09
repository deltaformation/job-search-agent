#!/usr/bin/env python3
"""Human-operated local approval. Never invoke this script autonomously."""
import argparse
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.memory.repository import JobRepository


def main() -> None:
    parser = argparse.ArgumentParser(description="Review an exact resume version; does not submit applications.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--job-id", help="Job ID to find latest tailored resume version for")
    target.add_argument("--resume-id", help="Explicit resume version ID")
    parser.add_argument("--reviewer", required=False, default=None, help="Name of human reviewer (defaults to candidate name)")
    args = parser.parse_args()

    if not sys.stdin.isatty():
        parser.error("Human review requires an interactive terminal.")

    repo = JobRepository()

    if args.job_id:
        record = repo.get_latest_resume_for_job(args.job_id)
        if not record:
            parser.error(f"No resume versions found for job ID '{args.job_id}'. Run 'job tailor --job-id {args.job_id}' first.")
        resume_id = str(record["id"])
        job = repo.get_job_by_id(args.job_id)
    else:
        resume_id = args.resume_id
        record = repo.get_resume_version(resume_id)
        if not record:
            parser.error(f"Resume version '{resume_id}' not found.")
        job = repo.get_job_by_id(str(record["job_id"]))

    reviewer = args.reviewer
    if not reviewer:
        profile = repo.get_candidate_profile()
        if not profile or not str(profile.get("full_name") or "").strip():
            parser.error("Reviewer is required when the candidate profile has no full name.")
        reviewer = str(profile["full_name"]).strip()

    job_title = job["title"] if job else "Unknown Role"
    company = job["company"] if job else "Unknown Company"

    print("=" * 60)
    print(f"RESUME REVIEW: {company} - {job_title}")
    print("=" * 60)
    print(f"PDF Artifact: {record['pdf_path']}")
    print(f"Version:      v{record['version_number']}")
    print(f"Content Hash: {record['content_hash'][:16]}...")
    print(f"Reviewer:     {reviewer}")
    print("-" * 60)
    print(record["tailored_text"][:500] + "\n[... full text formatted in compiled PDF ...]\n")
    print("-" * 60)

    if record.get("approved_by_human"):
        print(f"✅ This resume version is ALREADY approved by {record.get('human_reviewer') or reviewer}.")
        return

    ans = input("After inspecting the PDF, type APPROVE to approve this version: ").strip()
    if ans != "APPROVE":
        print("❌ Approval cancelled. No changes recorded.")
        return

    ok, message = repo.confirm_human_approval(resume_id, record["content_hash"], reviewer, human_confirmed=True)
    print(f"\n{message}")
    if not ok:
        sys.exit(1)

    # Transition job to READY
    job_id = str(record["job_id"])
    if job:
        curr_status = job.get("status", "NEW")
        if curr_status in ("NEW", "QUALIFIED", "SHORTLISTED"):
            repo.transition_job_workflow(job_id, "REVIEWED", actor=reviewer)
        ready_ok, ready_msg = repo.transition_job_workflow(job_id, "READY", actor=reviewer, human_confirmed=True)
        if ready_ok:
            print(f"🚀 Job '{company}' transitioned to 'READY'. Ready for Application Copilot!\n")
        else:
            print(f"Notice: Workflow state: {ready_msg}\n")


if __name__ == "__main__":
    main()
