#!/usr/bin/env python3
"""
Diagnostic CLI entrypoint for the local Job Search Control Center service.
Starts the loopback service, displays running status, or runs diagnostic outbox passes.
"""
import argparse
import os
import signal
import sys
from pathlib import Path

# Ensure project root is on sys.path
BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository
from services.ui.notifier import LeasedOutboxWorker
from services.ui.server import ControlCenterServer, read_state_file


def main() -> int:
    parser = argparse.ArgumentParser(description="Job Search Control Center Service (Diagnostics & Local Runner)")
    parser.add_argument("--port", type=int, default=0, help="Loopback port to bind (default: 0 for dynamic free port)")
    parser.add_argument("--status", action="store_true", help="Display status of currently running control center")
    parser.add_argument("--stop", action="store_true", help="Stop the background running instance")
    parser.add_argument("--drain-outbox", action="store_true", help="Manually run a single outbox delivery pass")

    args = parser.parse_args()
    repo = JobRepository()

    if args.status:
        state = read_state_file()
        if not state:
            print("Control center is not running (no active state file found).")
            return 0
        print("Active Control Center:")
        print(f"  URL:        {state.get('url')}")
        print(f"  Port:       {state.get('port')}")
        print(f"  PID:        {state.get('pid')}")
        print(f"  Started At: {state.get('started_at')}")
        return 0

    if args.stop:
        state = read_state_file()
        if not state or not state.get("pid"):
            print("No active control center PID found.")
            return 0
        pid = state["pid"]
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"Sent SIGTERM to control center PID {pid}.")
        except ProcessLookupError:
            print(f"Process {pid} was not running.")
        return 0

    if args.drain_outbox:
        worker = LeasedOutboxWorker(repo=repo)
        recovered = worker.recover_stranded_leases()
        if recovered:
            print(f"Recovered {recovered} stranded outbox action leases.")
        processed = worker.process_batch(limit=50)
        print(f"Drained outbox: processed {processed} actions.")
        return 0

    print(f"Starting Job Search Control Center on 127.0.0.1 (port {'dynamic' if args.port == 0 else args.port})...")
    server = ControlCenterServer(host="127.0.0.1", port=args.port, repo=repo)
    print(f"Service running at: http://127.0.0.1:{server.port}")
    try:
        server.run()
    except KeyboardInterrupt:
        print("\nShutdown requested by user.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
