"""
Tests for Milestone 7: Deterministic Agent Discovery Kickstart.

Verifies:
1. Canonical configuration resolution (strictly from config/jobs.yaml, no presets or overrides).
2. Deterministic configuration hash (SHA-256).
3. Preflight blocker detection and recovery guidance (DB offline, missing candidate profile).
4. Candidate snapshot reuse across multiple queued jobs.
5. Lossless JD snapshots and complete, self-contained analysis context.
6. Structured AgentDiscoveryContextV1 envelope and deterministic queue generation.
7. Sequential progression through MCP tools and next_action hints.
8. CLI fallback output and flags.
"""
from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from services.discovery.agent_workflow import AgentDiscoveryWorkflow
from services.discovery.config import AppConfig
from services.discovery.service import DiscoveryService
from services.intelligence.context import AnalysisContextBuilder
from services.memory.repository import JobRepository
from services.mcp import server as mcp_module
from scripts.run_agent_discovery import main as cli_main


def test_canonical_configuration_hash() -> None:
    """Verifies that the configuration hash is deterministic and strictly uses canonical jobs.yaml."""
    config = AppConfig()
    workflow = AgentDiscoveryWorkflow(config=config)

    params1 = config.resolve_discovery_params()
    hash1 = workflow.compute_config_hash(params1)

    params2 = config.resolve_discovery_params()
    hash2 = workflow.compute_config_hash(params2)

    assert hash1 == hash2
    assert len(hash1) == 64
    assert all(c in "0123456789abcdef" for c in hash1)

    # Ensure no presets or query overrides are accepted by the workflow start method
    import inspect
    sig = inspect.signature(workflow.start_default_discovery)
    assert "preset" not in sig.parameters
    assert "roles" not in sig.parameters
    assert "locations" not in sig.parameters


def test_preflight_blocker_db_failure() -> None:
    """Verifies that a database connectivity failure returns a blocked context with recovery command."""
    mock_repo = MagicMock(spec=JobRepository)
    mock_repo.get_connection.side_effect = Exception("Connection refused on port 5432")

    workflow = AgentDiscoveryWorkflow(repo=mock_repo)
    result = workflow.start_default_discovery(dry_run=True)

    assert result["schema_version"] == "agent-discovery-context/v1"
    assert result["status"] == "blocked"
    assert result["embedded_analysis_context"] is None
    assert result["queue"] == []

    next_action = result["next_action"]
    assert next_action["action"] == "resolve_blocker"
    assert next_action["tool"] is None
    assert next_action["blocker_type"] == "database_unavailable"
    assert "recovery_command" in next_action
    assert "brew services start postgresql@16" in next_action["recovery_command"]


def test_preflight_blocker_missing_candidate_profile() -> None:
    """Verifies that a missing candidate profile returns a blocked context with seed command."""
    mock_repo = MagicMock(spec=JobRepository)
    mock_conn = MagicMock()
    mock_repo.get_connection.return_value.__enter__.return_value = mock_conn
    mock_repo.get_candidate_profile.return_value = None

    workflow = AgentDiscoveryWorkflow(repo=mock_repo)
    result = workflow.start_default_discovery(dry_run=True)

    assert result["status"] == "blocked"
    next_action = result["next_action"]
    assert next_action["action"] == "resolve_blocker"
    assert next_action["blocker_type"] == "candidate_profile_missing"
    assert ".venv/bin/python scripts/init_db.py --seed" in next_action["recovery_command"]


def test_candidate_snapshot_reuse_across_jobs(isolated_repo: JobRepository) -> None:
    """Verifies that AnalysisContextBuilder creates and reuses the exact same candidate snapshot across jobs."""
    profile = isolated_repo.get_candidate_profile()
    assert profile is not None

    builder = AnalysisContextBuilder(repo=isolated_repo)

    # Insert two test jobs
    now = datetime.now(timezone.utc)
    job1_data = {
        "title": "Staff Platform Engineer",
        "company": "InfraCorp",
        "location": "Toronto, ON",
        "description": "Building cloud infrastructure with AWS and Kubernetes.",
        "canonical_url": f"https://example.com/jobs/{now.timestamp()}-1",
        "first_seen_at": now,
        "posted_at": now,
        "assessment_status": "ANALYSIS_PENDING",
    }
    job2_data = {
        "title": "Principal Architect",
        "company": "CloudNative Inc",
        "location": "Remote, Canada",
        "description": "Architecting multi-region systems with Kafka and Go.",
        "canonical_url": f"https://example.com/jobs/{now.timestamp()}-2",
        "first_seen_at": now,
        "posted_at": now,
        "assessment_status": "ANALYSIS_PENDING",
    }

    job1, _ = isolated_repo.upsert_job(job1_data, {"source_name": "indeed", "source_url": job1_data["canonical_url"]})
    job2, _ = isolated_repo.upsert_job(job2_data, {"source_name": "indeed", "source_url": job2_data["canonical_url"]})
    job1_id = str(job1["job_id"])
    job2_id = str(job2["job_id"])

    ctx1 = builder.build_for_job(job1_id)
    ctx2 = builder.build_for_job(job2_id)

    assert ctx1 is not None
    assert ctx2 is not None
    assert ctx1["candidate_snapshot_id"] == ctx2["candidate_snapshot_id"]
    assert ctx1["candidate_snapshot_hash"] == ctx2["candidate_snapshot_hash"]

    # Verify JD snapshots are distinct for distinct jobs
    assert ctx1["jd_snapshot_id"] != ctx2["jd_snapshot_id"]


