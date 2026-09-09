#!/usr/bin/env python3
"""Human-operated local approval. Never invoke this script autonomously."""

import argparse
import sys
from pathlib import Path
from typing import List, Optional, Tuple
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.memory.repository import JobRepository


def valid_uuid(value: str) -> str:
    """Return a canonical UUID string or raise an argparse validation error."""
    try:
        return str(UUID(value))
    except (ValueError, AttributeError) as exc:
        raise argparse.ArgumentTypeError("must be a valid UUID") from exc


def advance_job_to_ready(
    repo: JobRepository,
    job_id: str,
    current_status: str,
    reviewer: str,
) -> Tuple[bool, bool, str]:
    """Advance eligible pre-application jobs after resume approval.

    Returns ``(ok, is_ready, message)``. Terminal and application-in-progress
    states are deliberately left unchanged so an approval cannot reopen or
    rewind a job.
    """
    status = current_status.strip().upper()
    if not status:
        return False, False, "Resume approved, but the job has no workflow status."
    if status in {"NEW", "QUALIFIED", "SHORTLISTED"}:
        reviewed_ok, reviewed_message = repo.transition_job_workflow(
            job_id,
            "REVIEWED",
            actor=reviewer,
            reason="Resume approved through the interactive review command",
        )
        if not reviewed_ok:
            return False, False, f"Resume approved, but the job could not enter REVIEWED: {reviewed_message}"
        status = "REVIEWED"

    if status in {"REVIEW", "REVIEWED", "TAILORING"}:
        ready_ok, ready_message = repo.transition_job_workflow(
            job_id,
            "READY",
            actor=reviewer,
            reason="Latest resume version received explicit human approval",
        )
        if not ready_ok:
            return False, False, f"Resume approved, but the job could not enter READY: {ready_message}"
        return True, True, ready_message

    if status == "READY":
        return True, True, "Job is already in READY."

    return (
        True,
        False,
        f"Resume approved. Job remains in '{status}' because that state must not be rewound automatically.",
    )


def main(argv: Optional[List[str]] = None) -> int:
    """Review and approve one exact resume artifact in an interactive terminal."""
    parser = argparse.ArgumentParser(
        description="Review an exact resume version; does not submit applications."
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument(
        "--job-id",
        type=valid_uuid,
        help="Job ID to find latest tailored resume version for",
    )
    target.add_argument("--resume-id", type=valid_uuid, help="Explicit resume version ID")
    parser.add_argument(
        "--reviewer",
        default=None,
        help="Name of human reviewer (defaults to candidate name)",
    )
    args = parser.parse_args(argv)

    if not sys.stdin.isatty():
        parser.error("Human review requires an interactive terminal.")

    repo = JobRepository()

    if args.job_id:
        record = repo.get_latest_resume_for_job(args.job_id)
        if not record:
            parser.error(
                f"No resume versions found for job ID '{args.job_id}'. "
                f"Run 'job tailor --job-id {args.job_id}' first."
            )
        resume_id = str(record["id"])
        job = repo.get_job_by_id(args.job_id)
    else:
        resume_id = args.resume_id
        record = repo.get_resume_version(resume_id)
        if not record:
            parser.error(f"Resume version '{resume_id}' not found.")
        job = repo.get_job_by_id(str(record["job_id"]))

    supplied_reviewer = str(args.reviewer or "").strip()
    if record.get("approved_by_human"):
        reviewer = str(record.get("human_reviewer") or supplied_reviewer or "recorded reviewer")
    elif supplied_reviewer:
        reviewer = supplied_reviewer
    else:
        profile = repo.get_candidate_profile()
        reviewer = str((profile or {}).get("full_name") or "").strip()
        if not reviewer:
            parser.error("Reviewer is required when the candidate profile has no full name.")

    job_title = str((job or {}).get("title") or "Unknown Role")
    company = str((job or {}).get("company") or "Unknown Company")
    tailored_text = str(record.get("tailored_text") or "")
    content_hash = str(record.get("content_hash") or "")

    print("=" * 60)
    print(f"RESUME REVIEW: {company} - {job_title}")
    print("=" * 60)
    print(f"PDF Artifact: {record.get('pdf_path')}")
    print(f"Version:      v{record.get('version_number')}")
    print(f"Content Hash: {content_hash[:16]}...")
    print(f"Reviewer:     {reviewer}")
    print("-" * 60)
    print(tailored_text[:500] + "\n[... full text formatted in compiled PDF ...]\n")
    print("-" * 60)

    if record.get("approved_by_human"):
        print(f"This resume version is already approved by {reviewer}.")
        if not job:
            print("ERROR: The job linked to this resume no longer exists.", file=sys.stderr)
            return 1
        workflow_ok, is_ready, workflow_message = advance_job_to_ready(
            repo,
            str(record["job_id"]),
            str(job.get("status") or ""),
            reviewer,
        )
        output = sys.stdout if workflow_ok else sys.stderr
        print(workflow_message, file=output)
        if is_ready:
            print(f"Job '{company}' is ready for the Application Copilot.")
        return 0 if workflow_ok else 1

    validation_status = str(record.get("validation_status") or "UNKNOWN")
    if validation_status != "AWAITING_HUMAN_REVIEW":
        print(
            f"ERROR: Resume cannot be approved from validation status '{validation_status}'.",
            file=sys.stderr,
        )
        return 1
    if not job:
        print("ERROR: The job linked to this resume no longer exists.", file=sys.stderr)
        return 1

    answer = input("After inspecting the PDF, type APPROVE to approve this version: ").strip()
    if answer != "APPROVE":
        print("Approval cancelled. No changes recorded.")
        return 0

    approved, approval_message = repo.confirm_human_approval(
        resume_id,
        content_hash,
        reviewer,
        human_confirmed=True,
    )
    if not approved:
        print(f"ERROR: {approval_message}", file=sys.stderr)
        return 1
    print("Resume approval recorded with artifact integrity checks.")

    workflow_ok, is_ready, workflow_message = advance_job_to_ready(
        repo,
        str(record["job_id"]),
        str(job.get("status") or ""),
        reviewer,
    )
    output = sys.stdout if workflow_ok else sys.stderr
    print(workflow_message, file=output)
    if is_ready:
        print(f"Job '{company}' is ready for the Application Copilot.")
    return 0 if workflow_ok else 1


if __name__ == "__main__":
    sys.exit(main())
