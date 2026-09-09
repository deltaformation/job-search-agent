"""
Comprehensive test suite for Milestone 6: Morning Job Dashboard.
Verifies discovery window calculation, immutable snapshots, normalizations,
dashboard UI accessibility and controls, atomic batch preparation,
outbox notification, and strict human safety boundaries.
"""
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
from uuid import uuid4
import psycopg
import pytest
from starlette.testclient import TestClient

from services.briefing.service import BriefingService
from services.memory.repository import JobRepository
from services.ui.app import create_app
from services.ui.briefing_view import render_briefing_dashboard_html
from services.ui.notifier import LeasedOutboxWorker, MockNotificationSender
from services.ui.security import generate_csrf_token
from services.ui.sessions import SessionManager


@pytest.fixture(autouse=True)
def drain_pending_actions(clean_db: JobRepository) -> None:
    """Ensure clean outbox state for each test."""
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE ui_actions SET status = 'DELIVERED' WHERE status = 'PENDING';")
        conn.commit()


# Helper to insert test job
def create_test_job(
    repo: JobRepository,
    title: str = "Staff Product Manager",
    company: str = "Acme Corp",
    remote_type: str = "remote",
    min_amount: float = 140000.0,
    max_amount: float = 180000.0,
    status: str = "NEW",
    score: float = 85.0
) -> str:
    jid = str(uuid4())
    now = datetime.now(timezone.utc)
    with repo.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO jobs (
                    job_id, source, source_job_id, canonical_url, company, title, normalized_title,
                    location, remote_type, min_amount, max_amount, currency,
                    description, status, freshness_bucket, content_hash,
                    first_seen_at, created_at, updated_at
                ) VALUES (%s, 'test_source', %s, %s, %s, %s, %s, %s, %s, %s, %s, 'USD', %s, %s, 'HOT', %s, %s, %s, %s)
                RETURNING job_id;
            """, (
                jid, jid, f"https://example.com/jobs/{jid}", company, title, title.lower(),
                "Toronto, ON", remote_type, min_amount, max_amount,
                "Description for " + title, status, f"hash_{jid}",
                now, now, now
            ))

            # Add score using repo.save_job_score
            score_data = {
                "overall_score": score,
                "recommendation": "RECOMMENDED" if score >= 80.0 else "CONSIDER",
                "role_alignment": score,
                "experience_score": score,
                "seniority_score": score,
                "skills_score": score,
                "domain_score": score,
                "location_score": score,
                "comp_score": score,
                "preference_score": score,
                "strengths": ["Proven PM track record", "Strong system architecture"],
                "gaps": ["Requires AWS certifications"],
                "risks": ["Travel 20%"],
                "evidence_fact_ids": ["fact_001"],
                "keyword_coverage": {"coverage_percentage": 75.0},
                "is_provisional": False,
                "evidence_coverage": 80.0,
                "score_band": "HIGH" if score >= 80.0 else "MEDIUM",
                "factor_breakdown": {},
                "uncertainties": [],
                "scoring_version": "v2"
            }
        conn.commit()
    repo.save_job_score(jid, score_data)
    return jid


# -------------------------------------------------------------
# 1. Correct "New Since Last Briefing" Window Boundary
# -------------------------------------------------------------
def test_new_since_last_briefing_window(clean_db: JobRepository) -> None:
    service = BriefingService(repo=clean_db)

    # 1. Initial run: no previous briefing exists -> falls back to default window
    start1, end1 = clean_db.compute_new_jobs_window(schedule_name="morning_scan_test", default_window_hours=24.0)
    expected_delta = end1 - start1
    assert abs(expected_delta.total_seconds() - 86400) < 5

    # 2. Create a briefing with specific window
    anchor_start = datetime.now(timezone.utc) - timedelta(hours=10)
    anchor_end = datetime.now(timezone.utc) - timedelta(hours=2)
    clean_db.create_job_briefing(
        schedule_name="morning_scan_test",
        window_started_at=anchor_start,
        window_ended_at=anchor_end,
        source_run_ids=[],
        metrics={"total_items": 0},
        items=[]
    )

    # 3. Next window calculation must start exactly at the previous window_ended_at
    start2, end2 = clean_db.compute_new_jobs_window(schedule_name="morning_scan_test")
    assert abs((start2 - anchor_end).total_seconds()) < 1.0
    assert end2 > start2


def test_triggering_run_makes_briefing_creation_idempotent(clean_db: JobRepository) -> None:
    service = BriefingService(repo=clean_db)
    create_test_job(clean_db, title="Idempotent Briefing Role")
    run_id = clean_db.start_agent_run("morning_scan", "idempotent_briefing_test")
    clean_db.finalize_agent_run(run_id, "COMPLETED")

    first = service.create_briefing(
        schedule_name="idempotent_briefing_test",
        trigger_run_id=run_id,
    )
    second = service.create_briefing(
        schedule_name="idempotent_briefing_test",
        trigger_run_id=run_id,
    )

    assert first["id"] == second["id"]
    with clean_db.get_connection() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM job_briefings WHERE trigger_run_id = %s;",
            (run_id,),
        ).fetchone()["count"]
    assert count == 1


# -------------------------------------------------------------
# 2. Stable Briefing Snapshots (Immutable Audit Protection)
# -------------------------------------------------------------
def test_stable_briefing_snapshots(clean_db: JobRepository) -> None:
    service = BriefingService(repo=clean_db)
    jid = create_test_job(clean_db, title="Original Role Title", company="Original Tech", score=90.0)

    # Generate briefing
    briefing = service.create_briefing(schedule_name="snapshot_test", window_hours=24.0)
    briefing_id = str(briefing["id"])
    items = clean_db.get_briefing_items(briefing_id)
    assert len(items) >= 1

    item_for_job = [it for it in items if str(it["job_id"]) == jid][0]
    snap = item_for_job["snapshot"]
    assert snap["title"] == "Original Role Title"
    assert snap["company"] == "Original Tech"
    assert snap["overall_score"] == 90.0

    # Mutate the underlying job record in the database
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE jobs
                SET title = 'Tampered Role', company = 'Tampered Corp'
                WHERE job_id = %s;
            """, (jid,))
            cur.execute("""
                UPDATE job_scores
                SET overall_score = 15.0
                WHERE job_id = %s;
            """, (jid,))
        conn.commit()

    # Re-fetch briefing items: frozen snapshot MUST remain untouched
    re_fetched_items = clean_db.get_briefing_items(briefing_id)
    re_fetched_snap = [it for it in re_fetched_items if str(it["job_id"]) == jid][0]["snapshot"]
    assert re_fetched_snap["title"] == "Original Role Title"
    assert re_fetched_snap["company"] == "Original Tech"
    assert re_fetched_snap["overall_score"] == 90.0

    # Direct UPDATE or DELETE on job_briefing_items must be blocked by DB trigger
    with pytest.raises(psycopg.errors.RaiseException, match="strictly append-only and frozen"):
        with clean_db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE job_briefing_items
                    SET rank = 99
                    WHERE id = %s;
                """, (item_for_job["id"],))

    with pytest.raises(psycopg.errors.RaiseException, match="audit content is immutable"):
        with clean_db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE job_briefings SET metrics = '{}'::jsonb WHERE id = %s;",
                    (briefing_id,),
                )


# -------------------------------------------------------------
# 3. Salary & Compensation Normalization
# -------------------------------------------------------------
def test_salary_and_compensation_normalization() -> None:
    norm = BriefingService.normalize_compensation

    # Range
    assert norm(140000, 180000, "USD", "yearly") == "$140k - $180k / yr"
    # Single point
    assert norm(150000, 150000, "USD", "yearly") == "$150k / yr"
    # Min only
    assert norm(160000, None, "CAD", "yearly") == "CAD $160k+ / yr"
    # Max only
    assert norm(None, 200000, "USD", "yearly") == "Up to $200k / yr"
    # Undisclosed / absent
    assert norm(None, None, None, None) == "Not disclosed"
    # Hourly
    assert norm(75, 90, "USD", "hour") == "$75 - $90 / hr"


# -------------------------------------------------------------
# 4. Remote / Hybrid / On-site Normalization
# -------------------------------------------------------------
def test_remote_work_arrangement_normalization() -> None:
    norm = BriefingService.normalize_work_arrangement

    assert norm("Fully Remote - USA") == "Remote"
    assert norm("remote") == "Remote"
    assert norm("Hybrid (3 days in office)") == "Hybrid"
    assert norm("hybrid") == "Hybrid"
    assert norm("Onsite") == "On-site"
    assert norm("in_office") == "On-site"
    assert norm(None) == "On-site"


# -------------------------------------------------------------
# 5. Partial Discovery Failure Visibility
# -------------------------------------------------------------
def test_partial_discovery_failure_visibility(clean_db: JobRepository) -> None:
    run_id = clean_db.start_agent_run("morning_scan", "test_discovery_vis")
    clean_db.save_discovery_observation(run_id, {
        "source": "linkedin", "query": {}, "status": "success", "records_received": 12,
    })
    clean_db.save_discovery_observation(run_id, {
        "source": "indeed", "query": {}, "status": "failed",
        "errors": [{"message": "HTTP 403 Forbidden"}],
    })
    clean_db.finalize_agent_run(run_id, "PARTIAL_FAILURE")

    service = BriefingService(repo=clean_db)
    briefing = service.create_briefing(schedule_name="test_discovery_vis", window_hours=1.0)
    source_status = briefing.get("metrics", {}).get("source_status", {})

    assert "linkedin" in source_status
    assert source_status["linkedin"] == "SUCCESS"
    assert "indeed" in source_status
    assert source_status["indeed"] == "FAILED"

    # Verify markdown representation shows source breakdown
    md = service.format_chat_markdown(briefing, "http://127.0.0.1:8765/redeem?token=xyz")
    assert "`indeed: FAILED`" in md
    assert "`linkedin: SUCCESS`" in md


def test_dashboard_escapes_untrusted_job_content() -> None:
    now = datetime.now(timezone.utc)
    hostile = "</SCRIPT><img src=x onerror=alert(1)>|line\nnext"
    briefing = {
        "id": uuid4(),
        "schedule_name": "<unsafe>",
        "window_started_at": now - timedelta(hours=1),
        "window_ended_at": now,
        "metrics": {},
    }
    items = [{
        "job_id": uuid4(),
        "rank": 1,
        "snapshot": {
            "title": hostile,
            "company": hostile,
            "source_url": "javascript:alert(1)",
        },
    }]

    rendered = render_briefing_dashboard_html(briefing, items, csrf_token="safe-token")

    assert hostile not in rendered
    assert "\\u003c/SCRIPT\\u003e" in rendered
    assert "escapeHtml(j.title)" in rendered
    assert "safeSourceUrl(j.source_url)" in rendered
    assert "Morning Job Briefing - &lt;unsafe&gt;" in rendered


def test_scheduled_runner_persists_briefing_after_success(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import scripts.run_scheduled_scan as scheduled_scan

    fake_repo = SimpleNamespace(
        get_pending_analysis_jobs=lambda limit: [],
        get_shortlist=lambda **kwargs: [],
    )
    create_calls = []

    class FakeConfig:
        def resolve_discovery_params(self, **kwargs):
            return {"hours_old": 24, "pipeline": {"min_score_to_shortlist": 80}}

    class FakeBriefingService:
        def __init__(self, **kwargs):
            pass

        def create_briefing(self, **kwargs):
            create_calls.append(kwargs)
            return {"id": "00000000-0000-0000-0000-000000000123"}

    monkeypatch.setattr(scheduled_scan, "JobRepository", lambda: fake_repo)
    monkeypatch.setattr(scheduled_scan, "FitScorer", lambda: object())
    monkeypatch.setattr(scheduled_scan, "AppConfig", FakeConfig)
    monkeypatch.setattr(
        scheduled_scan,
        "DiscoveryService",
        lambda **kwargs: SimpleNamespace(run_discovery=lambda **run_kwargs: {
            "run_id": "00000000-0000-0000-0000-000000000456",
            "status": "COMPLETED",
            "duration_seconds": 1,
            "metrics": {},
            "observations": [],
        }),
    )
    monkeypatch.setattr(scheduled_scan, "BriefingService", FakeBriefingService)
    monkeypatch.delenv("ANTIGRAVITY_CONVERSATION_ID", raising=False)
    monkeypatch.delenv("CONVERSATION_ID", raising=False)
    monkeypatch.delenv("AGY_CONVERSATION_ID", raising=False)

    assert scheduled_scan.run_scheduled_pipeline(limit=5) == 0
    assert create_calls == [{
        "schedule_name": "morning_scan",
        "window_hours": 24.0,
        "limit": 20,
        "trigger_run_id": "00000000-0000-0000-0000-000000000456",
    }]
    assert "Morning Briefing ID: 00000000-0000-0000-0000-000000000123" in capsys.readouterr().out


def test_scheduled_runner_dry_run_does_not_persist_briefing(monkeypatch: pytest.MonkeyPatch) -> None:
    import scripts.run_scheduled_scan as scheduled_scan

    fake_repo = SimpleNamespace(
        get_pending_analysis_jobs=lambda limit: [],
        get_shortlist=lambda **kwargs: [],
    )

    class FakeConfig:
        def resolve_discovery_params(self, **kwargs):
            return {"hours_old": 24, "pipeline": {"min_score_to_shortlist": 80}}

    monkeypatch.setattr(scheduled_scan, "JobRepository", lambda: fake_repo)
    monkeypatch.setattr(scheduled_scan, "FitScorer", lambda: object())
    monkeypatch.setattr(scheduled_scan, "AppConfig", FakeConfig)
    monkeypatch.setattr(
        scheduled_scan,
        "DiscoveryService",
        lambda **kwargs: SimpleNamespace(run_discovery=lambda **run_kwargs: {
            "run_id": None,
            "status": "COMPLETED",
            "duration_seconds": 1,
            "metrics": {},
            "observations": [],
        }),
    )
    monkeypatch.setattr(
        scheduled_scan,
        "BriefingService",
        lambda **kwargs: pytest.fail("dry runs must not create a briefing"),
    )

    assert scheduled_scan.run_scheduled_pipeline(limit=5, dry_run=True) == 0


# -------------------------------------------------------------
# 6. Dashboard HTML Rendering, Controls, and a11y Standards
# -------------------------------------------------------------
def test_dashboard_html_rendering_and_controls(clean_db: JobRepository) -> None:
    service = BriefingService(repo=clean_db)
    jid = create_test_job(clean_db, title="Lead TPM", company="CloudTech", score=88.0)
    briefing = service.create_briefing(schedule_name="html_test", window_hours=24.0)
    items = clean_db.get_briefing_items(str(briefing["id"]))

    html = render_briefing_dashboard_html(briefing, items, csrf_token="test_csrf_token")

    # 1. Semantic HTML elements
    assert "<table" in html
    assert "<th scope=\"col\"" in html
    assert "<dialog id=\"outcome-dialog\"" in html

    # 2. Interactive controls
    assert "id=\"search-input\"" in html
    assert "id=\"filter-rec\"" in html
    assert "id=\"filter-remote\"" in html
    assert "id=\"filter-freshness\"" in html
    assert "id=\"sort-select\"" in html
    assert "id=\"btn-select-all\"" in html
    assert "id=\"btn-clear-all\"" in html

    # 3. Primary action button exists
    assert "Prepare Selected" in html
    assert "id=\"btn-prepare-selected\"" in html

    # 4. Strict Safety: NO button labeled only "Apply"
    assert ">Apply<" not in html
    assert ">Apply</" not in html
    assert "value=\"Apply\"" not in html

    # 5. Accessibility features
    assert ":focus-visible" in html
    assert "prefers-reduced-motion" in html
    assert "aria-live=\"polite\"" in html
    assert "meta name=\"csrf-token\"" in html


# -------------------------------------------------------------
# 7. Selection Membership Validation
# -------------------------------------------------------------
def test_selection_membership_validation(clean_db: JobRepository) -> None:
    service = BriefingService(repo=clean_db)
    job_in_briefing = create_test_job(clean_db, title="In Briefing")
    job_not_in_briefing = create_test_job(clean_db, title="Outside Briefing")

    briefing = service.create_briefing(schedule_name="membership_test", limit=1)
    briefing_id = str(briefing["id"])

    # Attempting to prepare a job not belonging to the briefing must raise ValueError
    with pytest.raises(ValueError, match="does not belong to briefing"):
        clean_db.prepare_briefing_jobs(
            briefing_id=briefing_id,
            job_ids=[job_not_in_briefing],
            idempotency_key="test_idemp_1"
        )


# -------------------------------------------------------------
# 8. Mixed Valid, Blocked, and Already-Prepared Batch Behavior
# -------------------------------------------------------------
def test_mixed_valid_and_blocked_batch_behavior(clean_db: JobRepository) -> None:
    service = BriefingService(repo=clean_db)
    j_valid = create_test_job(clean_db, title="Job Valid")
    j_withdrawn = create_test_job(clean_db, title="Job Withdrawn", status="NEW")
    j_existing = create_test_job(clean_db, title="Job Existing")

    briefing = service.create_briefing(schedule_name="mixed_test", limit=10)
    briefing_id = str(briefing["id"])

    # Mark j_withdrawn as WITHDRAWN after briefing was created
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE jobs SET status = 'WITHDRAWN' WHERE job_id = %s;", (j_withdrawn,))
        conn.commit()

    # Pre-create a preparation request for j_existing
    clean_db.create_preparation_request(
        job_id=j_existing,
        idempotency_key="batch_test_" + j_existing,
        briefing_id=briefing_id
    )

    # Prepare batch of 3 jobs
    result = clean_db.prepare_briefing_jobs(
        briefing_id=briefing_id,
        job_ids=[j_valid, j_withdrawn, j_existing],
        idempotency_key="batch_test"
    )

    results = result["results"]
    assert len(results) == 3

    # 1. Valid job is queued
    assert results[j_valid]["status"] == "QUEUED"
    assert results[j_valid]["is_new"] is True

    # 2. Withdrawn job is blocked with reason
    assert results[j_withdrawn]["status"] == "BLOCKED"
    assert "WITHDRAWN" in results[j_withdrawn]["reason"]

    # 3. Existing job is identified as existing / ready
    assert results[j_existing]["status"] in ("QUEUED", "ALREADY_PREPARED")
    assert results[j_existing]["is_new"] is False


# -------------------------------------------------------------
# 9. API Prepare Endpoint & Outbox Notification
# -------------------------------------------------------------
def test_api_prepare_endpoint_and_outbox_notification(clean_db: JobRepository) -> None:
    session_mgr = SessionManager(clean_db)
    service = BriefingService(repo=clean_db)
    jid = create_test_job(clean_db, title="API Test Job")

    briefing = service.create_briefing(schedule_name="api_test", limit=5)
    briefing_id = str(briefing["id"])

    conv_id = f"conv_morning_{uuid4().hex}"
    raw_token, session = session_mgr.create_session(
        conversation_id=conv_id,
        workspace_path="/test",
        purpose="morning_briefing",
        allowed_actions=["prepare_selected"],
        allowed_entity_ids=[briefing_id]
    )

    app = create_app(repo=clean_db)
    client = TestClient(app, base_url="http://127.0.0.1")

    # 1. Redeem token
    redeem = client.get(f"/redeem?token={raw_token}", headers={"Host": "127.0.0.1"}, follow_redirects=False)
    assert redeem.status_code == 303
    assert f"/ui/briefings/{briefing_id}" in redeem.headers["Location"]
    cookie_val = redeem.cookies["session"]
    csrf_token = generate_csrf_token(cookie_val)

    # 2. Post prepare selected
    idemp = f"idemp_{uuid4().hex}"
    res = client.post(
        f"/api/briefings/{briefing_id}/prepare",
        json={
            "job_ids": [jid],
            "idempotency_key": idemp
        },
        cookies={"session": cookie_val},
        headers={
            "Host": "127.0.0.1",
            "Origin": "http://127.0.0.1",
            "X-CSRF-Token": csrf_token
        }
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["briefing_id"] == briefing_id
    assert jid in data["results"]
    assert data["results"][jid]["status"] == "QUEUED"

    action_id = data["action_id"]
    assert action_id is not None

    # 3. Verify outbox notification delivery
    mock_sender = MockNotificationSender(should_succeed=True)
    worker = LeasedOutboxWorker(repo=clean_db, sender=mock_sender)
    processed = worker.process_batch(limit=10)
    assert processed == 1

    assert len(mock_sender.sent_messages) == 1
    target_conv, msg = mock_sender.sent_messages[0]
    assert target_conv == conv_id
    assert msg["action_id"] == action_id
    assert msg["event"] == "prepare_selected"
    assert msg["payload"]["briefing_id"] == briefing_id


# -------------------------------------------------------------
# 10. Strict Verification: Absence of Approval and Submission Endpoints
# -------------------------------------------------------------
def test_strict_absence_of_approval_and_submission(clean_db: JobRepository) -> None:
    app = create_app(repo=clean_db)
    client = TestClient(app, base_url="http://127.0.0.1")
    hdrs = {"Host": "127.0.0.1", "Origin": "http://127.0.0.1"}

    # Assert 404 on any attempt to call premature approval or submission endpoints
    assert client.post("/api/resumes/approve", headers=hdrs).status_code == 404
    assert client.post("/api/applications/submit", headers=hdrs).status_code == 404
    assert client.post("/api/briefings/123/approve", headers=hdrs).status_code == 404
    assert client.post("/api/briefings/123/submit", headers=hdrs).status_code == 404


# -------------------------------------------------------------
# 11. MCP Morning Briefing Tools
# -------------------------------------------------------------
def test_mcp_morning_briefing_tools(clean_db: JobRepository, monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import patch
    import services.mcp.server as mcp_server

    monkeypatch.setattr(mcp_server, "repo", clean_db)
    monkeypatch.setattr(mcp_server.briefing_service, "repo", clean_db)
    monkeypatch.setattr(mcp_server.session_manager, "repo", clean_db)

    create_test_job(clean_db, title="MCP Role", score=82.0)

    # 1. create_morning_briefing
    res_str = mcp_server.create_morning_briefing(schedule_name="mcp_test", limit=5)
    res = json.loads(res_str)
    assert res["status"] == "success"
    briefing_id = res["briefing_id"]
    assert "/redeem?token=" in res["dashboard_url"]
    assert "Morning Job Search Briefing" in res["markdown_summary"]

    # 2. get_latest_briefing
    latest_str = mcp_server.get_latest_briefing(schedule_name="mcp_test")
    latest = json.loads(latest_str)
    assert latest["status"] == "success"
    assert str(latest["briefing"]["id"]) == briefing_id

    # 3. get_briefing_details
    details_str = mcp_server.get_briefing_details(briefing_id)
    details = json.loads(details_str)
    assert details["status"] == "success"
    assert len(details["briefing"]["items"]) >= 1
