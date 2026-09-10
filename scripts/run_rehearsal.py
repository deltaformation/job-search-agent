#!/usr/bin/env python3
"""
Checked-in orchestration entrypoint for safe Job Search UX Rehearsal.
Manages the loopback control center, generates an isolated rehearsal briefing,
issues a one-time dashboard URL, and cleans up its temporary rehearsal state.
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from services.briefing.service import BriefingService
from services.intelligence.scorer import FitScorer
from services.memory.repository import JobRepository
from services.ui.server import WORKSPACE_STATE_FILE, read_state_file, remove_state_file
from services.ui.sessions import SessionManager

REHEARSAL_SCHEDULE = "rehearsal_scan"
REHEARSAL_CONVERSATION = "rehearsal_conversation"


def check_preflight(repo: JobRepository) -> Tuple[bool, Optional[str]]:
    """Verify database and essential system prerequisites with a single actionable blocker message."""
    try:
        with repo.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1;")
    except Exception:
        return (
            False,
            "PostgreSQL database is unreachable. Ensure local PostgreSQL is active "
            "and the configured database is accessible.",
        )
    return True, None


def is_service_healthy(url: str, timeout: float = 1.5) -> bool:
    """Check if the control center /health endpoint returns 200."""
    try:
        clean_url = url.rstrip("/")
        req = urllib.request.Request(f"{clean_url}/health", headers={"User-Agent": "rehearsal-probe"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def ensure_control_center(
    port: int = 8765,
) -> Tuple[Optional[subprocess.Popen[bytes]], str]:
    """
    Ensure the loopback control center is running.
    Reuses existing healthy server or spawns a dedicated subprocess.
    Returns the owned process, when one was started, and its base URL.
    """
    state = read_state_file()
    if state and state.get("url"):
        existing_url = state["url"]
        if is_service_healthy(existing_url):
            return None, existing_url

    # Check if target port is available; if not, pick free port
    effective_port = port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            # Port occupied and not responding healthy to our probe
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s2:
                s2.bind(("127.0.0.1", 0))
                s2.listen(1)
                effective_port = int(s2.getsockname()[1])

    # Spawn background server process
    cmd = [sys.executable, str(BASE_DIR / "scripts" / "run_control_center.py"), "--port", str(effective_port)]
    proc = subprocess.Popen(
        cmd,
        cwd=str(BASE_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    base_url = f"http://127.0.0.1:{effective_port}"
    deadline = time.time() + 8.0
    while time.time() < deadline:
        if is_service_healthy(base_url, timeout=0.5):
            return proc, base_url
        time.sleep(0.2)

    # Failed to start
    _stop_owned_process(proc)
    raise RuntimeError(f"Control center failed to report healthy on {base_url} within 8 seconds.")


def _stop_owned_process(proc: subprocess.Popen[bytes]) -> bool:
    """Stop only a process created by this rehearsal invocation."""
    try:
        if proc.poll() is None:
            if hasattr(os, "killpg") and hasattr(os, "getpgid"):
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def cleanup_rehearsal_state(
    repo: JobRepository,
    proc: Optional[subprocess.Popen[bytes]] = None,
    stop_existing: bool = False
) -> Dict[str, Any]:
    """Clean up all rehearsal records, sessions, state files, and spawned processes."""
    cleaned: Dict[str, Any] = {
        "briefings": 0,
        "sessions": 0,
        "server_stopped": False,
        "state_removed": False,
        "errors": [],
    }

    # 1. Prune rehearsal database records
    try:
        with repo.get_connection() as conn:
            with conn.cursor() as cur:
                # Delete briefing items and briefings for rehearsal schedule
                cur.execute("""
                    DELETE FROM job_briefing_items
                    WHERE briefing_id IN (SELECT id FROM job_briefings WHERE schedule_name = %s);
                """, (REHEARSAL_SCHEDULE,))
                cur.execute("DELETE FROM job_briefings WHERE schedule_name = %s;", (REHEARSAL_SCHEDULE,))
                cleaned["briefings"] = cur.rowcount

                # Delete rehearsal UI sessions
                cur.execute("DELETE FROM ui_sessions WHERE conversation_id = %s;", (REHEARSAL_CONVERSATION,))
                cleaned["sessions"] = cur.rowcount
            conn.commit()
    except Exception:
        cleaned["errors"].append("database cleanup failed")

    # 2. Stop the process owned by this rehearsal, or an existing server only
    # when the human explicitly invoked --clean.
    owned_pid = proc.pid if proc else None
    if proc:
        if _stop_owned_process(proc):
            cleaned["server_stopped"] = True
        else:
            cleaned["errors"].append("owned control center could not be stopped")

    if stop_existing:
        state = read_state_file()
        if state and state.get("pid"):
            try:
                os.kill(int(state["pid"]), signal.SIGTERM)
                cleaned["server_stopped"] = True
            except ProcessLookupError:
                pass
            except (OSError, TypeError, ValueError):
                cleaned["errors"].append("recorded control center could not be stopped")

    # 3. Remove only a state file owned by a process this call stopped. A
    # rehearsal that reused the supervised sidecar must not make it invisible.
    if WORKSPACE_STATE_FILE.exists() and (owned_pid is not None or stop_existing):
        try:
            workspace_state = json.loads(WORKSPACE_STATE_FILE.read_text())
        except (OSError, ValueError, TypeError):
            workspace_state = {}
        if stop_existing or workspace_state.get("pid") == owned_pid:
            remove_state_file(WORKSPACE_STATE_FILE)
            cleaned["state_removed"] = not WORKSPACE_STATE_FILE.exists()

    cleaned["complete"] = not cleaned["errors"]

    return cleaned


class RehearsalSession:
    """Context manager for safe, isolated rehearsal execution and guaranteed cleanup."""
    def __init__(
        self,
        port: int = 8765,
        window_hours: float = 72.0,
        limit: int = 20,
        repo: Optional[JobRepository] = None
    ) -> None:
        self.port = port
        self.window_hours = window_hours
        self.limit = limit
        self.repo = repo or JobRepository()
        self.proc: Optional[subprocess.Popen[bytes]] = None
        self.dashboard_url: Optional[str] = None
        self.briefing: Optional[Dict[str, Any]] = None
        self.markdown_summary: Optional[str] = None
        self.cleanup_result: Optional[Dict[str, Any]] = None

    def __enter__(self) -> "RehearsalSession":
        ok, error_msg = check_preflight(self.repo)
        if not ok:
            raise RuntimeError(error_msg)

        try:
            print("Running a safe rehearsal...")
            self.proc, base_url = ensure_control_center(port=self.port)

            scorer = FitScorer()
            briefing_service = BriefingService(repo=self.repo, scorer=scorer)
            self.briefing = briefing_service.create_briefing(
                schedule_name=REHEARSAL_SCHEDULE,
                window_hours=self.window_hours,
                limit=self.limit,
            )
            briefing_id = str(self.briefing["id"])

            raw_token, _ = SessionManager(self.repo).create_session(
                conversation_id=REHEARSAL_CONVERSATION,
                workspace_path=str(BASE_DIR),
                purpose="morning_briefing",
                allowed_actions=["prepare_selected"],
                allowed_entity_ids=[briefing_id],
            )

            self.dashboard_url = f"{base_url}/redeem?token={raw_token}"
            self.markdown_summary = briefing_service.format_chat_markdown(
                self.briefing,
                self.dashboard_url,
            )
            return self
        except Exception:
            self.cleanup_result = self.teardown()
            raise

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        self.cleanup_result = self.teardown()

    def teardown(self) -> Dict[str, Any]:
        proc, self.proc = self.proc, None
        return cleanup_rehearsal_state(self.repo, proc, stop_existing=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Job Search UX Rehearsal Orchestrator")
    parser.add_argument("--port", type=int, default=8765, help="Preferred loopback port (default: 8765)")
    parser.add_argument("--window-hours", type=float, default=72.0, help="Briefing window hours (default: 72)")
    parser.add_argument("--limit", type=int, default=20, help="Briefing item limit (default: 20)")
    parser.add_argument("--clean", action="store_true", help="Tear down any rehearsal state, server, and files")
    parser.add_argument("--non-interactive", action="store_true", help="Print briefing and URL without waiting for user input")

    args = parser.parse_args()
    repo = JobRepository()

    if args.clean:
        res = cleanup_rehearsal_state(repo, stop_existing=True)
        if not res["complete"]:
            print("Error: Rehearsal cleanup could not complete. Check the database and control-center prerequisites.")
            return 1
        print("Rehearsal cleanup complete. No lingering processes, files, or database records.")
        return 0

    try:
        with RehearsalSession(
            port=args.port,
            window_hours=args.window_hours,
            limit=args.limit,
            repo=repo,
        ) as session:
            print("")
            print(session.markdown_summary)
            print("")
            print(f"One-Time Dashboard URL: {session.dashboard_url}")
            print("")
            print("Verification Checklist:")
            print("- Search by title and company")
            print("- Recommendation, work-arrangement, and freshness filters")
            print("- Score, freshness, evidence, and gap columns")
            print("- Column sorting and job expansion")
            print("- Selecting and clearing jobs")
            print("- Pressing 'Prepare Selected' and verifying results dialog")
            print("")
            print("Safety Invariant: Automation is paused at human selection. No applications will be submitted and no resumes approved.")

            if not args.non_interactive:
                try:
                    input("\nPress Enter after completing testing to finish and clean up rehearsal...")
                except (KeyboardInterrupt, EOFError):
                    pass

        if session.cleanup_result and not session.cleanup_result["complete"]:
            print("Error: Rehearsal finished, but cleanup could not complete.")
            return 1
        if not args.non_interactive:
            print("Rehearsal finished and cleaned up.")
        return 0

    except Exception as exc:
        print(f"Error: Rehearsal encountered an issue ({exc}).")
        return 1


if __name__ == "__main__":
    sys.exit(main())
