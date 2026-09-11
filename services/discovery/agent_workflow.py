"""
Deterministic Agent Discovery Workflow.

Implements Milestone 7: Deterministic Agent Discovery Kickstart.
Provides AgentDiscoveryWorkflow for single-call kickoff of the canonical discovery pipeline,
deterministic queue generation, embedded first-job analysis context, and bounded recovery actions.
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, List, Optional

from services.discovery.config import AppConfig
from services.discovery.service import DiscoveryService
from services.intelligence.context import AnalysisContextBuilder, sanitize_value
from services.intelligence.scorer import FitScorer
from services.memory.repository import JobRepository

logger = logging.getLogger("agent_workflow")


class AgentDiscoveryWorkflow:
    """
    Orchestrates the canonical live job search discovery kickstart for agent sessions.
    
    Guarantees:
    1. Single canonical search configuration (resolved strictly from config/jobs.yaml, no overrides).
    2. Deterministic configuration hash (SHA-256 of canonical search parameters).
    3. Safe preflight checks (DB connectivity and candidate profile availability).
    4. Deterministic queue of jobs awaiting structured analysis.
    5. Embedded analysis context for the first queued job (reusing candidate snapshot).
    6. Explicit, machine-readable next_action guidance.
    """

    SCHEMA_VERSION = "agent-discovery-context/v1"

    def __init__(
        self,
        repo: Optional[JobRepository] = None,
        scorer: Optional[FitScorer] = None,
        config: Optional[AppConfig] = None,
        discovery_service: Optional[DiscoveryService] = None,
        context_builder: Optional[AnalysisContextBuilder] = None,
    ) -> None:
        self.repo = repo or JobRepository()
        self.scorer = scorer or FitScorer()
        self.config = config or AppConfig()
        self.discovery_service = discovery_service or DiscoveryService(
            repo=self.repo, scorer=self.scorer, config=self.config
        )
        self.context_builder = context_builder or AnalysisContextBuilder(
            repo=self.repo, scorer=self.scorer
        )

    def compute_config_hash(self, params: Dict[str, Any]) -> str:
        """Computes a deterministic SHA-256 hash of canonical search parameters."""
        canonical_dict = {
            "country": params.get("country"),
            "roles": sorted(params.get("roles", [])),
            "locations": sorted(params.get("locations", [])),
            "sources": sorted(params.get("sources", [])),
            "max_results_per_query": params.get("max_results_per_query"),
            "hours_old": params.get("hours_old"),
            "primary_hours": params.get("primary_hours"),
            "secondary_hours": params.get("secondary_hours"),
            "title_filter": params.get("title_filter", {}),
        }
        raw_json = json.dumps(canonical_dict, sort_keys=True)
        return hashlib.sha256(raw_json.encode("utf-8")).hexdigest()

    def check_preflight(self) -> Optional[Dict[str, Any]]:
        """
        Runs preflight checks before launching discovery.
        Returns a blocker dict if any check fails, or None if healthy.
        """
        # 1. Check database connectivity
        try:
            with self.repo.get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1;")
        except Exception as exc:
            logger.error("Preflight check failed: database unreachable: %s", exc)
            return {
                "blocker_type": "database_unavailable",
                "message": f"Database unreachable: {exc}",
                "recovery_command": "brew services start postgresql@16",
            }

        # 2. Check candidate profile availability
        try:
            profile = self.repo.get_candidate_profile()
            if not profile:
                return {
                    "blocker_type": "candidate_profile_missing",
                    "message": "No candidate profile found in database.",
                    "recovery_command": ".venv/bin/python scripts/init_db.py --seed",
                }
        except Exception as exc:
            logger.error("Preflight check failed while querying profile: %s", exc)
            return {
                "blocker_type": "candidate_profile_error",
                "message": f"Error accessing candidate profile: {exc}",
                "recovery_command": ".venv/bin/python scripts/init_db.py --seed",
            }

        return None

    def start_default_discovery(
        self,
        dry_run: bool = False,
        queue_limit: int = 10,
        min_score: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Executes canonical live job discovery and returns the AgentDiscoveryContextV1 envelope.
        
        Args:
            dry_run: If True, scrapes and filters without committing DB side-effects.
            queue_limit: Maximum number of pending analysis jobs to include in the queue.
            min_score: Optional minimum fit score filter for the pending analysis queue.
        """
        # 1. Resolve canonical search parameters without any overrides
        canonical_params = self.config.resolve_discovery_params()
        config_hash = self.compute_config_hash(canonical_params)

        # 2. Preflight verification
        blocker = self.check_preflight()
        if blocker:
            return sanitize_value({
                "schema_version": self.SCHEMA_VERSION,
                "status": "blocked",
                "config_hash": config_hash,
                "run_id": None,
                "dry_run": dry_run,
                "discovery_summary": None,
                "queue_count": 0,
                "queue": [],
                "embedded_analysis_context": None,
                "next_action": {
                    "action": "resolve_blocker",
                    "tool": None,
                    "blocker_type": blocker["blocker_type"],
                    "instruction": blocker["message"],
                    "recovery_command": blocker["recovery_command"],
                },
            })

        # 3. Execute discovery via DiscoveryService
        discovery_summary: Dict[str, Any] = {}
        discovery_errors: List[str] = []
        run_id: Optional[str] = None
        discovery_status = "SUCCESS"

        try:
            # We explicitly pass no overrides to run_discovery to guarantee canonical behavior
            disc_res = self.discovery_service.run_discovery(dry_run=dry_run)
            run_id = disc_res.get("run_id")
            discovery_status = disc_res.get("status", "SUCCESS")
            discovery_errors = disc_res.get("errors", [])
            discovery_summary = {
                "status": discovery_status,
                "duration_seconds": disc_res.get("duration_seconds", 0.0),
                "metrics": disc_res.get("metrics", {}),
                "errors": discovery_errors,
            }
        except Exception as exc:
            logger.error("Discovery execution failed: %s", exc, exc_info=True)
            discovery_status = "FAILED"
            discovery_errors = [str(exc)]
            discovery_summary = {
                "status": "FAILED",
                "duration_seconds": 0.0,
                "metrics": {},
                "errors": discovery_errors,
            }

        # 4. Deterministic pending analysis queue
        queue: List[Dict[str, Any]] = []
        try:
            pending_jobs = self.repo.get_pending_analysis_jobs(
                limit=queue_limit, min_score=min_score
            )
            for j in pending_jobs:
                queue.append({
                    "job_id": str(j["job_id"]),
                    "title": j.get("title"),
                    "company": j.get("company"),
                    "location": j.get("location"),
                    "remote_type": j.get("remote_type"),
                    "freshness": j.get("freshness_bucket"),
                    "provisional_score": float(j["overall_score"]) if j.get("overall_score") is not None else None,
                    "assessment_status": j.get("assessment_status"),
                    "snapshot_readiness": True,
                })
        except Exception as exc:
            logger.warning("Failed to retrieve pending analysis queue: %s", exc)

        # 5. Embed complete analysis context for the first queued job
        embedded_analysis_context: Optional[Dict[str, Any]] = None
        if queue:
            first_job_id = queue[0]["job_id"]
            try:
                embedded_analysis_context = self.context_builder.build_for_job(first_job_id)
            except Exception as exc:
                logger.error("Failed to build embedded analysis context for job %s: %s", first_job_id, exc)

        # 6. Determine workflow status and next action
        if discovery_status == "FAILED" and not queue:
            workflow_status = "partial_failure"
            next_action = {
                "action": "review_errors",
                "tool": None,
                "instruction": f"Discovery failed: {'; '.join(discovery_errors)}",
                "recovery_command": ".venv/bin/python scripts/run_agent_discovery.py",
            }
        elif discovery_status in ("COMPLETED_WITH_ERRORS", "PARTIAL"):
            workflow_status = "partial_failure"
            if queue:
                next_action = {
                    "action": "submit_analysis",
                    "target_job_id": queue[0]["job_id"],
                    "target_title": queue[0]["title"],
                    "target_company": queue[0]["company"],
                    "tool": "submit_analysis_version",
                    "instruction": (
                        "Discovery completed with some board warnings. Review embedded analysis context "
                        "for the first job and call submit_analysis_version."
                    ),
                    "subsequent_tool": "get_next_analysis_context",
                }
            else:
                next_action = {
                    "action": "create_morning_briefing",
                    "tool": "create_morning_briefing",
                    "instruction": "Discovery finished. No pending jobs require analysis. Generate morning briefing.",
                }
        else:
            if queue:
                workflow_status = "ready"
                next_action = {
                    "action": "submit_analysis",
                    "target_job_id": queue[0]["job_id"],
                    "target_title": queue[0]["title"],
                    "target_company": queue[0]["company"],
                    "tool": "submit_analysis_version",
                    "instruction": (
                        "Review the embedded analysis context for the first queued job, verify JD quotes "
                        "and candidate fact IDs, and submit requirement analysis using submit_analysis_version."
                    ),
                    "subsequent_tool": "get_next_analysis_context",
                }
            else:
                workflow_status = "complete"
                next_action = {
                    "action": "create_morning_briefing",
                    "tool": "create_morning_briefing",
                    "instruction": "No pending jobs require analysis. Call create_morning_briefing to generate the daily briefing.",
                }

        context_envelope = {
            "schema_version": self.SCHEMA_VERSION,
            "status": workflow_status,
            "config_hash": config_hash,
            "run_id": run_id,
            "dry_run": dry_run,
            "discovery_summary": discovery_summary,
            "queue_count": len(queue),
            "queue": queue,
            "embedded_analysis_context": embedded_analysis_context,
            "next_action": next_action,
        }

        return sanitize_value(context_envelope)

    def get_next_analysis_context(self, min_score: Optional[float] = None) -> Dict[str, Any]:
        """
        Fetches the next highest-priority pending analysis job and constructs its complete context.
        Returns a structured envelope with the context and explicit next_action.
        """
        blocker = self.check_preflight()
        if blocker:
            return sanitize_value({
                "status": "blocked",
                "analysis_context": None,
                "next_action": {
                    "action": "resolve_blocker",
                    "tool": None,
                    "instruction": blocker["message"],
                    "recovery_command": blocker["recovery_command"],
                },
            })

        ctx = self.context_builder.build_next_pending(min_score=min_score)
        if not ctx:
            return sanitize_value({
                "status": "complete",
                "message": "No pending jobs require analysis.",
                "analysis_context": None,
                "next_action": {
                    "action": "create_morning_briefing",
                    "tool": "create_morning_briefing",
                    "instruction": "All pending jobs have been analyzed. Call create_morning_briefing to generate the daily briefing.",
                },
            })

        return sanitize_value({
            "status": "ready",
            "job_id": ctx["job_id"],
            "title": ctx["title"],
            "company": ctx["company"],
            "analysis_context": ctx,
            "next_action": {
                "action": "submit_analysis",
                "target_job_id": ctx["job_id"],
                "target_title": ctx["title"],
                "target_company": ctx["company"],
                "tool": "submit_analysis_version",
                "instruction": "Review analysis context and submit structured requirement analysis using submit_analysis_version.",
                "subsequent_tool": "get_next_analysis_context",
            },
        })
