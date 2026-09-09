#!/usr/bin/env python3
"""Print a safe summary of the candidate profile without shell-embedded Python."""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository


def build_summary(profile: Dict[str, Any]) -> Dict[str, Any]:
    """Build a bounded summary without changing or inferring candidate facts."""
    experiences = profile.get("work_experience") or []
    facts = profile.get("verified_facts") or []
    return {
        "full_name": profile.get("full_name"),
        "email": profile.get("email"),
        "phone": profile.get("phone"),
        "location": profile.get("location"),
        "work_experience": [
            {"company": item.get("company"), "role": item.get("role")}
            for item in experiences
            if isinstance(item, dict)
        ],
        "verified_facts": [
            {"fact_id": item.get("fact_id"), "text": item.get("text")}
            for item in facts
            if isinstance(item, dict)
        ],
        "skills_count": len(profile.get("skills") or []),
        "preferences": profile.get("preferences") or {},
    }


def print_human_summary(summary: Dict[str, Any], fact_limit: int) -> None:
    """Render the candidate summary for a terminal."""
    print(f"Candidate Name: {summary.get('full_name')}")
    print(f"Email: {summary.get('email')}")
    print(f"Phone: {summary.get('phone')}")
    print(f"Location: {summary.get('location')}")
    experiences = summary.get("work_experience", [])
    print(f"Work Experiences: {len(experiences)}")
    for experience in experiences:
        print(f"  - {experience.get('company')} ({experience.get('role')})")
    facts = summary.get("verified_facts", [])
    print(f"Verified Facts: {len(facts)}")
    for fact in facts[:fact_limit]:
        text = str(fact.get("text") or "")
        print(f"  - [{fact.get('fact_id')}] {text[:70]}...")
    print(f"Skills: {summary.get('skills_count', 0)}")
    print(f"Preferences: {summary.get('preferences', {})}")


def main() -> int:
    """Load and display the current candidate profile."""
    parser = argparse.ArgumentParser(description="Show the current candidate profile summary")
    parser.add_argument("--json", action="store_true", help="Print the summary as JSON")
    parser.add_argument(
        "--fact-limit", type=int, default=4, help="Maximum fact previews in human-readable output"
    )
    arguments = parser.parse_args()
    if arguments.fact_limit < 0:
        parser.error("--fact-limit must be zero or greater")

    profile = JobRepository().get_candidate_profile()
    if not profile:
        print("ERROR: Candidate profile not found.", file=sys.stderr)
        return 1

    summary = build_summary(profile)
    if arguments.json:
        print(json.dumps(summary, indent=2, default=str))
    else:
        print_human_summary(summary, arguments.fact_limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
