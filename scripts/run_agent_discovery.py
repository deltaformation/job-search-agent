#!/usr/bin/env python3
"""
CLI Fallback for Deterministic Agent Discovery Kickstart.

Part of Milestone 7: Deterministic Agent Discovery Kickstart.
Runs the single canonical search configuration and outputs the
AgentDiscoveryContextV1 envelope as JSON for agent consumption.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.discovery.agent_workflow import AgentDiscoveryWorkflow


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic Agent Discovery Kickstart (Milestone 7)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Execute canonical discovery without committing database writes.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Format output JSON with 2-space indentation.",
    )
    parser.add_argument(
        "--min-score",
        type=float,
        default=None,
        help="Optional minimum provisional fit score to filter the pending queue.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Maximum number of pending analysis jobs to include in the queue (default 10).",
    )

    args = parser.parse_args()

    workflow = AgentDiscoveryWorkflow()
    result = workflow.start_default_discovery(
        dry_run=args.dry_run,
        queue_limit=args.limit,
        min_score=args.min_score,
    )

    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent, default=str))

    if result.get("status") == "blocked":
        return 2
    if result.get("status") == "partial_failure" and not result.get("queue"):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
