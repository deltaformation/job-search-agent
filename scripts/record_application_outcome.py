#!/usr/bin/env python3
"""
Human-Operated Application Outcome Recorder

This interactive CLI command is executed exclusively by the human user
after inspecting the prepared application and completing the final submission
or handoff directly in the visible browser.

Invariants:
- Requires interactive terminal (TTY).
- Never callable by autonomous AI agents or exposed via MCP.
- Atomically transitions application to SUBMITTED_CONFIRMED and job to SUBMITTED.
"""

import sys
import argparse
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository

def main() -> int:
    parser = argparse.ArgumentParser(description="Record Human-Observed Application Outcome")
    parser.add_argument("--app-id", required=True, help="Application UUID")
    parser.add_argument("--reviewer", default="human", help="Human reviewer identity")
    args = parser.parse_args()

    # Enforce interactive terminal execution
    if not sys.stdin.isatty():
        print("ERROR: record_application_outcome.py requires an interactive terminal (TTY).", file=sys.stderr)
        print("Autonomous execution by AI agents or background scripts is strictly prohibited.", file=sys.stderr)
        return 1

    repo = JobRepository()
    app = repo.get_application_by_id(args.app_id)
    if not app:
        print(f"ERROR: Application '{args.app_id}' not found.", file=sys.stderr)
        return 1

    job_id = str(app["job_id"])
    job = repo.get_job_by_id(job_id)
    if not job:
        print(f"ERROR: Job '{job_id}' not found.", file=sys.stderr)
        return 1

    checkpoint = repo.get_latest_checkpoint(args.app_id)

    print("=" * 65)
    print("APPLICATION COPILOT - HUMAN OUTCOME RECORDING")
    print("=" * 65)
    print(f"Company:          {job.get('company')}")
    print(f"Title:            {job.get('title')}")
    print(f"Job ID:           {job_id}")
    print(f"Application ID:   {args.app_id}")
    print(f"Current Status:   {app.get('status')}")
    print(f"Resume Version:   {app.get('resume_version_id')} (Hash: {str(app.get('resume_content_hash'))[:12]}...)")
    print(f"Application URL:  {app.get('application_url')}")
    if checkpoint:
        print(f"Latest Stage:     {checkpoint.get('stage')} (Next: {checkpoint.get('next_action')})")
    print("-" * 65)
    print("Select observed outcome:")
    print("  1) SUBMITTED   - You personally clicked Submit and observed success/confirmation.")
    print("  2) ABANDONED   - You chose not to proceed with this application.")
    print("  3) FAILED      - Submission failed due to ATS error, expired role, or blocker.")
    print("-" * 65)

    choice = input("Enter choice (1/2/3) [or 'q' to abort]: ").strip()
    if choice in ("q", "Q", ""):
        print("Aborted by user.")
        return 0

    if choice == "1":
        print("\nCONFIRMATION REQUIRED:")
        print("By confirming, you attest that you personally completed the final browser")
        print("actions and observed that the application was submitted to the employer.")
        confirm = input("Type 'CONFIRM' to finalize submission: ").strip()
        if confirm != "CONFIRM":
            print("Confirmation string did not match. Aborting.")
            return 1

        ref_no = input("Employer confirmation / reference number (optional): ").strip() or None
        notes = input("Review notes or observation details (optional): ").strip() or None

        ok, msg = repo.record_human_submission(
            application_id=args.app_id,
            reviewer=args.reviewer,
            notes=notes,
            reference_number=ref_no,
            human_confirmed=True
        )
        if not ok:
            print(f"ERROR: Failed to record submission: {msg}", file=sys.stderr)
            return 1

        print("\nSUCCESS: Application recorded as SUBMITTED_CONFIRMED.")
        print(f"Job status updated to SUBMITTED. Audit events recorded.")
        return 0

    elif choice == "2":
        reason = input("Reason for abandoning application: ").strip() or "Abandoned by human reviewer"
        ok, msg = repo.transition_application_state(
            application_id=args.app_id,
            to_status="ABANDONED",
            actor=args.reviewer,
            reason=reason
        )
        if ok:
            repo.transition_job_workflow(
                job_id=job_id,
                next_state="SKIPPED",
                actor=args.reviewer,
                reason=reason
            )
            print("Application marked as ABANDONED. Job moved to SKIPPED.")
            return 0
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
            return 1

    elif choice == "3":
        error_msg = input("Error or failure details: ").strip() or "Submission failed in browser"
        ok, msg = repo.transition_application_state(
            application_id=args.app_id,
            to_status="FAILED",
            actor=args.reviewer,
            reason=error_msg
        )
        if ok:
            print("Application marked as FAILED.")
            return 0
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
            return 1

    else:
        print(f"Invalid option '{choice}'. Aborted.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
