#!/usr/bin/env python3
"""
Orchestrates job discovery, deduplication, freshness calculation, fit scoring,
and PostgreSQL persistence.
"""
import sys
import logging
from datetime import datetime, timezone
from pathlib import Path
import yaml

# Set up path
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository
from services.discovery.scraper import fetch_jobs_from_boards
from services.discovery.deduplicator import deduplicate_job_stream
from services.intelligence.scorer import FitScorer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("discovery_runner")

def run_discovery(
    roles=None,
    locations=None,
    hours_old: int = 72,
    results_wanted: int = 10,
    run_type: str = "manual"
):
    start_time = datetime.now(timezone.utc)
    config_path = BASE_DIR / "config" / "jobs.yaml"
    
    with open(config_path, "r", encoding="utf-8") as f:
        job_config = yaml.safe_load(f)

    search_roles = roles or job_config.get("search", {}).get("roles", ["Senior Product Manager"])
    search_locations = locations or job_config.get("search", {}).get("locations", ["Toronto, ON"])
    country = job_config.get("search", {}).get("country", "Canada")
    sources = job_config.get("search", {}).get("sources", ["indeed", "linkedin"])

    repo = JobRepository()
    scorer = FitScorer()
    profile = repo.get_candidate_profile()
    if not profile:
        logger.error("No candidate profile found. Please run migrations and seeds first.")
        return

    logger.info(f"Loaded verified candidate profile: {profile['full_name']} ({len(profile['verified_facts'])} facts)")

    # Fetch existing jobs from database for deduplication
    existing_db_jobs = repo.get_jobs(limit=500)
    seen_jobs = list(existing_db_jobs)

    jobs_found = 0
    jobs_new = 0
    jobs_duplicate = 0
    jobs_stale = 0
    jobs_scored = 0
    jobs_qualified = 0
    errors = []

    logger.info(f"Starting discovery run across {len(search_roles)} roles x {len(search_locations)} locations...")

    for role in search_roles:
        for loc in search_locations:
            try:
                pairs = fetch_jobs_from_boards(
                    search_term=role,
                    location=loc,
                    country=country,
                    hours_old=hours_old,
                    results_wanted=results_wanted,
                    sites=sources
                )
                jobs_found += len(pairs)

                for job_data, source_data in pairs:
                    # In-memory deduplication check
                    dup = deduplicate_job_stream(seen_jobs, job_data)
                    if dup:
                        jobs_duplicate += 1
                        # Still ensure source provenance is tracked in DB
                        repo.upsert_job(job_data, source_data)
                        continue

                    # Freshness check
                    if job_data.get("freshness_bucket") == "STALE":
                        jobs_stale += 1

                    # Persist new job
                    saved_job, is_new = repo.upsert_job(job_data, source_data)
                    seen_jobs.append(saved_job)

                    if is_new:
                        jobs_new += 1
                        # Score fit against verified profile
                        score_result = scorer.score_job(saved_job, profile)
                        repo.save_job_score(saved_job["job_id"], score_result)
                        jobs_scored += 1

                        if score_result["overall_score"] >= 85:
                            jobs_qualified += 1
                            logger.info(f"⭐ QUALIFIED JOB ({score_result['overall_score']}): {saved_job['title']} at {saved_job['company']} [{saved_job['freshness_bucket']}]")
                    else:
                        jobs_duplicate += 1

            except Exception as e:
                err_msg = f"Error querying '{role}' in '{loc}': {str(e)}"
                logger.error(err_msg)
                errors.append(err_msg)

    end_time = datetime.now(timezone.utc)
    duration_s = round((end_time - start_time).total_seconds(), 1)

    summary = {
        "duration_seconds": duration_s,
        "roles_searched": search_roles,
        "locations_searched": search_locations,
        "sources_used": sources,
        "jobs_found": jobs_found,
        "jobs_new": jobs_new,
        "jobs_duplicate": jobs_duplicate,
        "jobs_stale": jobs_stale,
        "jobs_scored": jobs_scored,
        "jobs_qualified": jobs_qualified
    }

    run_id = repo.record_agent_run({
        "run_type": run_type,
        "start_time": start_time,
        "end_time": end_time,
        "sources_used": sources,
        "jobs_found": jobs_found,
        "jobs_new": jobs_new,
        "jobs_duplicate": jobs_duplicate,
        "jobs_stale": jobs_stale,
        "jobs_scored": jobs_scored,
        "jobs_qualified": jobs_qualified,
        "documents_generated": 0,
        "errors": errors,
        "summary": summary
    })

    print("\n" + "="*60)
    print(f"DISCOVERY RUN COMPLETE (Run ID: {run_id})")
    print(f"Time Taken: {duration_s}s")
    print(f"Jobs Found: {jobs_found}")
    print(f"New Jobs Ingested: {jobs_new}")
    print(f"Duplicates Merged: {jobs_duplicate}")
    print(f"Jobs Scored: {jobs_scored}")
    print(f"Qualified Jobs (Score >= 85): {jobs_qualified}")
    print("="*60 + "\n")

if __name__ == "__main__":
    # Run targeted discovery smoke test
    run_discovery(
        roles=["Senior Product Manager", "Technical Product Manager"],
        locations=["Toronto, ON"],
        hours_old=72,
        results_wanted=5,
        run_type="milestone_1_smoke_test"
    )
