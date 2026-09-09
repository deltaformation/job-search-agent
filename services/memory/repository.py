import os
import json
import hashlib
from pathlib import Path
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

    def save_jd_snapshot(self, job_id: str, raw_text: str, cleaned_text: str) -> str:
        c_hash = hashlib.sha256(cleaned_text.encode("utf-8")).hexdigest()
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO jd_snapshots (job_id, content_hash, raw_text, cleaned_text)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (job_id, content_hash) DO UPDATE SET cleaned_text = EXCLUDED.cleaned_text
                    RETURNING id;
                """, (job_id, c_hash, raw_text, cleaned_text))
                conn.commit()
                return str(cur.fetchone()["id"])

    def get_jd_snapshot(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM jd_snapshots WHERE job_id = %s ORDER BY created_at DESC LIMIT 1;
                """, (job_id,))
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
                        profile_snapshot_id, jd_snapshot_id, baseline_text, requirements_snapshot
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s
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
                    data.get("baseline_text"), json.dumps(data.get("requirements_snapshot", []), default=str)
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
