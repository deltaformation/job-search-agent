"""Safety regression tests for the checked-in resume-tailoring fallback."""

import hashlib
import json
from typing import Any, Dict
from unittest.mock import MagicMock

import pytest

from scripts.tailor_resume import save_analysis
from services.memory.repository import JobRepository


def _profile_hash(profile: Dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(profile, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _analysis_repository(snapshot_hash: str) -> MagicMock:
    profile = {"id": "candidate-1", "verified_facts": []}
    repo = MagicMock(spec=JobRepository)
    repo.get_candidate_profile.return_value = profile
    repo.get_job_by_id.return_value = {
        "job_id": "job-1",
        "description": "Python is required.",
    }
    repo.get_jd_snapshot_by_hash.return_value = {
        "id": "jd-snapshot-1",
        "cleaned_text": "Python is required.",
    }
    repo.get_candidate_snapshot.return_value = {
        "id": "candidate-snapshot-1",
        "candidate_id": "candidate-1",
        "snapshot_hash": snapshot_hash,
    }
    return repo


def test_analysis_file_cannot_target_a_different_job() -> None:
    repo = MagicMock(spec=JobRepository)

    with pytest.raises(ValueError, match="job_id does not match"):
        save_analysis(
            repo,
            "job-1",
            {"job_id": "job-2", "requirements": []},
        )

    repo.get_candidate_profile.assert_not_called()


def test_analysis_file_rejects_stale_candidate_snapshot() -> None:
    repo = _analysis_repository(snapshot_hash="stale-hash")

    with pytest.raises(ValueError, match="Candidate snapshot is stale"):
        save_analysis(
            repo,
            "job-1",
            {
                "job_id": "job-1",
                "jd_snapshot_id": "jd-snapshot-1",
                "candidate_snapshot_id": "candidate-snapshot-1",
                "requirements": [],
            },
        )

    repo.save_job_analysis.assert_not_called()


def test_analysis_file_cannot_assert_human_confirmation() -> None:
    profile = {"id": "candidate-1", "verified_facts": []}
    repo = _analysis_repository(snapshot_hash=_profile_hash(profile))

    with pytest.raises(ValueError, match="cannot assert human-confirmed"):
        save_analysis(
            repo,
            "job-1",
            {
                "job_id": "job-1",
                "jd_snapshot_id": "jd-snapshot-1",
                "candidate_snapshot_id": "candidate-snapshot-1",
                "requirements": [
                    {
                        "requirement_id": "requirement-1",
                        "jd_quote": "Python",
                        "match_status": "unsupported",
                        "review_status": "confirmed",
                    }
                ],
            },
        )

    repo.save_job_analysis.assert_not_called()