def test_lossless_jd_and_self_contained_context(isolated_repo: JobRepository) -> None:
    """Verifies that the job description is preserved without lossy truncation and all invariants are present."""
    raw_desc = (
        "We are looking for a Senior Technical Product Manager.\n"
        "Responsibilities:\n"
        "- Drive multi-region cloud API architecture.\n"
        "- Scale systems to 50M+ daily requests.\n"
        "Requirements:\n"
        "- 5+ years building distributed platforms.\n"
        "- Strong AWS & Kafka background."
    )

    now = datetime.now(timezone.utc)
    job_data = {
        "title": "Lead Technical Product Manager",
        "company": "DataScale Systems",
        "location": "Toronto, ON",
        "description": raw_desc,
        "canonical_url": f"https://example.com/jobs/{now.timestamp()}-lossless",
        "first_seen_at": now,
        "posted_at": now,
        "assessment_status": "ANALYSIS_PENDING",
    }
    job, _ = isolated_repo.upsert_job(job_data, {"source_name": "indeed", "source_url": job_data["canonical_url"]})
    job_id = str(job["job_id"])

    builder = AnalysisContextBuilder(repo=isolated_repo)
    ctx = builder.build_for_job(job_id)

    assert ctx is not None
    assert ctx["job_description"] == raw_desc  # Exact lossless preservation
    assert len(ctx["verified_facts"]) > 0
    assert "fact_id" in ctx["verified_facts"][0]
    assert ctx["verified_facts_count"] == len(ctx["verified_facts"])

    # Verify template and enums
    template = ctx["submission_template"]
    assert template["job_id"] == str(job_id)
    assert template["jd_snapshot_id"] == ctx["jd_snapshot_id"]
    assert template["candidate_snapshot_id"] == ctx["candidate_snapshot_id"]

    enums = ctx["allowed_enums"]
    assert "required" in enums["importance"]
    assert "matched" in enums["match_status"]
    assert enums["review_status"] == ["proposed"]  # Only proposed allowed for agent

    # Verify truthfulness rules are embedded
    assert any("Never invent facts" in r for r in ctx["truthfulness_rules"])
    assert any("verbatim" in r for r in ctx["truthfulness_rules"])


def test_agent_discovery_workflow_full_envelope(isolated_repo: JobRepository) -> None:
    """Verifies that start_default_discovery returns a complete AgentDiscoveryContextV1 envelope with embedded first context."""
    from uuid import uuid4
    uid = uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    job_data = {
        "title": f"Senior Product Manager - Platform {uid}",
        "company": f"Fintech Global {uid}",
        "location": "Toronto, ON",
        "description": "Build high-throughput payment pipelines on AWS with Kafka.",
        "canonical_url": f"https://example.com/jobs/{now.timestamp()}-{uid}",
        "first_seen_at": now,
        "posted_at": now,
        "assessment_status": "ANALYSIS_PENDING",
    }
    with isolated_repo.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE jobs SET assessment_status = 'ANALYZED';")
        conn.commit()

    job, _ = isolated_repo.upsert_job(job_data, {"source_name": "indeed", "source_url": job_data["canonical_url"]})
    job_id = str(job["job_id"])
    isolated_repo.save_job_score(job_id, {"overall_score": 88.5, "recommendation": "apply", "score_band": "strong"})

    # Mock discovery run to avoid network requests
    mock_discovery = MagicMock()
    mock_discovery.run_discovery.return_value = {
        "status": "SUCCESS",
        "duration_seconds": 1.45,
        "run_id": "run_test_123",
        "metrics": {"jobs_found": 5, "jobs_new": 1, "jobs_scored": 1},
        "errors": [],
    }

    workflow = AgentDiscoveryWorkflow(
        repo=isolated_repo,
        discovery_service=mock_discovery,
    )

    result = workflow.start_default_discovery(dry_run=True)

    assert result["schema_version"] == "agent-discovery-context/v1"
    assert result["status"] == "ready"
    assert result["run_id"] == "run_test_123"
    assert result["queue_count"] >= 1
    assert result["queue"][0]["job_id"] == str(job_id)
    assert result["queue"][0]["snapshot_readiness"] is True

    # Embedded context must match the first job in the queue
    embedded = result["embedded_analysis_context"]
    assert embedded is not None
    assert embedded["job_id"] == str(job_id)
    assert embedded["title"] == job_data["title"]

    # Next action must guide the agent directly to submit_analysis_version
    next_act = result["next_action"]
    assert next_act["action"] == "submit_analysis"
    assert next_act["target_job_id"] == str(job_id)
    assert next_act["tool"] == "submit_analysis_version"
    assert next_act["subsequent_tool"] == "get_next_analysis_context"


