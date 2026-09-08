import os
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
import psycopg
from psycopg.rows import dict_row
from services.discovery.deduplicator import is_ats_url, detect_ats_type

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

DEFAULT_DB_URL = "postgresql://mouadatfi@localhost:5432/job_system"

class JobRepository:
    def __init__(self, db_url: Optional[str] = None):
        self.db_url = db_url or os.getenv("DATABASE_URL", DEFAULT_DB_URL)

    def get_connection(self):
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
                    SELECT * FROM achievements 
                    WHERE verification_status = 'approved'
                    ORDER BY fact_id ASC;
                """)
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

                return profile

    def upsert_job(self, job_data: Dict[str, Any], source_data: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        """
        Inserts or updates a job and appends source provenance.
        Returns (job_record, is_new).
        """
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
                            min_amount, max_amount, currency
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, NOW(), NOW(),
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s,
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
                        job_data.get("currency")
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
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                query = f"""
                    SELECT j.*, fresh.age_hours, fresh.freshness_bucket, s.overall_score, s.recommendation, s.strengths, s.gaps, s.evidence_fact_ids
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

                query += " ORDER BY s.overall_score DESC NULLS LAST, j.posted_at DESC NULLS LAST LIMIT %s;"
                params.append(limit)

                cur.execute(query, params)
                return cur.fetchall()

    def get_job_by_id(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT j.*, fresh.age_hours, fresh.freshness_bucket, s.overall_score, s.recommendation, s.strengths, s.gaps, s.risks, s.evidence_fact_ids,
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

    def save_job_score(self, job_id: str, score_data: Dict[str, Any]) -> Dict[str, Any]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO job_scores (
                        job_id, overall_score, recommendation, role_alignment, experience_score,
                        seniority_score, skills_score, domain_score, location_score, comp_score,
                        preference_score, strengths, gaps, risks, evidence_fact_ids, scored_at
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, NOW()
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
                    json.dumps(score_data.get("evidence_fact_ids", []))
                ))
                saved_score = cur.fetchone()

                # Update job status if qualified
                new_status = "QUALIFIED" if score_data["overall_score"] >= 85 else ("REVIEW" if score_data["overall_score"] >= 75 else "SKIPPED")
                cur.execute("""
                    UPDATE jobs 
                    SET status = %s, updated_at = NOW() 
                    WHERE job_id = %s;
                """, (new_status, job_id))

                cur.execute("""
                    INSERT INTO job_events (job_id, event_type, from_status, to_status, details)
                    VALUES (%s, 'SCORED', 'NEW', %s, %s);
                """, (job_id, new_status, json.dumps({"score": score_data["overall_score"]})))

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
