#!/usr/bin/env python3
"""Generate a draft through the same validated workflow as MCP."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.documents.pipeline import generate_documents
from services.documents.validator import ClaimValidator
from services.intelligence.scorer import FitScorer
from services.memory.repository import JobRepository


def prepare_context(repo: JobRepository, job_id: str) -> Dict[str, Any]:
    profile = repo.get_candidate_profile()
    job = repo.get_job_by_id(job_id)
    if not profile or not job:
        raise ValueError("Job or candidate profile not found.")

    cand_snap_id = repo.save_candidate_snapshot(str(profile["id"]), profile)
    raw_text = (job.get("description") or "").replace("\x00", "").strip()
    current_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    jd_snap = repo.get_jd_snapshot_by_hash(job_id, current_hash)
    if not jd_snap:
        snap_id = repo.save_jd_snapshot(job_id, raw_text, raw_text)
        jd_snap = {"id": snap_id, "cleaned_text": raw_text, "content_hash": current_hash}

    return {
        "job_id": job_id,
        "title": job.get("title"),
        "company": job.get("company"),
        "jd_snapshot_id": str(jd_snap["id"]),
        "candidate_snapshot_id": cand_snap_id,
        "description": raw_text,
    }


def save_analysis(
    repo: JobRepository, job_id: str, analysis_data: Dict[str, Any]
) -> Dict[str, Any]:
    submitted_job_id = analysis_data.get("job_id")
    if submitted_job_id is not None and str(submitted_job_id) != str(job_id):
        raise ValueError("Analysis job_id does not match the requested job.")

    profile = repo.get_candidate_profile()
    job = repo.get_job_by_id(job_id)
    if not profile or not job:
        raise ValueError("Job or candidate profile not found.")

    current_jd = (job.get("description") or "").replace("\x00", "").strip()
    current_jd_hash = hashlib.sha256(current_jd.encode("utf-8")).hexdigest()
    jd_snap = repo.get_jd_snapshot_by_hash(job_id, current_jd_hash)
    if not jd_snap:
        current_snapshot_id = repo.save_jd_snapshot(job_id, current_jd, current_jd)
        jd_snap = {"id": current_snapshot_id, "cleaned_text": current_jd}

    candidate_snap_id = analysis_data.get("candidate_snapshot_id")
    cand_snap = repo.get_candidate_snapshot(str(candidate_snap_id)) if candidate_snap_id else None
    if not cand_snap or str(cand_snap["candidate_id"]) != str(profile["id"]):
        raise ValueError("Candidate snapshot is missing or belongs to another candidate.")
    current_profile_hash = hashlib.sha256(
        json.dumps(profile, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    if cand_snap.get("snapshot_hash") != current_profile_hash:
        raise ValueError("Candidate snapshot is stale; prepare a new analysis context.")
    if any(
        requirement.get("review_status") == "confirmed"
        for requirement in analysis_data.get("requirements", [])
        if isinstance(requirement, dict)
    ):
        raise ValueError("Agent submissions cannot assert human-confirmed requirement matches.")

    validator = ClaimValidator(profile)
    is_valid, errors = validator.validate_analysis_submission(analysis_data, jd_snap, cand_snap)
    if not is_valid:
        raise ValueError(f"Analysis validation failed: {errors}")

    queued_reqs = repo.list_preparation_requests(job_id=job_id, status="QUEUED")
    saved_analysis = repo.save_job_analysis(
        job_id=job_id,
        jd_snapshot_id=str(jd_snap["id"]),
        candidate_snapshot_id=str(candidate_snap_id),
        requirements=analysis_data["requirements"],
        notes=analysis_data.get("notes", ""),
        created_by="antigravity",
    )

    scorer = FitScorer()
    score_res = scorer.score_job(job, profile, analysis=saved_analysis)
    repo.save_job_score(job_id, score_res, analysis_id=str(saved_analysis["id"]))

    for r in queued_reqs:
        repo.update_preparation_request_status(str(r["id"]), "ANALYZING")
        repo.update_preparation_request_status(
            str(r["id"]),
            "TAILORING",
            analysis_id=str(saved_analysis["id"]),
        )

    return saved_analysis


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a resume draft for human review.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--prepare-context", action="store_true", help="Output context snapshots for analysis")
    parser.add_argument("--analysis-file", type=str, help="Path to JSON file with validated analysis")
    args = parser.parse_args()

    repo = JobRepository()

    if args.prepare_context:
        ctx = prepare_context(repo, args.job_id)
        print(json.dumps(ctx, indent=2, default=str))
        return

    if args.analysis_file:
        analysis_path = Path(args.analysis_file)
        if not analysis_path.exists():
            print(json.dumps({"status": "error", "message": f"File {args.analysis_file} not found"}))
            sys.exit(1)
        try:
            analysis_data = json.loads(analysis_path.read_text(encoding="utf-8"))
            if not isinstance(analysis_data, dict):
                raise ValueError("Analysis file must contain a JSON object.")
            save_analysis(repo, args.job_id, analysis_data)
        except (OSError, ValueError) as exc:
            print(json.dumps({"status": "error", "message": str(exc)}))
            sys.exit(1)

    result = generate_documents(repo, args.job_id)

    active_reqs = repo.list_preparation_requests(job_id=args.job_id, status="TAILORING")
    for r in active_reqs:
        if result.get("status") == "success":
            repo.update_preparation_request_status(
                str(r["id"]),
                "READY_FOR_REVIEW",
                resume_version_id=str(result["resume_version_id"]),
            )
        else:
            request_status = "BLOCKED" if result.get("status") == "blocked" else "FAILED"
            error_summary = str(
                result.get("message")
                or result.get("blockers")
                or "Resume generation did not complete."
            )
            repo.update_preparation_request_status(
                str(r["id"]),
                request_status,
                error_summary=error_summary,
            )

    print(json.dumps(result, indent=2, default=str))
    if result["status"] != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