def test_sequential_mcp_progression(isolated_repo: JobRepository) -> None:
    """Verifies MCP tools: start_default_discovery, get_next_analysis_context, and submit_analysis_version next_action."""
    # Temporarily patch repo in mcp_module to use isolated_repo
    with patch.object(mcp_module, "repo", isolated_repo), \
         patch.object(mcp_module.agent_workflow, "repo", isolated_repo), \
         patch.object(mcp_module.context_builder, "repo", isolated_repo):

        with isolated_repo.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE jobs SET assessment_status = 'ANALYZED';")
            conn.commit()

        from uuid import uuid4
        uid = uuid4().hex[:8]
        now = datetime.now(timezone.utc)
        job_data = {
            "title": f"Cloud Platform Architect {uid}",
            "company": f"SecureNet {uid}",
            "location": "Toronto, ON",
            "description": "5+ years experience building cloud platforms with AWS and Kafka.",
            "canonical_url": f"https://example.com/jobs/{now.timestamp()}-{uid}",
            "first_seen_at": now,
            "posted_at": now,
            "assessment_status": "ANALYSIS_PENDING",
        }
        job, _ = isolated_repo.upsert_job(job_data, {"source_name": "indeed", "source_url": job_data["canonical_url"]})
        job_id = str(job["job_id"])
        isolated_repo.save_job_score(job_id, {"overall_score": 89.0, "recommendation": "apply", "score_band": "strong"})

        # 1. Fetch analysis context via get_job_analysis_context
        ctx_raw = mcp_module.get_job_analysis_context(str(job_id))
        ctx = json.loads(ctx_raw)
        assert ctx["job_id"] == str(job_id)
        assert "jd_snapshot_id" in ctx
        assert "candidate_snapshot_id" in ctx

        # 2. Submit valid requirement analysis
        submission = {
            "job_id": str(job_id),
            "jd_snapshot_id": ctx["jd_snapshot_id"],
            "candidate_snapshot_id": ctx["candidate_snapshot_id"],
            "notes": "Strong match on cloud platforms and Kafka.",
            "requirements": [
                {
                    "requirement_id": "req_001",
                    "jd_quote": "5+ years experience building cloud platforms with AWS and Kafka.",
                    "description": "Cloud platform experience",
                    "category": "experience",
                    "importance": "required",
                    "match_status": "partial",
                    "evidence_fact_ids": ["fact_001"],
                    "evidence_quotes": ["Architected and launched a distributed multi-region API platform reducing p99 latency by 42% while scaling to 50M+ daily requests."],
                    "review_status": "proposed"
                }
            ]
        }

        sub_resp_raw = mcp_module.submit_analysis_version(submission)
        sub_resp = json.loads(sub_resp_raw)
        assert sub_resp["status"] == "success", sub_resp
        assert "next_action" in sub_resp

        # 3. Call get_next_analysis_context when queue is drained
        next_raw = mcp_module.get_next_analysis_context()
        next_res = json.loads(next_raw)
        assert next_res["status"] == "complete"
        assert next_res["next_action"]["action"] == "create_morning_briefing"
        assert next_res["next_action"]["tool"] == "create_morning_briefing"


def test_cli_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verifies that scripts/run_agent_discovery.py runs and produces valid AgentDiscoveryContextV1 JSON."""
    monkeypatch.setattr(
        DiscoveryService,
        "run_discovery",
        lambda *args, **kwargs: {
            "status": "SUCCESS",
            "duration_seconds": 0.1,
            "run_id": "run_cli_test",
            "metrics": {"jobs_found": 0, "jobs_new": 0},
            "errors": [],
        },
    )
    monkeypatch.setattr(sys, "argv", ["run_agent_discovery.py", "--dry-run", "--pretty"])

    buf = io.StringIO()
    with redirect_stdout(buf):
        exit_code = cli_main()

    assert exit_code in (0, 1)
    output = json.loads(buf.getvalue())
    assert output["schema_version"] == "agent-discovery-context/v1"
    assert "config_hash" in output
    assert "status" in output
    assert "next_action" in output
