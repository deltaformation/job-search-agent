import os
import json
import hashlib
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple
from uuid import uuid4
import psycopg
from psycopg.rows import dict_row
from services.discovery.deduplicator import is_ats_url, detect_ats_type
from services.discovery.normalizer import generate_content_hash
from services.intelligence.models import (
    CanonicalRequirement,
    validate_preparation_request_transition,
)

# Compute freshness at read time, including jobs that are never scraped again.
FRESHNESS_JOIN = """
    CROSS JOIN LATERAL (
        SELECT GREATEST(0, EXTRACT(EPOCH FROM
            (NOW() - COALESCE(j.posted_at, j.first_seen_at))) / 3600) AS raw_age
    ) age
    CROSS JOIN LATERAL (
        SELECT ROUND(age.raw_age, 1) AS age_hours,
               CASE WHEN age.raw_age <= 24 THEN 'HOT'
                    WHEN age.raw_age <= 48 THEN 'FRESH'
                    WHEN age.raw_age <= 72 THEN 'RECENT'
                    ELSE 'STALE' END AS freshness_bucket
    ) fresh
"""

ALLOWED_WORKFLOW_TRANSITIONS = {
    "NEW": {"QUALIFIED", "SHORTLISTED", "REVIEWED", "REVIEW", "SKIPPED", "EXPIRED"},
    "QUALIFIED": {"SHORTLISTED", "REVIEWED", "TAILORING", "SKIPPED", "EXPIRED"},
    "SHORTLISTED": {"REVIEWED", "TAILORING", "SKIPPED", "EXPIRED"},
    "REVIEW": {"TAILORING", "READY", "SKIPPED", "REJECTED", "EXPIRED"},
    "REVIEWED": {"TAILORING", "READY", "SKIPPED", "REJECTED", "EXPIRED"},
    "TAILORING": {"READY", "SKIPPED", "REJECTED"},
    "READY": {"APPLICATION_STARTED", "WAITING_FOR_HUMAN", "SKIPPED", "REJECTED"},
    "APPLICATION_STARTED": {"WAITING_FOR_HUMAN", "SUBMITTED", "WITHDRAWN", "REJECTED"},
    "WAITING_FOR_HUMAN": {"SUBMITTED", "WITHDRAWN", "REJECTED"},
    "SUBMITTED": {"SCREEN", "INTERVIEW", "FINAL", "OFFER", "REJECTED", "WITHDRAWN"},
    "SCREEN": {"INTERVIEW", "FINAL", "OFFER", "REJECTED", "WITHDRAWN"},
    "INTERVIEW": {"FINAL", "OFFER", "REJECTED", "WITHDRAWN"},
    "FINAL": {"OFFER", "REJECTED", "WITHDRAWN"},
    "OFFER": {"ACCEPTED", "REJECTED", "WITHDRAWN"},
    "SKIPPED": {"NEW", "REVIEWED"},
    "REJECTED": {"NEW", "REVIEWED"},
    "EXPIRED": {"NEW"},
    "WITHDRAWN": {"NEW"},
    "ACCEPTED": set(),
}

ACTIVE_APPLICATION_STATES = {
    "TAILORING", "READY", "APPLICATION_STARTED", "WAITING_FOR_HUMAN",
    "SUBMITTED", "SCREEN", "INTERVIEW", "FINAL", "OFFER", "ACCEPTED",
    "SKIPPED", "REJECTED", "WITHDRAWN"
}

ALLOWED_APPLICATION_TRANSITIONS = {
    "DRAFT": {"PREPARING", "ABANDONED", "FAILED"},
    "PREPARING": {"NEEDS_HUMAN_INPUT", "READY_FOR_HUMAN_REVIEW", "ABANDONED", "FAILED"},
    "NEEDS_HUMAN_INPUT": {"PREPARING", "READY_FOR_HUMAN_REVIEW", "ABANDONED", "FAILED"},
    "READY_FOR_HUMAN_REVIEW": {"HUMAN_COMPLETING", "NEEDS_HUMAN_INPUT", "ABANDONED", "FAILED"},
    "HUMAN_COMPLETING": {"SUBMITTED_CONFIRMED", "NEEDS_HUMAN_INPUT", "ABANDONED", "FAILED"},
    "SUBMITTED_CONFIRMED": set(),
    "ABANDONED": {"DRAFT", "PREPARING"},
    "FAILED": {"DRAFT", "PREPARING"},
    "APPLICATION_STARTED": {"PREPARING", "NEEDS_HUMAN_INPUT", "READY_FOR_HUMAN_REVIEW", "ABANDONED"},
}

ALLOWED_ATTEMPT_TRANSITIONS = {
    "CREATED": {"INSPECTING", "CHECKPOINTED", "FAILED"},
    "INSPECTING": {"PLANNED", "CHECKPOINTED", "INTERRUPTED", "FAILED"},
    "PLANNED": {"FILLING", "CHECKPOINTED", "INTERRUPTED", "FAILED"},
    "FILLING": {"CHECKPOINTED", "COMPLETED_WITHOUT_SUBMISSION", "INTERRUPTED", "FAILED"},
    "CHECKPOINTED": {"FILLING", "COMPLETED_WITHOUT_SUBMISSION", "INTERRUPTED", "FAILED"},
    "INTERRUPTED": set(),
    "COMPLETED_WITHOUT_SUBMISSION": set(),
    "FAILED": set(),
}

DEFAULT_DB_URL = "postgresql://mouadatfi@localhost:5432/job_system"

