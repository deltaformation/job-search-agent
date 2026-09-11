#!/usr/bin/env python3
"""Human-operated wording-variant approval. Never invoke this script autonomously.

Approving a resume PDF (``review_resume.py``) never approves reusable wording.
A variant renders in future resumes only after explicit approval here.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.memory.repository import JobRepository


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Review proposed reusable resume wording variants."
    )
    parser.add_argument("--list", action="store_true", help="List proposed variants")
    parser.add_argument("--variant-id", type=str, help="Variant ID to review")
    parser.add_argument("--reviewer", default=None, help="Human reviewer name")
    args = parser.parse_args(argv)

    repo = JobRepository()
    profile = repo.get_candidate_profile()
    if not profile:
        print("ERROR: Candidate profile not found.", file=sys.stderr)
        return 1
    candidate_id = str(profile["id"])

    if args.list or not args.variant_id:
        variants = repo.list_wording_variants(candidate_id, status="proposed")
        if not variants:
            print("No proposed wording variants.")
            return 0
        for variant in variants:
            fact_ids = variant.get("fact_ids", [])
            if isinstance(fact_ids, str):
                try:
                    fact_ids = json.loads(fact_ids)
                except json.JSONDecodeError:
                    fact_ids = [fact_ids]
            print(f"- {variant['id']} (facts: {fact_ids})")
            print(f"  {str(variant.get('variant_text') or '')[:160]}")
        return 0

    if not sys.stdin.isatty():
        parser.error("Human review requires an interactive terminal.")

    variant = repo.get_wording_variant(args.variant_id)
    if not variant or str(variant.get("candidate_id")) != candidate_id:
        print(f"ERROR: Variant '{args.variant_id}' not found for this candidate.", file=sys.stderr)
        return 1
    if variant.get("review_status") == "approved":
        print(f"Variant is already approved by {variant.get('reviewer')}.")
        return 0

    reviewer = str(args.reviewer or "").strip() or str(profile.get("full_name") or "human")
    print("=" * 60)
    print("WORDING VARIANT REVIEW (reusable across future resumes)")
    print("=" * 60)
    print(f"Variant:  {variant['id']}")
    print(f"Facts:    {variant.get('fact_ids')}")
    print(f"Keywords: {variant.get('normalized_keywords')}")
    print("-" * 60)
    print(str(variant.get("variant_text") or ""))
    print("-" * 60)
    print("Approving here does NOT approve any resume. Each resume still")
    print("requires its own review via review_resume.py.")
    answer = input("Type APPROVE to approve this reusable wording: ").strip()
    if answer != "APPROVE":
        print("Approval cancelled. No changes recorded.")
        return 0
    approved, message = repo.approve_wording_variant(
        str(variant["id"]), reviewer, human_confirmed=True
    )
    if not approved:
        print(f"ERROR: {message}", file=sys.stderr)
        return 1
    print(f"Wording variant approved: {message}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
