#!/usr/bin/env python3
"""Show bounded, read-only job workflow context without ad-hoc SQL."""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from uuid import UUID

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.applications.readiness import ApplicationPackage, check_application_readiness
from services.memory.repository import JobRepository


ReadinessChecker = Callable[
    [JobRepository, str],
    Tuple[bool, Optional[ApplicationPackage], List[str]],
]


def _selected(record: Optional[Dict[str, Any]], fields: List[str]) -> Optional[Dict[str, Any]]:
    """Return only the explicitly approved diagnostic fields from a record."""
    if not record:
        return None
    return {field: record.get(field) for field in fields}


def _text_metadata(value: Any) -> Dict[str, Any]:
    """Describe potentially large text without printing its contents."""
    text = str(value or "")
    return {"present": bool(text.strip()), "character_count": len(text)}


def build_job_context(
    repo: JobRepository,
    job_id: str,
    readiness_checker: ReadinessChecker = check_application_readiness,
) -> Dict[str, Any]:
    """Build a stable workflow summary using repository APIs only."""
    job = repo.get_job_by_id(job_id)
    if not job:
        return {"status": "not_found", "job_id": job_id, "read_only": True}

    analysis = repo.get_job_analysis(job_id)
    resume = repo.get_latest_resume_for_job(job_id)
    application = repo.get_application_by_job_id(job_id)
    attempt = repo.get_latest_attempt(str(application["id"])) if application else None
    requirements = repo.get_job_requirements(job_id)
    requirement_states = Counter(
        str(item.get("match_status") or item.get("status") or "unknown")
        for item in requirements
    )
    ready, package, blockers = readiness_checker(repo, job_id)

    analysis_summary = _selected(
        analysis,
        [
            "id",
            "version_number",
            "jd_snapshot_id",
            "candidate_snapshot_id",
            "created_by",
            "created_at",
        ],
    )
    if analysis_summary is not None:
        analysis_summary["notes"] = _text_metadata(analysis.get("notes"))

    resume_summary = _selected(
        resume,
        [
            "id",
            "version_number",
            "validation_status",
            "approved_by_human",
            "content_hash",
            "pdf_hash",
            "html_hash",
            "analysis_id",
            "profile_snapshot_id",
            "jd_snapshot_id",
            "pdf_path",
        ],
    )
    if resume_summary is not None:
        resume_summary["diff_summary"] = _text_metadata(resume.get("diff_summary"))

    return {
        "status": "ok",
        "read_only": True,
        "job": _selected(
            job,
            [
                "job_id",
                "title",
                "company",
                "status",
                "assessment_status",
                "overall_score",
                "recommendation",
                "freshness_bucket",
                "age_hours",
                "apply_url",
                "canonical_url",
            ],
        ),
        "analysis": analysis_summary,
        "resume": resume_summary,
        "application": _selected(
            application,
            [
                "id",
                "status",
                "resume_version_id",
                "analysis_id",
                "application_url",
                "ats_detected",
                "updated_at",
            ],
        ),
        "latest_attempt": _selected(
            attempt,
            [
                "id",
                "attempt_number",
                "status",
                "stage_label",
                "current_page_url",
                "error_summary",
                "updated_at",
            ],
        ),
        "requirements": {
            "count": len(requirements),
            "by_match_status": dict(sorted(requirement_states.items())),
        },
        "application_readiness": {
            "ready": ready,
            "blockers": blockers,
            "resume_version_id": package.resume_version_id if package else None,
            "pdf_path": package.pdf_path if package else None,
        },
    }


def main() -> int:
    """Print a JSON job-context report without modifying workflow state."""
    parser = argparse.ArgumentParser(
        description="Show read-only job, analysis, resume, and application context"
    )
    parser.add_argument("--job-id", required=True, help="Job UUID to inspect")
    arguments = parser.parse_args()

    try:
        UUID(arguments.job_id)
    except ValueError:
        parser.error("--job-id must be a valid UUID")

    context = build_job_context(JobRepository(), arguments.job_id)
    print(json.dumps(context, indent=2, default=str))
    return 0 if context["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
