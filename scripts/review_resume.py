#!/usr/bin/env python3
"""Human-operated local approval. Never invoke this script autonomously."""
import argparse
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.memory.repository import JobRepository


def main() -> None:
    parser = argparse.ArgumentParser(description="Review an exact resume version; does not submit applications.")
    parser.add_argument("--resume-id", required=True)
    parser.add_argument("--reviewer", required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error("Human review requires an interactive terminal.")
    repo = JobRepository()
    record = repo.get_resume_version(args.resume_id)
    if not record or record["validation_status"] != "AWAITING_HUMAN_REVIEW":
        parser.error("Resume is not awaiting human review.")
    print(record["tailored_text"])
    print(f"Review PDF: {record['pdf_path']}\nVersion: {record['version_number']}\nHash: {record['content_hash']}")
    if input("After inspecting the PDF, type APPROVE to approve this version: ") != "APPROVE":
        print("No approval recorded.")
        return
    ok, message = repo.confirm_human_approval(args.resume_id, record["content_hash"], args.reviewer, human_confirmed=True)
    print(message)
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
