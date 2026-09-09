import logging
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from uuid import uuid4

from services.memory.repository import JobRepository
from services.intelligence.scorer import FitScorer
from services.discovery.config import AppConfig
from services.discovery.scraper import fetch_jobs_from_boards

logger = logging.getLogger("discovery_service")

class DiscoveryService:
    def __init__(self, repo: Optional[JobRepository] = None, scorer: Optional[FitScorer] = None, config: Optional[AppConfig] = None) -> None:
        self.repo = repo or JobRepository()
        self.scorer = scorer or FitScorer()
        self.config = config or AppConfig()

    def run_discovery(
        self,
        schedule_name: Optional[str] = None,
        roles: Optional[List[str]] = None,
        locations: Optional[List[str]] = None,
        sources: Optional[List[str]] = None,
        max_results_per_query: Optional[int] = None,
        hours_old: Optional[float] = None,
        dry_run: bool = False
    ) -> Dict[str, Any]:
        """
        Executes unified discovery with per-board isolation, schedule locking,
        and database audit history.
        """
        start_time = datetime.now(timezone.utc)
        params = self.config.resolve_discovery_params(
            schedule_name=schedule_name,
            roles=roles,
            locations=locations,
            sources=sources,
            max_results_per_query=max_results_per_query,
            hours_old=hours_old
        )

        run_type = schedule_name or "manual"
        # A dry run is deliberately side-effect free. It exercises the external
        # queries and normalization but creates no runs, locks, observations,
        # jobs, scores, reservations, or deliveries.
        run_id = None if dry_run else self.repo.start_agent_run(
            run_type=run_type,
            schedule_name=schedule_name,
            sources_used=params["sources"]
        )

        # 2. Prevent overlapping runs of same schedule via DB lock
        if schedule_name and not dry_run:
            locked = self.repo.acquire_schedule_lock(schedule_name, run_id)
            if not locked:
                msg = f"Schedule '{schedule_name}' is already running under another process. Skipping overlapping execution."
                logger.warning(msg)
                self.repo.finalize_agent_run(
                    run_id=run_id,
                    status="SKIPPED_OVERLAP",
                    metrics={"skipped_overlap": True},
                    errors=[msg],
                    summary={"message": msg}
                )
                return {
                    "run_id": run_id,
                    "status": "SKIPPED_OVERLAP",
                    "message": msg,
                    "jobs_found": 0,
                    "jobs_new": 0
                }

        jobs_found = 0
        jobs_new = 0
        jobs_duplicate = 0
        jobs_stale = 0
        jobs_scored = 0
        jobs_qualified = 0
        all_errors: List[str] = []
        board_observations: List[Dict[str, Any]] = []

        try:
            profile = self.repo.get_candidate_profile()
            for role in params["roles"]:
                for loc in params["locations"]:
                    for source in params["sources"]:
                        try:
                            # Single-board isolated query
                            pairs, obs_list = fetch_jobs_from_boards(
                                search_term=role,
                                location=loc,
                                country=params["country"],
                                hours_old=params["hours_old"],
                                results_wanted=params["max_results_per_query"],
                                sites=[source],
                                return_observations=True
                            )

                            obs = obs_list[0] if obs_list else {}
                            board_observations.append(obs)
                            if not dry_run:
                                self.repo.save_discovery_observation(run_id, obs)

                            if obs.get("errors"):
                                for e in obs["errors"]:
                                    all_errors.append(f"[{source}] {e.get('message', str(e))}")

                            jobs_found += len(pairs)

                            if not dry_run:
                                for job_data, source_data in pairs:
                                    if job_data.get("freshness_bucket") == "STALE":
                                        jobs_stale += 1

                                    saved_job, is_new = self.repo.upsert_job(job_data, source_data)

                                    if is_new:
                                        jobs_new += 1
                                        if profile and params.get("pipeline", {}).get("auto_score", True):
                                            score_res = self.scorer.score_job(saved_job, profile)
                                            self.repo.save_job_score(saved_job["job_id"], score_res)
                                            jobs_scored += 1
                                            if score_res["overall_score"] >= params["pipeline"].get("min_score_to_tailor", 85):
                                                jobs_qualified += 1
                                    else:
                                        jobs_duplicate += 1

                        except Exception as query_exc:
                            err = f"Exception during search for '{role}' in '{loc}' on '{source}': {str(query_exc)}"
                            logger.error(err, exc_info=True)
                            all_errors.append(err)

            # Determine run final status
            if all_errors and (jobs_new > 0 or jobs_found > 0):
                final_status = "PARTIAL_FAILURE"
            elif all_errors and jobs_found == 0:
                final_status = "FAILED"
            else:
                final_status = "COMPLETED"

            metrics = {
                "raw_observations": jobs_found,
                "new_canonical": jobs_new,
                "duplicates_merged": jobs_duplicate,
                "stale_excluded": jobs_stale,
                "scored": jobs_scored,
                "qualified": jobs_qualified,
                "board_queries_total": len(board_observations),
                "board_failures": sum(1 for o in board_observations if o.get("status") == "failed")
            }

            duration_s = round((datetime.now(timezone.utc) - start_time).total_seconds(), 1)
            summary = {
                "duration_seconds": duration_s,
                "schedule_name": schedule_name,
                "roles": params["roles"],
                "locations": params["locations"],
                "sources": params["sources"],
                "metrics": metrics
            }

            if not dry_run:
                self.repo.finalize_agent_run(
                    run_id=run_id,
                    status=final_status,
                    metrics=metrics,
                    errors=all_errors,
                    summary=summary,
                    jobs_found=jobs_found,
                    jobs_new=jobs_new,
                    jobs_duplicate=jobs_duplicate,
                    jobs_stale=jobs_stale,
                    jobs_scored=jobs_scored,
                    jobs_qualified=jobs_qualified
                )

            return {
                "run_id": run_id,
                "status": final_status,
                "dry_run": dry_run,
                "duration_seconds": duration_s,
                "metrics": metrics,
                "errors": all_errors,
                "observations": board_observations
            }

        finally:
            if schedule_name and not dry_run and run_id:
                self.repo.release_schedule_lock(schedule_name, run_id)
