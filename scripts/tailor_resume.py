#!/usr/bin/env python3
"""Generate a draft through the same validated workflow as MCP."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.documents.pipeline import generate_documents
from services.memory.repository import JobRepository


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a resume draft for human review.")
    parser.add_argument("--job-id", required=True)
    args = parser.parse_args()
    result = generate_documents(JobRepository(), args.job_id)
    print(json.dumps(result, indent=2, default=str))
    if result["status"] != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
