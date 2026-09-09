#!/usr/bin/env python3
"""
CLI entrypoint for Job Discovery and Ingestion.
Supports named schedules, configuration hierarchy, failure isolation, and bounded smoke tests.
"""
import sys
import argparse
import logging
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.discovery.service import DiscoveryService

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("run_discovery")

def main() -> int:
    parser = argparse.ArgumentParser(description="Job Radar Discovery Runner")
    parser.add_argument("--schedule", type=str, default=None, help="Name of configured schedule (e.g. morning_scan, evening_scan)")
    parser.add_argument("--roles", nargs="+", default=None, help="List of job titles/roles to query")
    parser.add_argument("--locations", nargs="+", default=None, help="List of locations to query")
    parser.add_argument("--sources", nargs="+", default=None, help="Job boards to query (indeed, linkedin)")
    parser.add_argument("--max-results", type=int, default=None, help="Maximum results per query")
    parser.add_argument("--hours-old", type=float, default=None, help="Posting freshness window in hours")
    parser.add_argument("--dry-run", action="store_true", help="Scrape without persisting into database")
    parser.add_argument("--smoke-test", action="store_true", help="Execute a bounded smoke-test scan (1 role, 1 location, 3 results)")

    args = parser.parse_args()

    service = DiscoveryService()

    if args.smoke_test:
        print("\n--- Running Bounded Discovery Smoke Test ---")
        result = service.run_discovery(
            roles=["Senior Product Manager"],
            locations=["Toronto, ON"],
            sources=["indeed"],
            max_results_per_query=3,
            hours_old=72,
            dry_run=args.dry_run
        )
    else:
        result = service.run_discovery(
            schedule_name=args.schedule,
            roles=args.roles,
            locations=args.locations,
            sources=args.sources,
            max_results_per_query=args.max_results,
            hours_old=args.hours_old,
            dry_run=args.dry_run
        )

    print("\n" + "=" * 60)
    print(f"DISCOVERY RUN {result['status']} (Run ID: {result.get('run_id')})")
    if "duration_seconds" in result:
        print(f"Duration: {result['duration_seconds']}s")
    metrics = result.get("metrics", {})
    print(f"Raw Postings Found: {metrics.get('raw_observations', 0)}")
    print(f"New Canonical Jobs: {metrics.get('new_canonical', 0)}")
    print(f"Duplicates Merged: {metrics.get('duplicates_merged', 0)}")
    print(f"Stale Excluded: {metrics.get('stale_excluded', 0)}")
    print(f"Title Filtered: {metrics.get('title_filtered', 0)}")
    print(f"Jobs Scored: {metrics.get('scored', 0)}")
    print(f"Qualified Jobs: {metrics.get('qualified', 0)}")
    if result.get("errors"):
        print(f"Errors Logged: {len(result['errors'])}")
        for err in result["errors"][:5]:
            print(f"  ! {err}")
    print("=" * 60 + "\n")

    return 0 if result["status"] in ("COMPLETED", "PARTIAL_FAILURE") else 1

if __name__ == "__main__":
    sys.exit(main())
