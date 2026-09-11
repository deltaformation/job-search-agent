"""
Shared Analysis Context Builder.

Extracts candidate and JD snapshotting into a reusable, typed builder.
Provides exact (lossless) JD text, candidate evidence inventory, fact-grounded
keyword coverage, allowed enums, submission payload template, and truthfulness rules
required for submit_analysis_version without additional tool calls.
"""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from services.intelligence.models import (
    RequirementCategory,
    RequirementImportance,
    RequirementMatchStatus,
    RequirementReviewStatus,
)
from services.intelligence.scorer import FitScorer
from services.memory.repository import JobRepository


def sanitize_value(val: Any) -> Any:
    """Recursively converts Decimal, datetime, date, and NaN values for clean JSON serialization."""
    if val is None:
        return None
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    if isinstance(val, dict):
        return {k: sanitize_value(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return [sanitize_value(item) for item in val]
    return val


class AnalysisContextBuilder:
    """Builds complete, lossless analysis contexts for pending or explicitly selected jobs."""

    def __init__(
        self,
        repo: Optional[JobRepository] = None,
        scorer: Optional[FitScorer] = None,
        candidate_snapshot_id: Optional[str] = None,
    ) -> None:
        self.repo = repo or JobRepository()
        self.scorer = scorer or FitScorer()
        self._cand_snapshot_id = candidate_snapshot_id
        self._cand_snapshot_hash: Optional[str] = None
        self._cand_profile: Optional[Dict[str, Any]] = None

    def get_candidate_snapshot(self) -> Tuple[str, str, Dict[str, Any]]:
        """
        Creates or reuses one candidate snapshot for this builder session.
        Guarantees that multiple jobs in the same workflow context reuse the exact same candidate snapshot.
        """
        if self._cand_snapshot_id and self._cand_snapshot_hash and self._cand_profile:
            return self._cand_snapshot_id, self._cand_snapshot_hash, self._cand_profile

        profile = self.repo.get_candidate_profile()
        if not profile:
            raise ValueError("No candidate profile configured in database.")

        profile_json = json.dumps(profile, sort_keys=True, default=str)
        snap_hash = hashlib.sha256(profile_json.encode("utf-8")).hexdigest()

        if self._cand_snapshot_id:
            snap = self.repo.get_candidate_snapshot(self._cand_snapshot_id)
            if snap and snap.get("snapshot_hash") == snap_hash:
                self._cand_snapshot_hash = snap_hash
                self._cand_profile = profile
                return self._cand_snapshot_id, self._cand_snapshot_hash, self._cand_profile

        snap_id = self.repo.save_candidate_snapshot(str(profile["id"]), profile)
        self._cand_snapshot_id = str(snap_id)
        self._cand_snapshot_hash = snap_hash
        self._cand_profile = profile

        return self._cand_snapshot_id, self._cand_snapshot_hash, self._cand_profile

    def get_or_create_jd_snapshot(self, job_id: str, raw_jd: str) -> Tuple[str, str]:
        """
        Creates or retrieves an immutable snapshot of the exact current job description.
        Returns (jd_snapshot_id, content_hash).
        """
        content_hash = hashlib.sha256(raw_jd.encode("utf-8")).hexdigest()
        existing = self.repo.get_jd_snapshot_by_hash(job_id, content_hash)
        if existing:
            return str(existing["id"]), content_hash

        snap_id = self.repo.save_jd_snapshot(job_id, raw_jd, raw_jd)
        return str(snap_id), content_hash

    def build_for_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """
        Constructs the complete, self-contained analysis context for a given job.
        Includes exact JD, candidate evidence inventory, FitScorer keyword coverage,
        allowed enums, submission template, and truthfulness invariants.
        """
        job = self.repo.get_job_by_id(job_id)
        if not job:
            return None

        cand_snap_id, cand_snap_hash, profile = self.get_candidate_snapshot()

        raw_jd = (job.get("description") or "").replace("\x00", "").strip()
        jd_snap_id, jd_content_hash = self.get_or_create_jd_snapshot(job_id, raw_jd)

        # 1. Verified facts inventory
        verified_facts: List[Dict[str, Any]] = []
        for fact in profile.get("verified_facts", []):
            if fact.get("verification_status") == "approved":
                verified_facts.append({
                    "fact_id": fact["fact_id"],
                    "work_experience_id": str(fact.get("work_experience_id") or ""),
                    "category": fact.get("category"),
                    "text": fact.get("text"),
                    "technologies": fact.get("technologies", []),
                    "metrics": fact.get("metrics", []),
                })

        verified_skills = [
            s["name"].strip()
            for s in profile.get("skills", [])
            if s.get("verified") is True and isinstance(s.get("name"), str) and s["name"].strip()
        ]

        # 2. Candidate preferences and target roles
        preferences = profile.get("preferences") or {}
        target_titles = profile.get("target_titles") or []

        # 3. Fit scoring and fact-grounded keyword coverage
        score_res = self.scorer.score_job(job, profile)
        keyword_coverage = self.scorer.calculate_keyword_coverage(job, profile)

        # 4. Allowed enums and submission template
        allowed_enums = {
            "category": [e.value for e in RequirementCategory],
            "importance": [e.value for e in RequirementImportance],
            "match_status": [e.value for e in RequirementMatchStatus],
            "review_status": [RequirementReviewStatus.PROPOSED.value],
        }

        submission_template = {
            "job_id": str(job_id),
            "jd_snapshot_id": jd_snap_id,
            "candidate_snapshot_id": cand_snap_id,
            "notes": "Agent analysis notes explaining key matches and gaps",
            "requirements": [
                {
                    "requirement_id": "req_001",
                    "jd_quote": "Exact verbatim quote from job_description",
                    "description": "Short description of the requirement",
                    "category": "experience | skill | responsibility | domain | location | compensation | screening | other",
                    "importance": "required | preferred | unspecified",
                    "match_status": "matched | partial | unsupported | gap",
                    "evidence_fact_ids": ["fact_001"],
                    "evidence_quotes": ["Verbatim excerpt from candidate verified fact"],
                    "notes": "Optional notes",
                }
            ],
        }

        truthfulness_rules = [
            "Never invent facts, employers, metrics, dates, or certifications.",
            "Every evidence_fact_id must exist in verified_facts with approved status.",
            "jd_quote must be an exact verbatim substring of job_description.",
            "Unmatched JD requirements must be labeled with match_status 'unsupported' or 'gap' with empty evidence_fact_ids.",
            "Agent submissions cannot assert human confirmation (review_status must remain 'proposed').",
        ]

        context = {
            "job_id": str(job_id),
            "title": job.get("title"),
            "company": job.get("company"),
            "location": job.get("location"),
            "remote_type": job.get("remote_type"),
            "employment_type": job.get("employment_type"),
            "apply_url": job.get("apply_url") or job.get("canonical_url"),
            "job_description": raw_jd,
            "jd_snapshot_id": jd_snap_id,
            "jd_content_hash": jd_content_hash,
            "candidate_snapshot_id": cand_snap_id,
            "candidate_snapshot_hash": cand_snap_hash,
            "candidate_name": profile.get("full_name"),
            "target_titles": target_titles,
            "preferences": preferences,
            "verified_facts_count": len(verified_facts),
            "verified_facts": verified_facts,
            "verified_skills": verified_skills,
            "provisional_score": float(score_res["overall_score"]) if score_res.get("overall_score") is not None else None,
            "score_band": score_res.get("score_band"),
            "recommendation": score_res.get("recommendation"),
            "strengths": score_res.get("strengths", []),
            "gaps": score_res.get("gaps", []),
            "risks": score_res.get("risks", []),
            "keyword_coverage": keyword_coverage,
            "allowed_enums": allowed_enums,
            "submission_template": submission_template,
            "truthfulness_rules": truthfulness_rules,
        }

        return sanitize_value(context)

    def build_next_pending(self, min_score: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Selects the highest-priority pending analysis job and builds its complete context."""
        jobs = self.repo.get_pending_analysis_jobs(limit=1, min_score=min_score)
        if not jobs:
            return None
        return self.build_for_job(str(jobs[0]["job_id"]))