class JobRepository:
    def __init__(self, db_url: Optional[str] = None) -> None:
        self.db_url = db_url or os.getenv("DATABASE_URL", DEFAULT_DB_URL)

    def get_connection(self) -> psycopg.Connection[Dict[str, Any]]:
        return psycopg.connect(self.db_url, row_factory=dict_row)

    def get_candidate_profile(self) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM candidate_profile LIMIT 1;")
                profile = cur.fetchone()
                if not profile:
                    return None
                
                # Fetch work experiences
                cur.execute("""
                    SELECT * FROM work_experience 
                    WHERE candidate_id = %s 
                    ORDER BY start_date DESC;
                """, (profile["id"],))
                profile["work_experience"] = cur.fetchall()

                # Fetch achievements (facts)
                cur.execute("""
                    SELECT a.* FROM achievements a
                    JOIN work_experience w ON w.id = a.work_experience_id
                    WHERE a.verification_status = 'approved' AND w.candidate_id = %s
                    ORDER BY a.fact_id ASC;
                """, (profile["id"],))
                profile["verified_facts"] = cur.fetchall()

                # Fetch skills
                cur.execute("""
                    SELECT * FROM skills 
                    WHERE candidate_id = %s AND verified = TRUE
                    ORDER BY years_experience DESC NULLS LAST;
                """, (profile["id"],))
                profile["skills"] = cur.fetchall()

                # Fetch preferences
                cur.execute("""
                    SELECT key, value FROM preferences 
                    WHERE candidate_id = %s;
                """, (profile["id"],))
                profile["preferences"] = {r["key"]: r["value"] for r in cur.fetchall()}

                # Fetch standard answers
                cur.execute("""
                    SELECT * FROM standard_answers 
                    WHERE candidate_id = %s;
                """, (profile["id"],))
                profile["standard_answers"] = cur.fetchall()

                for table in ("education", "credentials"):
                    # Table names are a fixed internal allowlist.
                    cur.execute(f"SELECT * FROM {table} WHERE candidate_id = %s ORDER BY id", (profile["id"],))
                    profile[table] = cur.fetchall()
                return profile

    def upsert_job(self, job_data: Dict[str, Any], source_data: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        """
        Inserts or updates a job and appends source provenance.
        Returns (job_record, is_new).
        """
        job_data = dict(job_data)
        source_data = dict(source_data)

        if not job_data.get("canonical_url"):
            raise ValueError("canonical_url is required; synthetic job URLs are not permitted.")
        if not job_data.get("content_hash"):
            job_data["content_hash"] = generate_content_hash(
                job_data.get("company", ""),
                job_data.get("normalized_title") or job_data.get("title", ""),
                job_data.get("description", "")
            )

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # Resolve every deduplication signal against the full database,
                # including source identities previously merged into another job.
                cur.execute("""
                    SELECT j.* FROM jobs j
                    WHERE canonical_url = %(url)s
                       OR content_hash = %(hash)s
                       OR (%(apply)s <> '' AND apply_url = %(apply)s)
                       OR (%(source_id)s <> '' AND (
                           (source = %(source)s AND source_job_id = %(source_id)s)
                           OR EXISTS (
                               SELECT 1 FROM job_sources js
                               WHERE js.job_id = j.job_id
                                 AND js.source_name = %(source)s
                                 AND js.source_job_id = %(source_id)s)))
                       OR (%(company)s <> '' AND %(title)s <> '' AND %(location)s <> ''
                           AND LOWER(TRIM(company)) = %(company)s
                           AND LOWER(TRIM(normalized_title)) = %(title)s
                           AND TRIM(location) <> ''
                           AND (POSITION(%(location)s IN LOWER(TRIM(location))) > 0
                                OR POSITION(LOWER(TRIM(location)) IN %(location)s) > 0
                                OR (POSITION('remote' IN %(location)s) > 0
                                    AND POSITION('remote' IN LOWER(location)) > 0)))
                    ORDER BY (canonical_url = %(url)s) DESC, created_at, job_id
                    LIMIT 1;
                """, {
                    "url": job_data["canonical_url"],
                    "hash": job_data["content_hash"],
                    "apply": job_data.get("apply_url") or "",
                    "source": job_data.get("source") or "",
                    "source_id": job_data.get("source_job_id") or "",
                    "company": (job_data.get("company") or "").strip().lower(),
                    "title": (job_data.get("normalized_title") or job_data["title"]).strip().lower(),
                    "location": (job_data.get("location") or "").strip().lower(),
                })
                existing = cur.fetchone()

                if existing:
                    job_id = existing["job_id"]
                    # Update last_seen_at and better apply_url if found
                    best_apply_url = existing["apply_url"]
                    incoming_apply_url = job_data.get("apply_url")
                    if incoming_apply_url and (
                        not best_apply_url
                        or (is_ats_url(incoming_apply_url) and not is_ats_url(best_apply_url))
                    ):
                        best_apply_url = incoming_apply_url
                    best_ats_type = detect_ats_type(best_apply_url) or existing.get("ats_type")

                    cur.execute("""
                        UPDATE jobs 
                        SET last_seen_at = NOW(),
                            age_hours = %s,
                            freshness_bucket = %s,
                            apply_url = %s,
                            ats_type = %s,
                            updated_at = NOW()
                        WHERE job_id = %s
                        RETURNING *;
                    """, (job_data.get("age_hours", 0), job_data.get("freshness_bucket", "HOT"), best_apply_url, best_ats_type, job_id))
                    updated_job = cur.fetchone()

                    # Add source to job_sources
                    cur.execute("""
                        INSERT INTO job_sources (job_id, source_name, source_url, source_job_id, raw_payload)
                        VALUES (%s, %s, %s, %s, %s);
                    """, (
                        job_id,
                        source_data.get("source_name", "unknown"),
                        source_data.get("source_url", ""),
                        source_data.get("source_job_id"),
                        json.dumps(source_data.get("raw_payload", {}), default=str)
                    ))
                    conn.commit()
                    return updated_job, False
                else:
                    # Insert new job
                    cur.execute("""
                        INSERT INTO jobs (
                            source, source_job_id, canonical_url, apply_url, company, title,
                            normalized_title, location, remote_type, employment_type, posted_at,
                            posted_at_source, posted_at_confidence, first_seen_at, last_seen_at,
                            age_hours, freshness_bucket, description, ats_type, requirements,
                            preferred_requirements, keywords, content_hash, status,
                            min_amount, max_amount, currency,
                            is_observation_age, date_inconsistent, assessment_status
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, NOW(), NOW(),
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s, %s
                        ) RETURNING *;
                    """, (
                        job_data.get("source", "unknown"),
                        job_data.get("source_job_id"),
                        job_data["canonical_url"],
                        job_data.get("apply_url"),
                        job_data["company"],
                        job_data["title"],
                        job_data.get("normalized_title", job_data["title"]),
                        job_data["location"],
                        job_data.get("remote_type", "unknown"),
                        job_data.get("employment_type", "full_time"),
                        job_data.get("posted_at"),
                        job_data.get("posted_at_source"),
                        job_data.get("posted_at_confidence", 1.0),
                        job_data.get("age_hours", 0.0),
                        job_data.get("freshness_bucket", "HOT"),
                        job_data.get("description", ""),
                        job_data.get("ats_type"),
                        json.dumps(job_data.get("requirements", [])),
                        json.dumps(job_data.get("preferred_requirements", [])),
                        json.dumps(job_data.get("keywords", [])),
                        job_data["content_hash"],
                        job_data.get("status", "NEW"),
                        job_data.get("min_amount"),
                        job_data.get("max_amount"),
                        job_data.get("currency"),
                        bool(job_data.get("is_observation_age", False)),
                        bool(job_data.get("date_inconsistent", False)),
                        job_data.get("assessment_status", "ANALYSIS_PENDING")
                    ))
                    new_job = cur.fetchone()
                    job_id = new_job["job_id"]

                    # Add to job_sources
                    cur.execute("""
                        INSERT INTO job_sources (job_id, source_name, source_url, source_job_id, raw_payload)
                        VALUES (%s, %s, %s, %s, %s);
                    """, (
                        job_id,
                        source_data.get("source_name", "unknown"),
                        source_data.get("source_url", ""),
                        source_data.get("source_job_id"),
                        json.dumps(source_data.get("raw_payload", {}), default=str)
                    ))

                    # Add event
                    cur.execute("""
                        INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                        VALUES (%s, 'DISCOVERED', NULL, 'NEW', %s);
                    """, (job_id, json.dumps({"source": job_data.get("source")})))

                    conn.commit()
                    return new_job, True

    def get_jobs(
        self,
        freshness: Optional[str] = None,
        min_score: Optional[float] = None,
        status: Optional[str] = None,
        max_age_hours: Optional[float] = None,
        first_seen_since: Optional[datetime] = None,
        exclude_stale: bool = False,
        assessment_status: Optional[str] = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                query = f"""
                    SELECT j.*, fresh.age_hours, fresh.freshness_bucket, s.overall_score, s.recommendation,
                           s.strengths, s.gaps, s.evidence_fact_ids, s.keyword_coverage
                    FROM jobs j
                    {FRESHNESS_JOIN}
                    LEFT JOIN job_scores s ON j.job_id = s.job_id
                    WHERE 1=1
                """
                params = []
                if freshness:
                    query += " AND fresh.freshness_bucket = %s"
                    params.append(freshness)
                if min_score is not None:
                    query += " AND s.overall_score >= %s"
                    params.append(min_score)
                if status:
                    query += " AND j.status = %s"
                    params.append(status)
                if max_age_hours is not None:
                    query += " AND age.raw_age <= %s"
                    params.append(max_age_hours)
                if first_seen_since is not None:
                    query += " AND j.first_seen_at >= %s"
                    params.append(first_seen_since)
                if exclude_stale:
                    query += " AND age.raw_age <= 72.0"
                if assessment_status:
                    query += " AND j.assessment_status = %s"
                    params.append(assessment_status)

                query += " ORDER BY s.overall_score DESC NULLS LAST, j.posted_at DESC NULLS LAST LIMIT %s;"
                params.append(limit)

                cur.execute(query, params)
                return cur.fetchall()

    def get_job_by_id(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT j.*, fresh.age_hours, fresh.freshness_bucket, s.overall_score, s.recommendation, s.strengths, s.gaps, s.risks, s.evidence_fact_ids,
                           s.keyword_coverage,
                           s.role_alignment, s.experience_score, s.seniority_score, s.skills_score,
                           s.domain_score, s.location_score, s.comp_score, s.preference_score
                    FROM jobs j
                    {FRESHNESS_JOIN}
                    LEFT JOIN job_scores s ON j.job_id = s.job_id
                    WHERE j.job_id = %s;
                """, (job_id,))
                job = cur.fetchone()
                if not job:
                    return None

                # Fetch sources
                cur.execute("SELECT * FROM job_sources WHERE job_id = %s;", (job_id,))
                job["sources"] = cur.fetchall()

                # Fetch events
                cur.execute("SELECT * FROM job_events WHERE job_id = %s ORDER BY created_at DESC;", (job_id,))
                job["events"] = cur.fetchall()

                return job

    def save_job_score(self, job_id: str, score_data: Dict[str, Any], analysis_id: Optional[str] = None) -> Dict[str, Any]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # Serialize score-version allocation and workflow updates per job.
                cur.execute("SELECT status FROM jobs WHERE job_id = %s FOR UPDATE;", (job_id,))
                job_row = cur.fetchone()
                if not job_row:
                    raise ValueError(f"Job {job_id} not found.")
                current_status = job_row["status"]

                cur.execute("""
                    INSERT INTO job_scores (
                        job_id, overall_score, recommendation, role_alignment, experience_score,
                        seniority_score, skills_score, domain_score, location_score, comp_score,
                        preference_score, strengths, gaps, risks, evidence_fact_ids, keyword_coverage,
                        analysis_id, is_provisional, evidence_coverage, score_band,
                        factor_breakdown, uncertainties, scoring_version, scored_at
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, NOW()
                    )
                    ON CONFLICT (job_id) DO UPDATE SET
                        overall_score = EXCLUDED.overall_score,
                        recommendation = EXCLUDED.recommendation,
                        role_alignment = EXCLUDED.role_alignment,
                        experience_score = EXCLUDED.experience_score,
                        seniority_score = EXCLUDED.seniority_score,
                        skills_score = EXCLUDED.skills_score,
                        domain_score = EXCLUDED.domain_score,
                        location_score = EXCLUDED.location_score,
                        comp_score = EXCLUDED.comp_score,
                        preference_score = EXCLUDED.preference_score,
                        strengths = EXCLUDED.strengths,
                        gaps = EXCLUDED.gaps,
                        risks = EXCLUDED.risks,
                        evidence_fact_ids = EXCLUDED.evidence_fact_ids,
                        keyword_coverage = EXCLUDED.keyword_coverage,
                        analysis_id = EXCLUDED.analysis_id,
                        is_provisional = EXCLUDED.is_provisional,
                        evidence_coverage = EXCLUDED.evidence_coverage,
                        score_band = EXCLUDED.score_band,
                        factor_breakdown = EXCLUDED.factor_breakdown,
                        uncertainties = EXCLUDED.uncertainties,
                        scoring_version = EXCLUDED.scoring_version,
                        scored_at = NOW()
                    RETURNING *;
                """, (
                    job_id,
                    score_data["overall_score"],
                    score_data["recommendation"],
                    score_data.get("role_alignment", 0.0),
                    score_data.get("experience_score", 0.0),
                    score_data.get("seniority_score", 0.0),
                    score_data.get("skills_score", 0.0),
                    score_data.get("domain_score", 0.0),
                    score_data.get("location_score", 0.0),
                    score_data.get("comp_score", 0.0),
                    score_data.get("preference_score", 0.0),
                    json.dumps(score_data.get("strengths", [])),
                    json.dumps(score_data.get("gaps", [])),
                    json.dumps(score_data.get("risks", [])),
                    json.dumps(score_data.get("evidence_fact_ids", [])),
                    json.dumps(score_data.get("keyword_coverage"), default=str)
                    if score_data.get("keyword_coverage") is not None else None,
                    analysis_id or score_data.get("analysis_id"),
                    score_data.get("is_provisional", True),
                    score_data.get("evidence_coverage", 0.0),
                    score_data.get("score_band", "review"),
                    json.dumps(score_data.get("factor_breakdown", {}), default=str),
                    json.dumps(score_data.get("uncertainties", []), default=str),
                    score_data.get("scoring_version", "v2")
                ))
                saved_score = cur.fetchone()

                cur.execute("""
                    INSERT INTO job_score_versions (
                        job_id, version_number, analysis_id, score_data, scoring_version
                    )
                    SELECT %s, COALESCE(MAX(version_number), 0) + 1, %s, %s, %s
                    FROM job_score_versions
                    WHERE job_id = %s
                    RETURNING *;
                """, (
                    job_id,
                    analysis_id or score_data.get("analysis_id"),
                    json.dumps(score_data, default=str),
                    score_data.get("scoring_version", "v2"),
                    job_id,
                ))

                # Provisional scores are advisory and cannot advance or reject a
                # job in the human workflow.
                if not score_data.get("is_provisional", True) and current_status in ("NEW", "QUALIFIED", "REVIEW"):
                    if score_data["overall_score"] >= 85:
                        new_status = "QUALIFIED"
                    elif score_data["overall_score"] >= 75:
                        new_status = "REVIEW"
                    else:
                        new_status = "SKIPPED"

                    cur.execute("""
                        UPDATE jobs
                        SET status = %s, updated_at = NOW()
                        WHERE job_id = %s;
                    """, (new_status, job_id))

                    cur.execute("""
                        INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                        VALUES (%s, 'SCORED', %s, %s, %s);
                    """, (job_id, current_status, new_status, json.dumps({"score": score_data["overall_score"]})))

                # Update assessment status
                new_assessment = "SCORED" if not score_data.get("is_provisional", True) else "PROVISIONALLY_SCORED"
                cur.execute("""
                    UPDATE jobs
                    SET assessment_status = %s, updated_at = NOW()
                    WHERE job_id = %s;
                """, (new_assessment, job_id))

                conn.commit()
                return saved_score

    def record_agent_run(self, run_data: Dict[str, Any]) -> str:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO agent_runs (
                        run_type, start_time, end_time, sources_used, jobs_found, jobs_new,
                        jobs_duplicate, jobs_stale, jobs_scored, jobs_qualified, documents_generated,
                        errors, summary
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s
                    ) RETURNING id;
                """, (
                    run_data.get("run_type", "manual"),
                    run_data["start_time"],
                    run_data.get("end_time", datetime.now(timezone.utc)),
                    json.dumps(run_data.get("sources_used", [])),
                    run_data.get("jobs_found", 0),
                    run_data.get("jobs_new", 0),
                    run_data.get("jobs_duplicate", 0),
                    run_data.get("jobs_stale", 0),
                    run_data.get("jobs_scored", 0),
                    run_data.get("jobs_qualified", 0),
                    run_data.get("documents_generated", 0),
                    json.dumps(run_data.get("errors", [])),
                    json.dumps(run_data.get("summary", {}))
                ))
                run_id = cur.fetchone()["id"]
                conn.commit()
                return str(run_id)

    def get_agent_runs(self, limit: int = 10) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM agent_runs 
                    ORDER BY start_time DESC 
                    LIMIT %s;
                """, (limit,))
                return cur.fetchall()

    def update_job_status(self, job_id: str, new_status: str, details: Optional[Dict[str, Any]] = None) -> bool:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM jobs WHERE job_id = %s;", (job_id,))
                current = cur.fetchone()
                if not current:
                    return False
                old_status = current["status"]

                cur.execute("""
                    UPDATE jobs 
                    SET status = %s, updated_at = NOW() 
                    WHERE job_id = %s;
                """, (new_status, job_id))

                cur.execute("""
                    INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                    VALUES (%s, 'STATUS_CHANGE', %s, %s, %s);
                """, (job_id, old_status, new_status, json.dumps(details or {})))
                conn.commit()
                return True

    def start_agent_run(
        self,
        run_type: str,
        schedule_name: Optional[str] = None,
        sources_used: Optional[List[str]] = None
    ) -> str:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO agent_runs (
                        run_type, schedule_name, status, start_time, sources_used
                    ) VALUES (%s, %s, 'RUNNING', NOW(), %s)
                    RETURNING id;
                """, (
                    run_type,
                    schedule_name,
                    json.dumps(sources_used or [])
                ))
                run_id = cur.fetchone()["id"]
                conn.commit()
                return str(run_id)

    def finalize_agent_run(
        self,
        run_id: str,
        status: str,
        metrics: Optional[Dict[str, Any]] = None,
        errors: Optional[List[str]] = None,
        summary: Optional[Dict[str, Any]] = None,
        jobs_found: int = 0,
        jobs_new: int = 0,
        jobs_duplicate: int = 0,
        jobs_stale: int = 0,
        jobs_scored: int = 0,
        jobs_qualified: int = 0
    ) -> None:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE agent_runs
                    SET end_time = NOW(),
                        status = %s,
                        metrics = %s,
                        errors = %s,
                        summary = %s,
                        jobs_found = %s,
                        jobs_new = %s,
                        jobs_duplicate = %s,
                        jobs_stale = %s,
                        jobs_scored = %s,
                        jobs_qualified = %s
                    WHERE id = %s;
                """, (
                    status,
                    json.dumps(metrics or {}, default=str),
                    json.dumps(errors or [], default=str),
                    json.dumps(summary or {}, default=str),
                    jobs_found,
                    jobs_new,
                    jobs_duplicate,
                    jobs_stale,
                    jobs_scored,
                    jobs_qualified,
                    run_id
                ))
                conn.commit()

    def save_discovery_observation(self, run_id: str, obs: Dict[str, Any]) -> str:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO discovery_observations (
                        run_id, source_name, query, status, records_received,
                        records_normalized, records_rejected, errors, duration_ms
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id;
                """, (
                    run_id,
                    obs.get("source", "unknown"),
                    json.dumps(obs.get("query", {}), default=str),
                    obs.get("status", "success"),
                    obs.get("records_received", 0),
                    obs.get("records_normalized", 0),
                    obs.get("records_rejected", 0),
                    json.dumps(obs.get("errors", []), default=str),
                    obs.get("duration_ms", 0)
                ))
                obs_id = cur.fetchone()["id"]
                conn.commit()
                return str(obs_id)

    def get_discovery_observations(self, run_id: str) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM discovery_observations WHERE run_id = %s ORDER BY created_at ASC;", (run_id,))
                return cur.fetchall()

    def acquire_schedule_lock(self, schedule_name: str, run_id: str, ttl_seconds: int = 1800) -> bool:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # Clear expired locks
                cur.execute("DELETE FROM schedule_locks WHERE expires_at < NOW();")
                cur.execute("""
                    INSERT INTO schedule_locks (schedule_name, locked_at, locked_by, expires_at)
                    VALUES (%s, NOW(), %s, NOW() + interval '%s second')
                    ON CONFLICT (schedule_name) DO NOTHING
                    RETURNING locked_by;
                """, (schedule_name, run_id, ttl_seconds))
                row = cur.fetchone()
                if row:
                    conn.commit()
                    return True

                cur.execute("SELECT locked_by FROM schedule_locks WHERE schedule_name = %s;", (schedule_name,))
                existing = cur.fetchone()
                conn.commit()
                if existing and str(existing["locked_by"]) == str(run_id):
                    return True
                return False

    def release_schedule_lock(self, schedule_name: str, run_id: str) -> None:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    DELETE FROM schedule_locks
                    WHERE schedule_name = %s AND locked_by = %s;
                """, (schedule_name, run_id))
                conn.commit()

    def transition_job_workflow(
        self,
        job_id: str,
        next_state: str,
        actor: str = "human",
        reason: str = "",
        details: Optional[Dict[str, Any]] = None,
        human_confirmed: bool = False
    ) -> Tuple[bool, str]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM jobs WHERE job_id = %s FOR UPDATE;", (job_id,))
                row = cur.fetchone()
                if not row:
                    return False, f"Job {job_id} not found."
                current = row["status"]

                if current == next_state:
                    return True, f"Job already in state '{next_state}'."

                allowed = ALLOWED_WORKFLOW_TRANSITIONS.get(current, set())
                if next_state not in allowed:
                    return False, f"Illegal transition from '{current}' to '{next_state}'. Allowed: {sorted(allowed)}."

                if next_state == "READY":
                    cur.execute("""
                        SELECT approved_by_human FROM resume_versions
                        WHERE job_id = %s
                        ORDER BY version_number DESC
                        LIMIT 1;
                    """, (job_id,))
                    latest_resume = cur.fetchone()
                    if not latest_resume or not latest_resume["approved_by_human"]:
                        return False, "Cannot transition to READY without an approved resume version (latest version must be approved)."

                if next_state == "SUBMITTED":
                    if not human_confirmed:
                        return False, "Cannot transition to SUBMITTED without explicit human confirmation."

                cur.execute("""
                    UPDATE jobs
                    SET status = %s, updated_at = NOW()
                    WHERE job_id = %s;
                """, (next_state, job_id))

                cur.execute("""
                    INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                    VALUES (%s, 'WORKFLOW_TRANSITION', %s, %s, %s);
                """, (job_id, current, next_state, json.dumps({"actor": actor, "reason": reason, "details": details or {}})))

                conn.commit()
                return True, f"Transitioned from '{current}' to '{next_state}'."

    def save_job_analysis(
        self,
        job_id: str,
        jd_snapshot_id: str,
        candidate_snapshot_id: str,
        requirements: List[Dict[str, Any]],
        notes: str = "",
        created_by: str = "antigravity"
    ) -> Dict[str, Any]:
        canonical_reqs = [
            CanonicalRequirement.model_validate(requirement).model_dump()
            for requirement in requirements
        ]
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT job_id FROM jobs WHERE job_id = %s FOR UPDATE;", (job_id,))
                if not cur.fetchone():
                    raise ValueError(f"Job {job_id} not found.")

                cur.execute("""
                    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver
                    FROM job_analyses WHERE job_id = %s;
                """, (job_id,))
                next_ver = cur.fetchone()["next_ver"]

                cur.execute(
                    "SELECT id FROM jd_snapshots WHERE id = %s AND job_id = %s;",
                    (jd_snapshot_id, job_id),
                )
                if not cur.fetchone():
                    raise ValueError("JD snapshot does not belong to the requested job.")

                cur.execute(
                    "SELECT id FROM candidate_profile_snapshots WHERE id = %s;",
                    (candidate_snapshot_id,),
                )
                if not cur.fetchone():
                    raise ValueError("Candidate profile snapshot not found.")

                cur.execute("""
                    INSERT INTO job_analyses (
                        job_id, version_number, jd_snapshot_id, candidate_snapshot_id,
                        requirements, notes, created_by
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING *;
                """, (
                    job_id,
                    next_ver,
                    jd_snapshot_id,
                    candidate_snapshot_id,
                    json.dumps(canonical_reqs, default=str),
                    notes,
                    created_by
                ))
                saved = cur.fetchone()

                cur.execute("""
                    UPDATE jobs
                    SET assessment_status = 'ANALYZED', updated_at = NOW()
                    WHERE job_id = %s;
                """, (job_id,))

                conn.commit()
                return saved

    def get_job_analysis(self, job_id: str, version_number: Optional[int] = None) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                if version_number is not None:
                    cur.execute("SELECT * FROM job_analyses WHERE job_id = %s AND version_number = %s;", (job_id, version_number))
                else:
                    cur.execute("SELECT * FROM job_analyses WHERE job_id = %s ORDER BY version_number DESC LIMIT 1;", (job_id,))
                return cur.fetchone()

    def get_pending_analysis_jobs(self, limit: int = 10, min_score: Optional[float] = None) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                query = f"""
                    SELECT j.*, fresh.age_hours, fresh.freshness_bucket, s.overall_score, s.recommendation
                    FROM jobs j
                    {FRESHNESS_JOIN}
                    LEFT JOIN job_scores s ON j.job_id = s.job_id
                    WHERE j.assessment_status IN ('ANALYSIS_PENDING', 'PROVISIONALLY_SCORED')
                      AND j.status NOT IN ('SKIPPED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')
                """
                params = []
                if min_score is not None:
                    query += " AND s.overall_score >= %s"
                    params.append(min_score)
                query += " ORDER BY s.overall_score DESC NULLS LAST, j.first_seen_at DESC LIMIT %s;"
                params.append(limit)
                cur.execute(query, params)
                return cur.fetchall()

    def record_review_decision(
        self,
        job_id: str,
        decision: str,
        skip_reason: Optional[str] = None,
        notes: Optional[str] = None,
        deferred_until: Optional[datetime] = None,
        reviewer: str = "human"
    ) -> Dict[str, Any]:
        allowed_decisions = {"reviewed", "tailoring", "skipped", "deferred"}
        if decision not in allowed_decisions:
            raise ValueError(f"Invalid review decision '{decision}'.")
        if decision == "skipped" and not skip_reason:
            raise ValueError("A skip reason is required.")
        if decision == "deferred" and (deferred_until is None or deferred_until <= datetime.now(timezone.utc)):
            raise ValueError("A future deferred_until value is required.")
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM jobs WHERE job_id = %s FOR UPDATE", (job_id,))
                job = cur.fetchone()
                if not job:
                    raise ValueError(f"Job {job_id} not found.")
                next_state = {"reviewed": "REVIEWED", "tailoring": "TAILORING", "skipped": "SKIPPED"}.get(decision)
                if next_state and job["status"] != next_state:
                    allowed = ALLOWED_WORKFLOW_TRANSITIONS.get(job["status"], set())
                    if next_state not in allowed:
                        raise ValueError(f"Illegal transition from '{job['status']}' to '{next_state}'.")
                    cur.execute("UPDATE jobs SET status = %s, updated_at = NOW() WHERE job_id = %s", (next_state, job_id))
                    cur.execute("""
                        INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                        VALUES (%s, 'WORKFLOW_TRANSITION', %s, %s, %s)
                    """, (job_id, job["status"], next_state, json.dumps({"actor": reviewer, "reason": notes or skip_reason or decision})))
                cur.execute("""
                    INSERT INTO review_decisions (
                        job_id, decision, skip_reason, notes, deferred_until, reviewer
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING *;
                """, (job_id, decision, skip_reason, notes, deferred_until, reviewer))
                record = cur.fetchone()
                conn.commit()
                return record

    def get_shortlist(
        self,
        first_seen_since: Optional[datetime] = None,
        max_age_hours: Optional[float] = None,
        min_score: Optional[float] = None,
        limit: int = 10,
        exclude_skipped: bool = True,
        exclude_deferred: bool = True,
        include_provisional: bool = False,
        exclude_delivered: bool = True
    ) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE shortlist_reservations
                    SET status = 'EXPIRED'
                    WHERE status = 'RESERVED' AND expires_at < NOW();
                """)

                query = f"""
                    SELECT j.*, fresh.age_hours, fresh.freshness_bucket,
                           s.overall_score, s.recommendation, s.score_band, s.is_provisional,
                           s.evidence_coverage, s.strengths, s.gaps, s.risks, s.evidence_fact_ids,
                           s.keyword_coverage,
                           CASE WHEN s.score_band = 'exceptional' THEN 1
                                WHEN s.score_band = 'strong' THEN 2
                                WHEN s.score_band = 'review' THEN 3
                                ELSE 4 END AS tier_rank
                    FROM jobs j
                    {FRESHNESS_JOIN}
                    LEFT JOIN job_scores s ON j.job_id = s.job_id
                    WHERE 1=1
                """
                params = []
                if exclude_skipped:
                    query += " AND j.status NOT IN ('SKIPPED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')"
                if exclude_deferred:
                    query += """
                        AND NOT EXISTS (
                            SELECT 1 FROM review_decisions rd
                            WHERE rd.job_id = j.job_id AND rd.decision = 'deferred'
                              AND rd.deferred_until IS NOT NULL AND rd.deferred_until > NOW()
                        )
                    """
                if not include_provisional:
                    query += " AND s.is_provisional = FALSE AND j.assessment_status = 'SCORED'"
                if exclude_delivered:
                    query += """
                        AND NOT EXISTS (
                            SELECT 1 FROM shortlist_reservations sr
                            WHERE sr.job_id = j.job_id
                              AND (sr.status = 'ACKNOWLEDGED'
                                   OR (sr.status = 'RESERVED' AND sr.expires_at >= NOW()))
                        )
                    """
                if first_seen_since:
                    query += " AND j.first_seen_at >= %s"
                    params.append(first_seen_since)
                if max_age_hours is not None:
                    query += " AND age.raw_age <= %s"
                    params.append(max_age_hours)
                if min_score is not None:
                    query += " AND s.overall_score >= %s"
                    params.append(min_score)

                query += """
                    ORDER BY tier_rank ASC, s.overall_score DESC NULLS LAST, age.raw_age ASC, j.job_id ASC
                    LIMIT %s;
                """
                params.append(limit)
                cur.execute(query, params)
                return cur.fetchall()

    def reserve_shortlist(self, job_ids: List[str], batch_id: str, ttl_minutes: int = 30) -> List[str]:
        if ttl_minutes <= 0:
            raise ValueError("ttl_minutes must be positive.")
        if not job_ids:
            return []
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE shortlist_reservations
                    SET status = 'EXPIRED'
                    WHERE status = 'RESERVED' AND expires_at < NOW();
                """)
                cur.execute("""
                    INSERT INTO shortlist_reservations (
                        batch_id, job_id, reserved_at, expires_at, status
                    )
                    SELECT %s, requested.job_id, NOW(),
                           NOW() + make_interval(mins => %s), 'RESERVED'
                    FROM unnest(%s::uuid[]) AS requested(job_id)
                    WHERE NOT EXISTS (
                        SELECT 1 FROM shortlist_reservations existing
                        WHERE existing.job_id = requested.job_id
                          AND (existing.status = 'ACKNOWLEDGED'
                               OR (existing.status = 'RESERVED' AND existing.expires_at >= NOW()))
                    )
                    ON CONFLICT DO NOTHING
                    RETURNING job_id
                """, (batch_id, ttl_minutes, job_ids))
                reserved = [str(row["job_id"]) for row in cur.fetchall()]
                conn.commit()
        return reserved

    def acknowledge_shortlist_delivery(self, batch_id: str, job_ids: List[str]) -> int:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE shortlist_reservations
                    SET status = 'ACKNOWLEDGED', acknowledged_at = NOW()
                    WHERE batch_id = %s AND job_id = ANY(%s) AND status = 'RESERVED';
                """, (batch_id, job_ids))
                count = cur.rowcount
                conn.commit()
                return count

    def save_candidate_snapshot(self, candidate_id: str, profile_data: Dict[str, Any]) -> str:
        data_str = json.dumps(profile_data, sort_keys=True, default=str)
        s_hash = hashlib.sha256(data_str.encode("utf-8")).hexdigest()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO candidate_profile_snapshots (candidate_id, snapshot_hash, profile_data)
                    VALUES (%s, %s, %s)
                    RETURNING id;
                """, (candidate_id, s_hash, data_str))
                conn.commit()
                return str(cur.fetchone()["id"])

    def get_candidate_snapshot(self, snapshot_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM candidate_profile_snapshots WHERE id = %s", (snapshot_id,))
                return cur.fetchone()

    def save_jd_snapshot(self, job_id: str, raw_text: str, cleaned_text: str) -> str:
        c_hash = hashlib.sha256(cleaned_text.encode("utf-8")).hexdigest()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO jd_snapshots (job_id, content_hash, raw_text, cleaned_text)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (job_id, content_hash) DO NOTHING
                    RETURNING id;
                """, (job_id, c_hash, raw_text, cleaned_text))
                snapshot = cur.fetchone()
                if not snapshot:
                    cur.execute(
                        "SELECT id FROM jd_snapshots WHERE job_id = %s AND content_hash = %s;",
                        (job_id, c_hash),
                    )
                    snapshot = cur.fetchone()
                conn.commit()
                if not snapshot:
                    raise RuntimeError("JD snapshot conflict could not be resolved.")
                return str(snapshot["id"])

    def get_jd_snapshot(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM jd_snapshots WHERE job_id = %s ORDER BY created_at DESC LIMIT 1;
                """, (job_id,))
                return cur.fetchone()

    def get_jd_snapshot_by_hash(self, job_id: str, content_hash: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM jd_snapshots
                    WHERE job_id = %s AND content_hash = %s;
                """, (job_id, content_hash))
                return cur.fetchone()

    def save_job_requirements(self, job_id: str, requirements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM job_requirements WHERE job_id = %s;", (job_id,))
                saved = []
                for req in requirements:
                    cur.execute("""
                        INSERT INTO job_requirements (
                            job_id, requirement_id, jd_quote, description, requirement_type,
                            classification, is_required, matched_fact_ids, omitted_from_base_resume,
                            match_status, analysis_notes
                        ) VALUES (
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s
                        ) RETURNING *;
                    """, (
                        job_id,
                        req.get("requirement_id"),
                        req.get("jd_quote", ""),
                        req.get("description", req.get("jd_quote", "")),
                        req.get("requirement_type", "required"),
                        req.get("classification", "general"),
                        req.get("is_required", True),
                        json.dumps(req.get("matched_fact_ids", [])),
                        req.get("omitted_from_base_resume", False),
                        req.get("status", "unsupported"),
                        req.get("analysis_notes", "")
                    ))
                    saved.append(cur.fetchone())
                conn.commit()
                return saved

    def get_job_requirements(self, job_id: str) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM job_requirements WHERE job_id = %s ORDER BY created_at ASC;
                """, (job_id,))
                return cur.fetchall()

    def save_resume_version(self, data: Dict[str, Any]) -> Dict[str, Any]:
        actual_hash = hashlib.sha256(data["tailored_text"].strip().encode("utf-8")).hexdigest()
        if data["content_hash"] != actual_hash:
            raise ValueError("Content hash mismatch for supplied resume text.")
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # Serialize allocation per job; different jobs remain independent.
                cur.execute("SELECT job_id FROM jobs WHERE job_id = %s FOR UPDATE", (data["job_id"],))
                if not cur.fetchone():
                    raise ValueError("Job not found.")
                cur.execute("SELECT id FROM resume_versions WHERE job_id = %s ORDER BY version_number DESC, created_at DESC LIMIT 1", (data["job_id"],))
                parent = cur.fetchone()
                cur.execute("""
                    SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver
                    FROM resume_versions WHERE job_id = %s;
                """, (data["job_id"],))
                next_ver = cur.fetchone()["next_ver"]

                cur.execute("""
                    INSERT INTO resume_versions (
                        job_id, application_id, base_version, version_number, parent_version_id,
                        content_hash, tailored_text, structured_content, claim_evidence_map,
                        fact_ids_used, diff_summary, validation_status, validation_report,
                        html_path, pdf_path, approved_by_human,
                        profile_snapshot_id, jd_snapshot_id, baseline_text,
                        requirements_snapshot, analysis_id,
                        template_id, template_version, template_hash,
                        render_schema_version, ranking_policy_version,
                        keyword_plan, keyword_coverage_report, summary_derivation
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s
                    ) RETURNING *;
                """, (
                    data["job_id"],
                    data.get("application_id"),
                    data.get("base_version", "canonical_v1"),
                    next_ver,
                    parent["id"] if parent else None,
                    data["content_hash"],
                    data["tailored_text"],
                    json.dumps(data.get("structured_content", {}), default=str),
                    json.dumps(data.get("claim_evidence_map", []), default=str),
                    json.dumps(data.get("fact_ids_used", []), default=str),
                    data.get("diff_summary", ""),
                    data.get("validation_status", "DRAFT"),
                    json.dumps(data.get("validation_report", {}), default=str),
                    data.get("html_path"),
                    data.get("pdf_path"),
                    False,
                    data.get("profile_snapshot_id"), data.get("jd_snapshot_id"),
                    data.get("baseline_text"), json.dumps(data.get("requirements_snapshot", []), default=str),
                    data.get("analysis_id"),
                    data.get("template_id"), data.get("template_version"),
                    data.get("template_hash"), data.get("render_schema_version", "v1"),
                    data.get("ranking_policy_version"),
                    json.dumps(data.get("keyword_plan", {}), default=str),
                    json.dumps(data.get("keyword_coverage_report", {}), default=str),
                    json.dumps(data.get("summary_derivation", {}), default=str),
                ))
                saved = cur.fetchone()

                cur.execute("""
                    INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                    VALUES (%s, 'RESUME_VERSION_CREATED', NULL, %s, %s);
                """, (data["job_id"], saved["validation_status"], json.dumps({"version": next_ver, "hash": data["content_hash"]})))

                conn.commit()
                return saved

    def update_resume_validation(
        self,
        resume_id: str,
        status: str,
        report: Dict[str, Any],
        html_path: Optional[str] = None,
        pdf_path: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        if status not in {"AWAITING_HUMAN_REVIEW", "FAILED"}:
            raise ValueError("Unsupported validation transition.")
        pdf_hash = html_hash = None
        if status == "AWAITING_HUMAN_REVIEW":
            if not pdf_path or not html_path or not report.get("is_valid"):
                raise ValueError("Validated HTML and PDF artifacts are required.")
            pdf_hash = hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()
            html_hash = hashlib.sha256(Path(html_path).read_bytes()).hexdigest()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE resume_versions
                    SET validation_status = %s,
                        validation_report = %s,
                        html_path = COALESCE(%s, html_path),
                        pdf_path = COALESCE(%s, pdf_path),
                        pdf_hash = %s, html_hash = %s
                    WHERE id = %s AND approved_by_human = FALSE
                      AND validation_status = 'VALIDATED'
                    RETURNING *;
                """, (status, json.dumps(report, default=str), html_path, pdf_path, pdf_hash, html_hash, resume_id))
                updated = cur.fetchone()
                if updated:
                    cur.execute("""
                        INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                        VALUES (%s, 'RESUME_VALIDATED', NULL, %s, %s);
                    """, (updated["job_id"], status, json.dumps({"resume_id": resume_id, "status": status})))
                    conn.commit()
                return updated

    def confirm_human_approval(self, resume_id: str, expected_hash: str, reviewer: str = "human", *, human_confirmed: bool = False) -> tuple[bool, str]:
        # Only the local interactive review entrypoint may attest confirmation.
        # A content digest is an integrity check, not authentication or consent.
        if not human_confirmed:
            return False, "Explicit human confirmation through the local review CLI is required."
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM resume_versions WHERE id = %s FOR UPDATE;", (resume_id,))
                record = cur.fetchone()
                if not record:
                    return False, f"Resume version {resume_id} not found."
                
                if record["content_hash"] != expected_hash:
                    return False, f"Content hash mismatch. Expected: {expected_hash}, Actual in DB: {record['content_hash']}. Document was modified."

                if record["validation_status"] != "AWAITING_HUMAN_REVIEW":
                    return False, f"Cannot approve resume with validation status '{record['validation_status']}'."

                actual_hash = hashlib.sha256(record["tailored_text"].strip().encode("utf-8")).hexdigest()
                if actual_hash != expected_hash:
                    return False, "Stored resume text was modified."
                for kind in ("pdf", "html"):
                    try:
                        digest = hashlib.sha256(Path(record[f"{kind}_path"]).read_bytes()).hexdigest()
                    except (OSError, TypeError):
                        return False, f"Missing {kind} artifact."
                    if not record.get(f"{kind}_hash") or digest != record[f"{kind}_hash"]:
                        return False, f"Modified {kind} artifact."

                sig = hashlib.sha256(f"{resume_id}:{expected_hash}:{reviewer}".encode("utf-8")).hexdigest()

                cur.execute("""
                    UPDATE resume_versions
                    SET approved_by_human = TRUE,
                        validation_status = 'APPROVED',
                        human_approved_at = NOW(),
                        human_reviewer = %s,
                        approval_signature = %s
                    WHERE id = %s
                    RETURNING *;
                """, (reviewer, sig, resume_id))
                
                cur.execute("""
                    INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                    VALUES (%s, 'RESUME_APPROVED', 'AWAITING_HUMAN_REVIEW', 'APPROVED', %s);
                """, (record["job_id"], json.dumps({"resume_id": resume_id, "reviewer": reviewer, "signature": sig})))
                
                cur.execute("""
                    INSERT INTO review_events (entity_type, entity_id, decision, notes, reviewer)
                    VALUES ('resume', %s, 'approved', 'Explicit human review confirmed with hash match', %s);
                """, (resume_id, reviewer))

                conn.commit()
                return True, sig

    def get_resume_version(self, resume_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM resume_versions WHERE id = %s;", (resume_id,))
                return cur.fetchone()

    def get_latest_resume_for_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM resume_versions WHERE job_id = %s ORDER BY version_number DESC LIMIT 1;
                """, (job_id,))
                return cur.fetchone()

    def get_resume_for_job(self, job_id: str, version_number: int) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM resume_versions WHERE job_id = %s AND version_number = %s", (job_id, version_number))
                return cur.fetchone()

    # -------------------------------------------------------------
    # WORDING VARIANTS (MILESTONE 8)
    # -------------------------------------------------------------
    def propose_wording_variant(
        self,
        candidate_id: str,
        fact_ids: List[str],
        variant_text: str,
        normalized_keywords: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Record an agent/human-proposed reusable wording. Never approved here."""
        if not fact_ids or not str(variant_text or "").strip():
            raise ValueError("Variant requires fact_ids and nonempty text.")
        content_hash = hashlib.sha256(variant_text.strip().encode("utf-8")).hexdigest()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO candidate_wording_variants (
                        candidate_id, fact_ids, variant_text,
                        normalized_keywords, content_hash, review_status
                    ) VALUES (%s, %s, %s, %s, %s, 'proposed')
                    RETURNING *;
                """, (
                    candidate_id,
                    json.dumps(list(fact_ids)),
                    variant_text.strip(),
                    json.dumps(list(normalized_keywords or [])),
                    content_hash,
                ))
                saved = cur.fetchone()
                conn.commit()
                return saved

    def list_wording_variants(
        self, candidate_id: str, status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                if status:
                    cur.execute("""
                        SELECT * FROM candidate_wording_variants
                        WHERE candidate_id = %s AND review_status = %s
                        ORDER BY created_at DESC;
                    """, (candidate_id, status))
                else:
                    cur.execute("""
                        SELECT * FROM candidate_wording_variants
                        WHERE candidate_id = %s ORDER BY created_at DESC;
                    """, (candidate_id,))
                return list(cur.fetchall())

    def get_wording_variant(self, variant_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM candidate_wording_variants WHERE id = %s;", (variant_id,))
                return cur.fetchone()

    def get_approved_variants(self, candidate_id: str) -> List[Dict[str, Any]]:
        return self.list_wording_variants(candidate_id, status="approved")

    def approve_wording_variant(
        self, variant_id: str, reviewer: str = "human", *, human_confirmed: bool = False
    ) -> Tuple[bool, str]:
        """Human-only approval of reusable wording. Requires explicit local consent."""
        if not human_confirmed:
            return False, "Explicit human confirmation through the local review CLI is required."
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM candidate_wording_variants WHERE id = %s FOR UPDATE;", (variant_id,))
                record = cur.fetchone()
                if not record:
                    return False, f"Wording variant {variant_id} not found."
                if record["review_status"] == "approved":
                    return False, "Variant is already approved."
                actual = hashlib.sha256(str(record["variant_text"]).strip().encode("utf-8")).hexdigest()
                if actual != record["content_hash"]:
                    return False, "Stored variant text was modified."
                cur.execute("""
                    UPDATE candidate_wording_variants
                    SET review_status = 'approved', reviewer = %s, reviewed_at = NOW()
                    WHERE id = %s AND review_status = 'proposed'
                    RETURNING *;
                """, (reviewer, variant_id))
                updated = cur.fetchone()
                if not updated:
                    return False, "Variant status changed during review."
                conn.commit()
                return True, str(updated["id"])

    # -------------------------------------------------------------
    # APPLICATION COPILOT & SESSION MANAGEMENT (MILESTONE 3)
    # -------------------------------------------------------------
    def get_application_by_job_id(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM applications WHERE job_id = %s;", (job_id,))
                return cur.fetchone()

    def get_application_by_id(self, application_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM applications WHERE id = %s;", (application_id,))
                return cur.fetchone()

    def create_or_get_application(
        self,
        job_id: str,
        resume_version_id: str,
        content_hash: str,
        pdf_hash: str,
        analysis_id: Optional[str],
        application_url: str,
        ats_type: Optional[str] = None
    ) -> Tuple[Dict[str, Any], bool]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT job_id FROM jobs WHERE job_id = %s FOR UPDATE;", (job_id,))
                if not cur.fetchone():
                    raise ValueError(f"Job '{job_id}' not found.")
                cur.execute("SELECT * FROM applications WHERE job_id = %s FOR UPDATE;", (job_id,))
                existing = cur.fetchone()
                if existing:
                    expected_binding = {
                        "resume_version_id": resume_version_id,
                        "resume_content_hash": content_hash,
                        "resume_pdf_hash": pdf_hash,
                        "analysis_id": analysis_id,
                        "application_url": application_url,
                    }
                    mismatches = [
                        key for key, expected in expected_binding.items()
                        if str(existing.get(key) or "") != str(expected or "")
                    ]
                    if mismatches:
                        raise ValueError(
                            "Existing application binding differs from the current approved package: "
                            + ", ".join(mismatches)
                        )
                    return existing, False

                cur.execute("""
                    INSERT INTO applications (
                        job_id, status, resume_version_id, resume_content_hash,
                        resume_pdf_hash, analysis_id, application_url, ats_detected
                    ) VALUES (%s, 'DRAFT', %s, %s, %s, %s, %s, %s)
                    RETURNING *;
                """, (job_id, resume_version_id, content_hash, pdf_hash, analysis_id, application_url, ats_type))
                new_app = cur.fetchone()

                cur.execute("""
                    INSERT INTO application_events (application_id, event_type, from_status, to_status, actor, reason, details)
                    VALUES (%s, 'APPLICATION_CREATED', NULL, 'DRAFT', 'copilot', 'Bound to approved resume version', %s);
                """, (new_app["id"], json.dumps({"resume_version_id": resume_version_id, "pdf_hash": pdf_hash})))
                conn.commit()
                return new_app, True

    def create_application_attempt(
        self,
        application_id: str,
        idempotency_key: str,
        stage_label: str = "initial",
        current_page_url: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Tuple[Dict[str, Any], bool]:
        if not idempotency_key or len(idempotency_key) > 100:
            raise ValueError("idempotency_key must contain 1 to 100 characters.")
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM applications WHERE id = %s FOR UPDATE;", (application_id,))
                application = cur.fetchone()
                if not application:
                    raise ValueError(f"Application '{application_id}' not found.")
                if application["status"] == "SUBMITTED_CONFIRMED":
                    raise ValueError("Cannot create an attempt for a submitted application.")
                cur.execute("""
                    SELECT * FROM application_attempts
                    WHERE application_id = %s AND idempotency_key = %s
                    FOR UPDATE;
                """, (application_id, idempotency_key))
                existing = cur.fetchone()
                if existing:
                    return existing, False

                cur.execute("""
                    SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_num
                    FROM application_attempts
                    WHERE application_id = %s;
                """, (application_id,))
                next_num = cur.fetchone()["next_num"]

                cur.execute("""
                    INSERT INTO application_attempts (
                        application_id, attempt_number, idempotency_key, status,
                        stage_label, current_page_url, metadata
                    ) VALUES (%s, %s, %s, 'CREATED', %s, %s, %s)
                    RETURNING *;
                """, (application_id, next_num, idempotency_key, stage_label, current_page_url, json.dumps(metadata or {})))
                attempt = cur.fetchone()

                cur.execute("""
                    INSERT INTO application_events (application_id, attempt_id, event_type, from_status, to_status, actor, details)
                    VALUES (%s, %s, 'ATTEMPT_STARTED', NULL, 'CREATED', 'copilot', %s);
                """, (application_id, attempt["id"], json.dumps({"attempt_number": next_num, "idempotency_key": idempotency_key})))
                conn.commit()
                return attempt, True

    def get_application_attempt(self, attempt_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM application_attempts WHERE id = %s;", (attempt_id,))
                return cur.fetchone()

    def get_latest_attempt(self, application_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM application_attempts
                    WHERE application_id = %s
                    ORDER BY attempt_number DESC LIMIT 1;
                """, (application_id,))
                return cur.fetchone()

    def transition_application_state(
        self,
        application_id: str,
        to_status: str,
        actor: str = "copilot",
        reason: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        attempt_id: Optional[str] = None
    ) -> Tuple[bool, str]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM applications WHERE id = %s FOR UPDATE;", (application_id,))
                row = cur.fetchone()
                if not row:
                    return False, f"Application '{application_id}' not found."
                current = row["status"]
                if current == to_status:
                    return True, f"Application already in status '{to_status}'."

                allowed = ALLOWED_APPLICATION_TRANSITIONS.get(current, set())
                if to_status not in allowed:
                    return False, f"Illegal application transition from '{current}' to '{to_status}'. Allowed: {sorted(allowed)}."

                cur.execute("""
                    UPDATE applications
                    SET status = %s, updated_at = NOW()
                    WHERE id = %s;
                """, (to_status, application_id))

                cur.execute("""
                    INSERT INTO application_events (
                        application_id, attempt_id, event_type, from_status, to_status, actor, reason, details
                    ) VALUES (%s, %s, 'STATE_TRANSITION', %s, %s, %s, %s, %s);
                """, (application_id, attempt_id, current, to_status, actor, reason, json.dumps(details or {})))
                conn.commit()
                return True, f"Application transitioned to '{to_status}'."

    def transition_attempt_state(
        self,
        attempt_id: str,
        to_status: str,
        stage_label: Optional[str] = None,
        current_page_url: Optional[str] = None,
        error_summary: Optional[str] = None
    ) -> Tuple[bool, str]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM application_attempts WHERE id = %s FOR UPDATE;", (attempt_id,))
                row = cur.fetchone()
                if not row:
                    return False, f"Attempt '{attempt_id}' not found."
                current = row["status"]
                if current == to_status:
                    return True, f"Attempt already in status '{to_status}'."

                allowed = ALLOWED_ATTEMPT_TRANSITIONS.get(current, set())
                if to_status not in allowed:
                    return False, f"Illegal attempt transition from '{current}' to '{to_status}'. Allowed: {sorted(allowed)}."

                ended_at = datetime.now(timezone.utc) if to_status in ("COMPLETED_WITHOUT_SUBMISSION", "INTERRUPTED", "FAILED") else None

                cur.execute("""
                    UPDATE application_attempts
                    SET status = %s,
                        stage_label = COALESCE(%s, stage_label),
                        current_page_url = COALESCE(%s, current_page_url),
                        error_summary = COALESCE(%s, error_summary),
                        ended_at = COALESCE(%s, ended_at),
                        updated_at = NOW()
                    WHERE id = %s;
                """, (to_status, stage_label, current_page_url, error_summary, ended_at, attempt_id))

                cur.execute("""
                    INSERT INTO application_events (
                        application_id, attempt_id, event_type, from_status, to_status, actor, reason, details
                    ) VALUES (%s, %s, 'ATTEMPT_TRANSITION', %s, %s, 'copilot', %s, %s);
                """, (row["application_id"], attempt_id, current, to_status, error_summary, json.dumps({"stage": stage_label})))
                conn.commit()
                return True, f"Attempt transitioned to '{to_status}'."

    def save_form_snapshot(
        self,
        attempt_id: str,
        page_url: str,
        form_fingerprint: str,
        fields_metadata: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO form_snapshots (attempt_id, page_url, form_fingerprint, fields_metadata)
                    VALUES (%s, %s, %s, %s)
                    RETURNING *;
                """, (attempt_id, page_url, form_fingerprint, json.dumps(fields_metadata, default=str)))
                snapshot = cur.fetchone()
                conn.commit()
                return snapshot

    def get_form_snapshot(self, snapshot_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM form_snapshots WHERE id = %s;", (snapshot_id,))
                return cur.fetchone()

    def get_latest_form_snapshot(self, attempt_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM form_snapshots
                    WHERE attempt_id = %s
                    ORDER BY captured_at DESC LIMIT 1;
                """, (attempt_id,))
                return cur.fetchone()

    def save_field_plan(
        self,
        attempt_id: str,
        form_snapshot_id: str,
        fields: List[Dict[str, Any]],
        validation_status: str,
        validation_errors: List[str]
    ) -> Dict[str, Any]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO field_plans (attempt_id, form_snapshot_id, fields, validation_status, validation_errors)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING *;
                """, (attempt_id, form_snapshot_id, json.dumps(fields, default=str), validation_status, json.dumps(validation_errors)))
                plan = cur.fetchone()
                conn.commit()
                return plan

    def get_latest_validated_field_plan(
        self,
        attempt_id: str,
        form_snapshot_id: str,
    ) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM field_plans
                    WHERE attempt_id = %s
                      AND form_snapshot_id = %s
                      AND validation_status = 'VALIDATED'
                    ORDER BY created_at DESC, id DESC
                    LIMIT 1;
                """, (attempt_id, form_snapshot_id))
                return cur.fetchone()

    def record_fill_actions(
        self,
        attempt_id: str,
        form_snapshot_id: str,
        field_plan_id: str,
        actions: List[Dict[str, Any]]
    ) -> int:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id FROM field_plans
                    WHERE id = %s AND attempt_id = %s AND form_snapshot_id = %s
                      AND validation_status = 'VALIDATED'
                    FOR SHARE;
                """, (field_plan_id, attempt_id, form_snapshot_id))
                if not cur.fetchone():
                    raise ValueError("Actions must reference the matching validated field plan.")
                count = 0
                for act in actions:
                    val_hash = act.get("value_hash")
                    redacted = act.get("redacted_value")
                    if not val_hash and act.get("value"):
                        val_hash = hashlib.sha256(str(act["value"]).encode("utf-8")).hexdigest()
                        redacted = str(act["value"])[:3] + "***" if len(str(act["value"])) > 3 else "***"

                    cur.execute("""
                        INSERT INTO application_fill_actions (
                            attempt_id, form_snapshot_id, field_plan_id, idempotency_key,
                            field_key, action_type, value_hash, redacted_value, status, error_message
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (attempt_id, idempotency_key) DO NOTHING;
                    """, (
                        attempt_id,
                        form_snapshot_id,
                        field_plan_id,
                        act["idempotency_key"],
                        act["field_key"],
                        act["action_type"],
                        val_hash,
                        redacted,
                        act.get("status", "SUCCESS"),
                        act.get("error_message")
                    ))
                    count += cur.rowcount
                conn.commit()
                return count

    def save_application_checkpoint(
        self,
        application_id: str,
        attempt_id: str,
        idempotency_key: str,
        stage: str,
        page_url: str,
        blockers: List[str],
        next_action: str,
        human_checklist: List[Dict[str, Any]],
        application_status: str,
        snapshot_metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        if not idempotency_key or len(idempotency_key) > 100:
            raise ValueError("idempotency_key must contain 1 to 100 characters.")
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status, job_id FROM applications WHERE id = %s FOR UPDATE;", (application_id,))
                application = cur.fetchone()
                if not application:
                    raise ValueError(f"Application '{application_id}' not found.")
                cur.execute("SELECT * FROM application_attempts WHERE id = %s FOR UPDATE;", (attempt_id,))
                attempt = cur.fetchone()
                if not attempt or str(attempt["application_id"]) != str(application_id):
                    raise ValueError("Attempt does not belong to the application.")

                cur.execute("""
                    SELECT * FROM application_checkpoints
                    WHERE application_id = %s AND idempotency_key = %s;
                """, (application_id, idempotency_key))
                existing = cur.fetchone()
                if existing:
                    return existing

                current_attempt = attempt["status"]
                if current_attempt != "CHECKPOINTED":
                    allowed_attempt = ALLOWED_ATTEMPT_TRANSITIONS.get(current_attempt, set())
                    if "CHECKPOINTED" not in allowed_attempt:
                        raise ValueError(f"Attempt cannot checkpoint from '{current_attempt}'.")

                current_application = application["status"]
                if current_application != application_status:
                    allowed_application = ALLOWED_APPLICATION_TRANSITIONS.get(current_application, set())
                    if application_status not in allowed_application:
                        raise ValueError(
                            f"Application cannot transition from '{current_application}' to '{application_status}'."
                        )

                cur.execute("""
                    INSERT INTO application_checkpoints (
                        application_id, attempt_id, idempotency_key, stage, page_url, blockers,
                        next_action, human_checklist, snapshot_metadata
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *;
                """, (
                    application_id,
                    attempt_id,
                    idempotency_key,
                    stage,
                    page_url,
                    json.dumps(blockers),
                    next_action,
                    json.dumps(human_checklist, default=str),
                    json.dumps(snapshot_metadata or {}, default=str)
                ))
                checkpoint = cur.fetchone()

                if current_attempt != "CHECKPOINTED":
                    cur.execute("""
                        UPDATE application_attempts
                        SET status = 'CHECKPOINTED', stage_label = %s,
                            current_page_url = %s, updated_at = NOW()
                        WHERE id = %s;
                    """, (stage, page_url, attempt_id))
                    cur.execute("""
                        INSERT INTO application_events (
                            application_id, attempt_id, event_type, from_status,
                            to_status, actor, reason, details
                        ) VALUES (%s, %s, 'ATTEMPT_TRANSITION', %s,
                                  'CHECKPOINTED', 'copilot', %s, %s);
                    """, (
                        application_id, attempt_id, current_attempt, next_action,
                        json.dumps({"stage": stage}),
                    ))

                if current_application != application_status:
                    cur.execute("""
                        UPDATE applications SET status = %s, updated_at = NOW()
                        WHERE id = %s;
                    """, (application_status, application_id))
                    cur.execute("""
                        INSERT INTO application_events (
                            application_id, attempt_id, event_type, from_status,
                            to_status, actor, reason, details
                        ) VALUES (%s, %s, 'STATE_TRANSITION', %s, %s,
                                  'copilot', %s, %s);
                    """, (
                        application_id, attempt_id, current_application,
                        application_status, next_action,
                        json.dumps({"stage": stage, "blockers": blockers}),
                    ))

                cur.execute("SELECT status FROM jobs WHERE job_id = %s FOR UPDATE;", (application["job_id"],))
                job = cur.fetchone()
                if job and job["status"] == "APPLICATION_STARTED":
                    cur.execute("UPDATE jobs SET status = 'WAITING_FOR_HUMAN', updated_at = NOW() WHERE job_id = %s;", (application["job_id"],))
                    cur.execute("""
                        INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                        VALUES (%s, 'WORKFLOW_TRANSITION', 'APPLICATION_STARTED',
                                'WAITING_FOR_HUMAN', %s);
                    """, (
                        application["job_id"],
                        json.dumps({"actor": "copilot", "reason": "Application checkpoint created"}),
                    ))

                cur.execute("""
                    INSERT INTO application_events (
                        application_id, attempt_id, event_type, from_status, to_status, actor, reason, details
                    ) VALUES (%s, %s, 'CHECKPOINT_CREATED', NULL, NULL, 'copilot', %s, %s);
                """, (application_id, attempt_id, next_action, json.dumps({"stage": stage, "blockers": blockers})))
                conn.commit()
                return checkpoint

    def get_latest_checkpoint(self, application_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM application_checkpoints
                    WHERE application_id = %s
                    ORDER BY created_at DESC LIMIT 1;
                """, (application_id,))
                return cur.fetchone()

    def record_human_submission(
        self,
        application_id: str,
        reviewer: str,
        notes: Optional[str] = None,
        reference_number: Optional[str] = None,
        *,
        human_confirmed: bool = False
    ) -> Tuple[bool, str]:
        if not human_confirmed:
            return False, "Explicit human confirmation through the local CLI is required to record submission."
        if not reviewer or not reviewer.strip():
            return False, "Reviewer identity is required."

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM applications WHERE id = %s FOR UPDATE;", (application_id,))
                app = cur.fetchone()
                if not app:
                    return False, f"Application '{application_id}' not found."
                if app["status"] == "SUBMITTED_CONFIRMED":
                    return True, "Application was already recorded as submitted."
                if app["status"] not in {"NEEDS_HUMAN_INPUT", "READY_FOR_HUMAN_REVIEW", "HUMAN_COMPLETING"}:
                    return False, "A persisted human-review checkpoint is required before recording submission."

                cur.execute("""
                    SELECT id FROM application_checkpoints
                    WHERE application_id = %s
                    ORDER BY created_at DESC LIMIT 1;
                """, (application_id,))
                if not cur.fetchone():
                    return False, "A persisted human-review checkpoint is required before recording submission."

                # Verify resume artifact integrity
                cur.execute("SELECT * FROM resume_versions WHERE id = %s;", (app["resume_version_id"],))
                resume = cur.fetchone()
                if not resume:
                    return False, "Bound resume version not found."
                if not resume["approved_by_human"] or str(resume["job_id"]) != str(app["job_id"]):
                    return False, "Bound resume is not an approved artifact for this job."
                if resume["content_hash"] != app["resume_content_hash"] or resume["pdf_hash"] != app["resume_pdf_hash"]:
                    return False, "Bound resume ledger no longer matches the application binding."

                actual_text_hash = hashlib.sha256(resume["tailored_text"].strip().encode("utf-8")).hexdigest()
                if actual_text_hash != app["resume_content_hash"]:
                    return False, "Bound resume content hash mismatch; integrity compromised."

                # Verify PDF digest
                try:
                    actual_pdf_hash = hashlib.sha256(Path(resume["pdf_path"]).read_bytes()).hexdigest()
                    if actual_pdf_hash != app["resume_pdf_hash"]:
                        return False, "Bound resume PDF hash mismatch."
                except Exception as e:
                    return False, f"Cannot verify bound PDF artifact: {e}"

                cur.execute("SELECT status FROM jobs WHERE job_id = %s FOR UPDATE;", (app["job_id"],))
                job = cur.fetchone()
                if not job:
                    return False, "Bound job not found."
                if job["status"] == "SUBMITTED":
                    return False, "Job is already submitted but the application audit is inconsistent."
                if "SUBMITTED" not in ALLOWED_WORKFLOW_TRANSITIONS.get(job["status"], set()):
                    return False, f"Job cannot transition to SUBMITTED from '{job['status']}'."

                previous_application_status = app["status"]
                cur.execute("""
                    UPDATE applications
                    SET status = 'SUBMITTED_CONFIRMED',
                        applied_at = NOW(),
                        notes = COALESCE(%s, notes),
                        updated_at = NOW()
                    WHERE id = %s;
                """, (notes, application_id))

                cur.execute("UPDATE jobs SET status = 'SUBMITTED', updated_at = NOW() WHERE job_id = %s;", (app["job_id"],))
                cur.execute("""
                    INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                    VALUES (%s, 'WORKFLOW_TRANSITION', %s, 'SUBMITTED', %s);
                """, (
                    app["job_id"],
                    job["status"],
                    json.dumps({
                        "actor": reviewer,
                        "reason": "Human-confirmed external submission",
                        "application_id": application_id,
                        "reference_number": reference_number,
                    }),
                ))

                cur.execute("""
                    UPDATE application_attempts
                    SET status = 'COMPLETED_WITHOUT_SUBMISSION', ended_at = NOW(), updated_at = NOW()
                    WHERE application_id = %s AND status = 'CHECKPOINTED';
                """, (application_id,))

                # Add application event
                cur.execute("""
                    INSERT INTO application_events (
                        application_id, event_type, from_status, to_status, actor, reason, details
                    ) VALUES (%s, 'SUBMITTED_CONFIRMED', %s, 'SUBMITTED_CONFIRMED', %s, %s, %s);
                """, (
                    application_id,
                    previous_application_status,
                    reviewer,
                    f"Human confirmed external submission. Reference: {reference_number or 'None'}",
                    json.dumps({"notes": notes, "reference_number": reference_number})
                ))
                conn.commit()
                return True, "Application successfully recorded as submitted."

    # -------------------------------------------------------------
    # PREPARATION REQUEST METHODS (MILESTONE 4)
    # -------------------------------------------------------------
    def create_preparation_request(
        self,
        job_id: str,
        idempotency_key: str,
        requested_by: str = "antigravity",
        briefing_id: Optional[str] = None
    ) -> Tuple[Dict[str, Any], bool]:
        """
        Idempotently create or retrieve a preparation request for a job.
        Enforces UNIQUE (job_id, idempotency_key).
        Returns (record, is_new).
        """
        if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 100:
            raise ValueError("idempotency_key must contain 1 to 100 non-whitespace characters.")
        if not isinstance(requested_by, str) or not requested_by.strip() or len(requested_by) > 100:
            raise ValueError("requested_by must contain 1 to 100 non-whitespace characters.")

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # Check if job exists
                cur.execute("SELECT job_id FROM jobs WHERE job_id = %s;", (job_id,))
                if not cur.fetchone():
                    raise ValueError(f"Job '{job_id}' not found.")

                # Check if existing request matches (job_id, idempotency_key)
                cur.execute("""
                    SELECT * FROM preparation_requests
                    WHERE job_id = %s AND idempotency_key = %s;
                """, (job_id, idempotency_key))
                existing = cur.fetchone()
                if existing:
                    return existing, False

                cur.execute("""
                    INSERT INTO preparation_requests (
                        job_id, briefing_id, requested_by, idempotency_key, status
                    ) VALUES (%s, %s, %s, %s, 'QUEUED')
                    ON CONFLICT (job_id, idempotency_key) DO NOTHING
                    RETURNING *;
                """, (job_id, briefing_id, requested_by, idempotency_key))
                created = cur.fetchone()
                if created:
                    conn.commit()
                    return created, True

                # If conflict occurred concurrently, fetch existing
                cur.execute("""
                    SELECT * FROM preparation_requests
                    WHERE job_id = %s AND idempotency_key = %s;
                """, (job_id, idempotency_key))
                return cur.fetchone(), False

    def get_preparation_request(self, request_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM preparation_requests WHERE id = %s;", (request_id,))
                return cur.fetchone()

    def get_preparation_request_by_idempotency(self, job_id: str, idempotency_key: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM preparation_requests
                    WHERE job_id = %s AND idempotency_key = %s;
                """, (job_id, idempotency_key))
                return cur.fetchone()

    def update_preparation_request_status(
        self,
        request_id: str,
        status: str,
        analysis_id: Optional[str] = None,
        resume_version_id: Optional[str] = None,
        error_summary: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM preparation_requests WHERE id = %s FOR UPDATE;",
                    (request_id,),
                )
                current = cur.fetchone()
                if not current:
                    return None
                normalized_status = validate_preparation_request_transition(current["status"], status)
                next_error_summary = (
                    error_summary if error_summary is not None else current.get("error_summary")
                ) if normalized_status.value in {"BLOCKED", "FAILED"} else None

                cur.execute("""
                    UPDATE preparation_requests
                    SET status = %s,
                        analysis_id = COALESCE(%s, analysis_id),
                        resume_version_id = COALESCE(%s, resume_version_id),
                        error_summary = %s,
                        updated_at = NOW()
                    WHERE id = %s
                    RETURNING *;
                """, (normalized_status.value, analysis_id, resume_version_id, next_error_summary, request_id))
                updated = cur.fetchone()
                conn.commit()
                return updated

    def list_preparation_requests(
        self,
        job_id: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        if limit < 1 or limit > 500:
            raise ValueError("limit must be between 1 and 500.")
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                query = "SELECT * FROM preparation_requests WHERE 1=1"
                params: List[Any] = []
                if job_id is not None:
                    query += " AND job_id = %s"
                    params.append(job_id)
                if status is not None:
                    query += " AND status = %s"
                    params.append(status)
                query += " ORDER BY created_at DESC LIMIT %s;"
                params.append(limit)
                cur.execute(query, params)
                return cur.fetchall()

    # -------------------------------------------------------------
    # UI SESSION & OUTBOX METHODS (MILESTONE 5)
    # -------------------------------------------------------------
    def create_ui_session(
        self,
        token_hash: str,
        conversation_id: str,
        workspace_path: str,
        purpose: str,
        allowed_actions: List[str],
        allowed_entity_ids: List[str],
        expires_at: datetime
    ) -> Dict[str, Any]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO ui_sessions (
                        token_hash, conversation_id, workspace_path, purpose,
                        allowed_actions, allowed_entity_ids, expires_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING *;
                """, (
                    token_hash,
                    conversation_id,
                    workspace_path,
                    purpose,
                    json.dumps(allowed_actions),
                    json.dumps([str(e) for e in allowed_entity_ids]),
                    expires_at
                ))
                record = cur.fetchone()
                conn.commit()
                return record

    def get_ui_session_by_token_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ui_sessions WHERE token_hash = %s;", (token_hash,))
                return cur.fetchone()

    def get_ui_session_by_cookie_hash(self, cookie_hash: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ui_sessions WHERE session_cookie_hash = %s;", (cookie_hash,))
                return cur.fetchone()

    def redeem_ui_session_token(self, session_id: str, cookie_hash: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE ui_sessions
                    SET redeemed_at = NOW(),
                        session_cookie_hash = %s,
                        updated_at = NOW()
                    WHERE id = %s AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
                    RETURNING *;
                """, (cookie_hash, session_id))
                record = cur.fetchone()
                conn.commit()
                return record

    def revoke_ui_session(self, session_id: str) -> bool:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE ui_sessions
                    SET revoked_at = NOW(), updated_at = NOW()
                    WHERE id = %s AND revoked_at IS NULL;
                """, (session_id,))
                revoked = cur.rowcount > 0
                conn.commit()
                return revoked

    def create_ui_action(
        self,
        ui_session_id: str,
        action_type: str,
        entity_type: str,
        entity_id: Optional[str],
        payload: Dict[str, Any],
        idempotency_key: str
    ) -> Tuple[Dict[str, Any], bool]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM ui_actions
                    WHERE ui_session_id = %s AND idempotency_key = %s;
                """, (ui_session_id, idempotency_key))
                existing = cur.fetchone()
                if existing:
                    return existing, False

                cur.execute("""
                    INSERT INTO ui_actions (
                        ui_session_id, action_type, entity_type, entity_id,
                        payload, idempotency_key, status
                    ) VALUES (%s, %s, %s, %s, %s, %s, 'PENDING')
                    ON CONFLICT (ui_session_id, idempotency_key) DO NOTHING
                    RETURNING *;
                """, (
                    ui_session_id,
                    action_type,
                    entity_type,
                    entity_id,
                    json.dumps(payload, default=str),
                    idempotency_key
                ))
                created = cur.fetchone()
                if created:
                    conn.commit()
                    return created, True

                cur.execute("""
                    SELECT * FROM ui_actions
                    WHERE ui_session_id = %s AND idempotency_key = %s;
                """, (ui_session_id, idempotency_key))
                return cur.fetchone(), False

    def get_ui_action(self, action_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM ui_actions WHERE id = %s;", (action_id,))
                return cur.fetchone()

    def lease_pending_ui_actions(
        self,
        limit: int,
        lease_duration_seconds: int,
        worker_token: str
    ) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    WITH eligible AS (
                        SELECT a.id, s.conversation_id, s.workspace_path
                        FROM ui_actions a
                        JOIN ui_sessions s ON a.ui_session_id = s.id
                        WHERE (
                            a.status = 'PENDING'
                            OR (a.status = 'FAILED' AND a.next_retry_at <= NOW())
                            OR (a.status = 'LEASED' AND a.lease_expires_at <= NOW())
                        )
                        AND s.revoked_at IS NULL
                        AND s.expires_at > NOW()
                        ORDER BY a.created_at ASC
                        LIMIT %s
                        FOR UPDATE OF a SKIP LOCKED
                    )
                    UPDATE ui_actions a
                    SET status = 'LEASED',
                        lease_token = %s,
                        lease_expires_at = NOW() + (INTERVAL '1 second' * %s),
                        updated_at = NOW()
                    FROM eligible e
                    WHERE a.id = e.id
                    RETURNING a.*, e.conversation_id, e.workspace_path;
                """, (limit, worker_token, lease_duration_seconds))
                records = cur.fetchall()
                conn.commit()
                return records

    def complete_ui_action_delivery(self, action_id: str, worker_token: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE ui_actions
                    SET status = 'DELIVERED',
                        delivered_at = NOW(),
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        updated_at = NOW()
                    WHERE id = %s AND lease_token = %s
                    RETURNING *;
                """, (action_id, worker_token))
                record = cur.fetchone()
                conn.commit()
                return record

    def fail_ui_action_delivery(
        self,
        action_id: str,
        worker_token: str,
        error_summary: str,
        is_permanent: bool = False
    ) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE ui_actions
                    SET status = CASE WHEN %s THEN 'DEAD_LETTER' ELSE 'FAILED' END,
                        retry_count = retry_count + 1,
                        next_retry_at = NOW() + (INTERVAL '1 second' * POWER(2, LEAST(retry_count + 1, 8))),
                        error_summary = %s,
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        updated_at = NOW()
                    WHERE id = %s AND lease_token = %s
                    RETURNING *;
                """, (is_permanent, error_summary, action_id, worker_token))
                record = cur.fetchone()
                conn.commit()
                return record

    def record_ui_action_delivery_attempt(
        self,
        action_id: str,
        attempt_number: int,
        status: str,
        error_details: Optional[str] = None,
        duration_ms: int = 0
    ) -> Dict[str, Any]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO ui_action_deliveries (
                        ui_action_id, attempt_number, status, error_details, duration_ms
                    ) VALUES (%s, %s, %s, %s, %s)
                    RETURNING *;
                """, (action_id, attempt_number, status, error_details, duration_ms))
                record = cur.fetchone()
                conn.commit()
                return record

    def get_ui_action_deliveries(self, action_id: str) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM ui_action_deliveries
                    WHERE ui_action_id = %s
                    ORDER BY attempt_number ASC;
                """, (action_id,))
                return cur.fetchall()

    # -------------------------------------------------------------
    # JOB BRIEFING METHODS (MILESTONE 6)
    # -------------------------------------------------------------
    def create_job_briefing(
        self,
        schedule_name: str,
        window_started_at: datetime,
        window_ended_at: datetime,
        source_run_ids: List[str],
        metrics: Dict[str, Any],
        items: List[Dict[str, Any]],
        trigger_run_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create an immutable job briefing header and freeze its items.
        Returns the created briefing record with items.
        """
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                if trigger_run_id:
                    cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0));", (trigger_run_id,))
                    cur.execute(
                        "SELECT * FROM job_briefings WHERE trigger_run_id = %s;",
                        (trigger_run_id,),
                    )
                    existing = cur.fetchone()
                    if existing:
                        existing_dict = dict(existing)
                        existing_dict["items"] = self.get_briefing_items(str(existing["id"]))
                        return existing_dict
                cur.execute("""
                    INSERT INTO job_briefings (
                        schedule_name, trigger_run_id, window_started_at, window_ended_at,
                        source_run_ids, status, metrics
                    ) VALUES (%s, %s, %s, %s, %s, 'ACTIVE', %s)
                    RETURNING *;
                """, (
                    schedule_name,
                    trigger_run_id,
                    window_started_at,
                    window_ended_at,
                    json.dumps(source_run_ids),
                    json.dumps(metrics, default=str)
                ))
                briefing = cur.fetchone()
                briefing_id = str(briefing["id"])

                persisted_items = []
                for rank, item in enumerate(items, start=1):
                    job_id = str(item["job_id"])
                    snapshot = item.get("snapshot", item)
                    cur.execute("""
                        INSERT INTO job_briefing_items (
                            briefing_id, job_id, rank, snapshot
                        ) VALUES (%s, %s, %s, %s)
                        RETURNING *;
                    """, (
                        briefing_id,
                        job_id,
                        rank,
                        json.dumps(snapshot, default=str)
                    ))
                    persisted_items.append(cur.fetchone())

                conn.commit()
                briefing_dict = dict(briefing)
                briefing_dict["items"] = persisted_items
                return briefing_dict

    def get_latest_job_briefing(self, schedule_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                if schedule_name:
                    cur.execute("""
                        SELECT * FROM job_briefings
                        WHERE schedule_name = %s
                        ORDER BY created_at DESC
                        LIMIT 1;
                    """, (schedule_name,))
                else:
                    cur.execute("""
                        SELECT * FROM job_briefings
                        ORDER BY created_at DESC
                        LIMIT 1;
                    """)
                briefing = cur.fetchone()
                if not briefing:
                    return None
                briefing_dict = dict(briefing)
                briefing_dict["items"] = self.get_briefing_items(str(briefing["id"]))
                return briefing_dict

    def get_job_briefing(self, briefing_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM job_briefings WHERE id = %s;", (briefing_id,))
                briefing = cur.fetchone()
                if not briefing:
                    return None
                briefing_dict = dict(briefing)
                briefing_dict["items"] = self.get_briefing_items(briefing_id)
                return briefing_dict

    def get_briefing_items(self, briefing_id: str) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM job_briefing_items
                    WHERE briefing_id = %s
                    ORDER BY rank ASC;
                """, (briefing_id,))
                return cur.fetchall()

    def acknowledge_briefing(self, briefing_id: str) -> bool:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE job_briefings
                    SET status = 'ACKNOWLEDGED'
                    WHERE id = %s AND status = 'ACTIVE'
                    RETURNING id;
                """, (briefing_id,))
                row = cur.fetchone()
                conn.commit()
                return row is not None

    def compute_new_jobs_window(
        self,
        schedule_name: str = "morning_scan",
        default_window_hours: float = 24.0
    ) -> Tuple[datetime, datetime]:
        """
        Compute the discovery window (window_started_at, window_ended_at).
        Uses the latest acknowledged briefing's window_ended_at as start;
        otherwise defaults to now - default_window_hours.
        """
        now = datetime.now(timezone.utc)
        latest = self.get_latest_job_briefing(schedule_name=schedule_name)
        if latest and latest.get("window_ended_at"):
            start = latest["window_ended_at"]
        else:
            start = now - timedelta(hours=default_window_hours)
        return start, now

    def prepare_briefing_jobs(
        self,
        briefing_id: str,
        job_ids: List[str],
        idempotency_key: str,
        requested_by: str = "antigravity",
        ui_session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Idempotently prepare a batch of jobs selected from a briefing.
        Verifies briefing item membership, checks job status, creates/reuses
        preparation_requests, and records the UI action if ui_session_id is given.
        """
        if not job_ids:
            raise ValueError("job_ids cannot be empty.")
        if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 63:
            raise ValueError("idempotency_key must contain 1 to 63 non-whitespace characters.")

        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # 1. Verify briefing exists
                cur.execute("SELECT id FROM job_briefings WHERE id = %s;", (briefing_id,))
                if not cur.fetchone():
                    raise ValueError(f"Briefing '{briefing_id}' not found.")

                # 2. Verify all job_ids belong to the briefing
                cur.execute("""
                    SELECT job_id FROM job_briefing_items
                    WHERE briefing_id = %s;
                """, (briefing_id,))
                valid_briefing_job_ids = {str(r["job_id"]) for r in cur.fetchall()}

                for jid in job_ids:
                    if str(jid) not in valid_briefing_job_ids:
                        raise ValueError(f"Job '{jid}' does not belong to briefing '{briefing_id}'.")

                # 3. Check statuses and create/reuse preparation_requests
                results: Dict[str, Dict[str, Any]] = {}
                for jid in job_ids:
                    cur.execute("SELECT status FROM jobs WHERE job_id = %s;", (jid,))
                    job_row = cur.fetchone()
                    current_job_status = job_row["status"] if job_row else "UNKNOWN"

                    if current_job_status in ("WITHDRAWN", "EXPIRED", "REJECTED"):
                        results[jid] = {
                            "status": "BLOCKED",
                            "reason": f"Job is in '{current_job_status}' status.",
                            "is_new": False
                        }
                        continue

                    # Check if already submitted
                    cur.execute("""
                        SELECT status FROM applications
                        WHERE job_id = %s AND status IN ('SUBMITTED', 'ACCEPTED', 'OFFERED', 'HIRED');
                    """, (jid,))
                    app_row = cur.fetchone()
                    if app_row:
                        results[jid] = {
                            "status": "BLOCKED",
                            "reason": f"Job already has application in '{app_row['status']}' status.",
                            "is_new": False
                        }
                        continue

                    # Idempotent preparation request lookup or insertion
                    job_idemp_key = f"{idempotency_key}_{jid}"
                    cur.execute("""
                        SELECT * FROM preparation_requests
                        WHERE job_id = %s AND idempotency_key = %s;
                    """, (jid, job_idemp_key))
                    existing = cur.fetchone()
                    if existing:
                        results[jid] = {
                            "status": "ALREADY_PREPARED" if existing["status"] in ("READY_FOR_REVIEW", "TAILORING") else existing["status"],
                            "request_id": str(existing["id"]),
                            "is_new": False
                        }
                    else:
                        cur.execute("""
                            INSERT INTO preparation_requests (
                                job_id, briefing_id, requested_by, idempotency_key, status
                            ) VALUES (%s, %s, %s, %s, 'QUEUED')
                            RETURNING *;
                        """, (jid, briefing_id, requested_by, job_idemp_key))
                        new_req = cur.fetchone()
                        results[jid] = {
                            "status": "QUEUED",
                            "request_id": str(new_req["id"]),
                            "is_new": True
                        }

                # 4. If ui_session_id is provided, create ui_action
                action_record = None
                if ui_session_id:
                    cur.execute("""
                        INSERT INTO ui_actions (
                            ui_session_id, action_type, entity_type, entity_id,
                            payload, idempotency_key, status
                        ) VALUES (%s, 'prepare_selected', 'job_briefing', %s, %s, %s, 'PENDING')
                        ON CONFLICT (ui_session_id, idempotency_key) DO NOTHING
                        RETURNING *;
                    """, (
                        ui_session_id,
                        briefing_id,
                        json.dumps({
                            "briefing_id": briefing_id,
                            "job_ids": job_ids,
                            "results": results,
                        }, default=str),
                        idempotency_key,
                    ))
                    action_record = cur.fetchone()
                    if action_record is None:
                        cur.execute("""
                            SELECT * FROM ui_actions
                            WHERE ui_session_id = %s AND idempotency_key = %s;
                        """, (ui_session_id, idempotency_key))
                        action_record = cur.fetchone()

                conn.commit()
                return {
                    "briefing_id": briefing_id,
                    "results": results,
                    "action_id": str(action_record["id"]) if action_record else None
                }
