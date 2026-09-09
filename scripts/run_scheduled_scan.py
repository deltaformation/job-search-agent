#!/usr/bin/env python3
"""Run discovery, report pending analysis, and deliver the final-score shortlist."""
import sys
import os
import argparse
import logging
from uuid import uuid4
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.discovery.service import DiscoveryService
from services.memory.repository import JobRepository
from services.intelligence.scorer import FitScorer
from services.discovery.config import AppConfig

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scheduled_scan")

def format_review_report(
    run_result: dict,
    shortlist: list,
    batch_id: str
) -> str:
    metrics = run_result.get("metrics", {})
    obs = run_result.get("observations", [])

    lines = []
    lines.append("=" * 70)
    lines.append(f"JOB RADAR SCAN REPORT - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("=" * 70)
    lines.append(f"Run Status: {run_result.get('status')} (Run ID: {run_result.get('run_id')})")
    lines.append(f"Delivery Batch ID: {batch_id}")
    lines.append(f"Duration: {run_result.get('duration_seconds', 0)}s")
    lines.append("-" * 70)
    lines.append("DISCOVERY OBSERVATIONS:")
    for o in obs:
        q = o.get("query", {})
        err_str = f" - Errors: {len(o.get('errors', []))}" if o.get("errors") else ""
        lines.append(
            f"  * Board [{o.get('source', '').upper()}]: '{q.get('role')}' in '{q.get('location')}' -> "
            f"{o.get('status').upper()} (Received: {o.get('records_received')}, "
            f"Normalized: {o.get('records_normalized')}, Rejected: {o.get('records_rejected')}){err_str}"
        )
    lines.append("-" * 70)
    lines.append("INGESTION METRICS:")
    lines.append(f"  * Raw Postings: {metrics.get('raw_observations', 0)}")
    lines.append(f"  * New Canonical: {metrics.get('new_canonical', 0)}")
    lines.append(f"  * Duplicates Merged: {metrics.get('duplicates_merged', 0)}")
    lines.append(f"  * Stale Postings: {metrics.get('stale_excluded', 0)}")
    lines.append(f"  * Jobs Scored: {metrics.get('scored', 0)}")
    lines.append(f"  * Qualified Jobs: {metrics.get('qualified', 0)}")
    lines.append(f"  * Awaiting Antigravity Analysis: {metrics.get('pending_analysis', 0)}")
    lines.append("-" * 70)
    lines.append(f"SHORTLIST REVIEW QUEUE ({len(shortlist)} candidates):")
    if not shortlist:
        lines.append("  (No candidates currently qualify for review based on score and freshness criteria.)")
    else:
        for idx, job in enumerate(shortlist, 1):
            prov_tag = "[PROVISIONAL]" if job.get("is_provisional") else "[VERIFIED]"
            lines.append(f"\n  {idx}. {job['title']} @ {job['company']}")
            lines.append(f"     Location: {job['location']} ({job['remote_type']}) | Freshness: {job['freshness_bucket']} ({job['age_hours']}h old)")
            lines.append(f"     Score: {job['overall_score']} ({job['score_band'].upper()}) -> Recommendation: {job['recommendation'].upper()} {prov_tag}")
            lines.append(f"     Apply URL: {job.get('apply_url') or job.get('canonical_url')}")
            if job.get("strengths"):
                lines.append(f"     Key Strengths: {'; '.join(job['strengths'][:2])}")
            if job.get("gaps"):
                lines.append(f"     Gaps: {'; '.join(job['gaps'][:2])}")
            if job.get("risks"):
                lines.append(f"     Risks: {'; '.join(job['risks'][:2])}")
    lines.append("=" * 70)
    return "\n".join(lines)

def run_scheduled_pipeline(
    schedule_name: str = "morning_scan",
    limit: int = 5,
    dry_run: bool = False
) -> int:
    repo = JobRepository()
    scorer = FitScorer()
    config = AppConfig()
    discovery = DiscoveryService(repo=repo, scorer=scorer, config=config)
    resolved = config.resolve_discovery_params(schedule_name=schedule_name)

    logger.info(f"Starting scheduled pipeline for '{schedule_name}' (limit: {limit})...")

    # Step 1: Run discovery
    run_res = discovery.run_discovery(schedule_name=schedule_name, dry_run=dry_run)
    if run_res.get("status") == "SKIPPED_OVERLAP":
        print(f"Workflow skipped: {run_res.get('message')}")
        return 0

    # This local runner cannot perform Antigravity's reasoning step. Pending
    # analyses are reported for the agent to process through MCP; only fully
    # analyzed scores are eligible for the delivered shortlist.
    pending_analysis = repo.get_pending_analysis_jobs(limit=limit)
    shortlist = [] if dry_run else repo.get_shortlist(
        limit=limit,
        min_score=float(resolved["pipeline"]["min_score_to_shortlist"]),
        max_age_hours=float(resolved["hours_old"]),
        include_provisional=False,
    )
    job_ids = [str(j["job_id"]) for j in shortlist]

    batch_id = str(uuid4())
    # Step 3: Reserve candidates for delivery
    if job_ids:
        reserved_ids = set(repo.reserve_shortlist(job_ids, batch_id))
        shortlist = [job for job in shortlist if str(job["job_id"]) in reserved_ids]
        job_ids = [str(job["job_id"]) for job in shortlist]

    # Step 4: Present review report
    run_res.setdefault("metrics", {})["pending_analysis"] = len(pending_analysis)
    report_text = format_review_report(run_res, shortlist, batch_id)
    print("\n" + report_text + "\n")

    # Step 5: Acknowledge delivery after presentation
    if job_ids:
        ack_count = repo.acknowledge_shortlist_delivery(batch_id, job_ids)
        logger.info(f"Acknowledged delivery of {ack_count} shortlisted jobs (Batch ID: {batch_id})")

    return 0

def main() -> int:
    parser = argparse.ArgumentParser(description="Scheduled Scan Pipeline")
    parser.add_argument("--schedule", type=str, default="morning_scan", choices=["morning_scan", "evening_scan"])
    parser.add_argument("--limit", type=int, default=5, help="Number of shortlisted candidates to deliver")
    parser.add_argument("--dry-run", action="store_true", help="Run discovery without database writes")

    args = parser.parse_args()
    return run_scheduled_pipeline(schedule_name=args.schedule, limit=args.limit, dry_run=args.dry_run)

if __name__ == "__main__":
    sys.exit(main())
