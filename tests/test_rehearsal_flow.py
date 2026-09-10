"""
Acceptance test suite for the safe Job Search UX Rehearsal flow.
Verifies prompt-to-outcome contracts, strict human safety boundaries,
and clean lifecycle teardown.
"""
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from scripts.run_rehearsal import (
    REHEARSAL_CONVERSATION,
    REHEARSAL_SCHEDULE,
    RehearsalSession,
    check_preflight,
    cleanup_rehearsal_state,
)
from services.memory.repository import JobRepository
from services.ui.server import WORKSPACE_STATE_FILE

BASE_DIR = Path(__file__).resolve().parents[1]


def _workspace_state_contents() -> bytes | None:
    """Capture pre-existing supervised state without treating it as test debris."""
    return WORKSPACE_STATE_FILE.read_bytes() if WORKSPACE_STATE_FILE.exists() else None


def _get_count(row) -> int:
    """Safely extract count from dict_row or tuple row."""
    if isinstance(row, dict):
        return row.get("count", 0)
    return row[0] if row else 0


def test_rehearsal_preflight_success(clean_db: JobRepository) -> None:
    """Preflight succeeds on a reachable database."""
    ok, error_msg = check_preflight(clean_db)
    assert ok is True
    assert error_msg is None


def test_rehearsal_preflight_failure_emits_concise_blocker() -> None:
    """Preflight failure produces a single actionable message without stack traces."""
    mock_repo = MagicMock()
    mock_repo.get_connection.side_effect = RuntimeError("Connection refused")

    ok, error_msg = check_preflight(mock_repo)
    assert ok is False
    assert "PostgreSQL database is unreachable" in error_msg
    assert "Ensure local PostgreSQL is active" in error_msg


def test_cleanup_preserves_reused_supervised_server_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cleanup must not hide a healthy server that the rehearsal did not start."""
    state_file = tmp_path / ".control_center.json"
    state_file.write_text(json.dumps({"pid": 4242, "url": "http://127.0.0.1:8765"}))
    monkeypatch.setattr("scripts.run_rehearsal.WORKSPACE_STATE_FILE", state_file)

    result = cleanup_rehearsal_state(MagicMock(), proc=None, stop_existing=False)

    assert state_file.exists()
    assert result["state_removed"] is False


def test_rehearsal_context_manager_output_and_cleanup(clean_db: JobRepository, capsys) -> None:
    """
    RehearsalSession generates a safe briefing and session,
    emits the single progress line, and cleans up all state on exit.
    """
    state_before = _workspace_state_contents()

    with RehearsalSession(limit=5, repo=clean_db) as session:
        out = capsys.readouterr().out
        # 1. Short progress line
        assert "Running a safe rehearsal..." in out

        # 2. Briefing and dashboard URL generated
        assert session.briefing is not None
        assert session.dashboard_url is not None
        assert "/redeem?token=" in session.dashboard_url
        assert "Morning Job Search Briefing" in session.markdown_summary

        # 3. Verify safety invariants in DB during active rehearsal
        with clean_db.get_connection() as conn:
            with conn.cursor() as cur:
                # Briefing exists with rehearsal schedule
                cur.execute(
                    "SELECT COUNT(*) FROM job_briefings WHERE schedule_name = %s;",
                    (REHEARSAL_SCHEDULE,)
                )
                assert _get_count(cur.fetchone()) >= 1

                # No resumes were approved autonomously
                cur.execute("SELECT COUNT(*) FROM resume_versions WHERE human_approved_at IS NOT NULL;")
                assert _get_count(cur.fetchone()) == 0

                cur.execute(
                    "SELECT COUNT(*) FROM ui_sessions WHERE conversation_id = %s;",
                    (REHEARSAL_CONVERSATION,)
                )
                assert _get_count(cur.fetchone()) >= 1

    # 4. Invariant: Teardown leaves no rehearsal records or state files
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM job_briefings WHERE schedule_name = %s;",
                (REHEARSAL_SCHEDULE,)
            )
            assert _get_count(cur.fetchone()) == 0

            cur.execute(
                "SELECT COUNT(*) FROM ui_sessions WHERE conversation_id = %s;",
                (REHEARSAL_CONVERSATION,)
            )
            assert _get_count(cur.fetchone()) == 0

    assert _workspace_state_contents() == state_before


def test_rehearsal_cli_non_interactive_execution() -> None:
    """
    Running run_rehearsal.py --non-interactive executes end-to-end,
    produces clean output with checklist and safety statement, and cleans up.
    """
    state_before = _workspace_state_contents()
    cmd = [sys.executable, str(BASE_DIR / "scripts" / "run_rehearsal.py"), "--non-interactive", "--limit", "5"]
    result = subprocess.run(cmd, cwd=str(BASE_DIR), capture_output=True, text=True)

    assert result.returncode == 0
    stdout = result.stdout

    # Progress message
    assert "Running a safe rehearsal..." in stdout

    # Markdown table and dashboard URL
    assert "Morning Job Search Briefing" in stdout
    assert "One-Time Dashboard URL: http://127.0.0.1:" in stdout

    # Human verification checklist
    assert "Verification Checklist:" in stdout
    assert "- Search by title and company" in stdout
    assert "- Pressing 'Prepare Selected' and verifying results dialog" in stdout

    # Safety boundary statement
    assert "Safety Invariant: Automation is paused at human selection." in stdout

    # No internal debugging archaeology
    assert "Traceback" not in stdout
    assert "SELECT " not in stdout
    assert "information_schema" not in stdout

    # Clean teardown
    assert _workspace_state_contents() == state_before
