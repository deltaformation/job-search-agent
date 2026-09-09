#!/usr/bin/env python3
"""Show job-pipeline counts without shell-embedded Python."""

import sys
from pathlib import Path
from typing import Any, Dict, List

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository


def load_pipeline_status(repo: JobRepository) -> Dict[str, Any]:
    """Read pipeline counts and the number of jobs observed in the last day."""
    with repo.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status, count(*) AS count FROM jobs GROUP BY status ORDER BY count(*) DESC, status;"
            )
            statuses: List[Dict[str, Any]] = cur.fetchall()
            cur.execute("SELECT count(*) AS count FROM jobs WHERE created_at >= NOW() - INTERVAL '24 hours';")
            recent = cur.fetchone()
    return {"statuses": statuses, "recent_24h": int(recent["count"] if recent else 0)}


def main() -> int:
    """Render current pipeline counts."""
    status = load_pipeline_status(JobRepository())
    print("\n=== JOB SEARCH OS: PIPELINE STATUS ===")
    for row in status["statuses"]:
        print(f"  {str(row['status']):20}: {row['count']} jobs")
    print(f"  {'Recent (Last 24h)':20}: {status['recent_24h']} jobs\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
