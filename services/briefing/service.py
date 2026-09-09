"""
Briefing service implementing morning job discovery windowing,
snapshot freezing, normalization, and Markdown summary presentation.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from services.memory.repository import JobRepository
from services.intelligence.scorer import FitScorer


class BriefingService:
    def __init__(self, repo: Optional[JobRepository] = None, scorer: Optional[FitScorer] = None):
        self.repo = repo or JobRepository()
        self.scorer = scorer or FitScorer()

    @staticmethod
    def normalize_work_arrangement(remote_type: Optional[str]) -> str:
        """Normalize remote_type string to 'Remote', 'Hybrid', or 'On-site'."""
        if not remote_type:
            return "On-site"
        norm = remote_type.strip().lower()
        if "remote" in norm:
            return "Remote"
        if "hybrid" in norm:
            return "Hybrid"
        return "On-site"

    @staticmethod
    def normalize_compensation(
        min_val: Optional[float],
        max_val: Optional[float],
        currency: Optional[str] = "USD",
        interval: Optional[str] = "yearly"
    ) -> str:
        """Format compensation into human-readable string or 'Not disclosed'."""
        if min_val is None and max_val is None:
            return "Not disclosed"

        curr_symbol = "$"
        if currency and currency.upper() == "CAD":
            curr_symbol = "CAD $"
        elif currency and currency.upper() == "EUR":
            curr_symbol = "€"
        elif currency and currency.upper() == "GBP":
            curr_symbol = "£"

        def fmt_k(val: float) -> str:
            if val >= 1000:
                # e.g. 150000 -> 150k
                if val % 1000 == 0:
                    return f"{int(val // 1000)}k"
                return f"{val / 1000:.1f}k"
            return f"{int(val)}"

        suffix = ""
        if interval:
            clean_int = interval.strip().lower()
            if "year" in clean_int or clean_int == "annually":
                suffix = " / yr"
            elif "hour" in clean_int:
                suffix = " / hr"
            elif "month" in clean_int:
                suffix = " / mo"

        if min_val is not None and max_val is not None:
            if min_val == max_val:
                return f"{curr_symbol}{fmt_k(min_val)}{suffix}"
            return f"{curr_symbol}{fmt_k(min_val)} - {curr_symbol}{fmt_k(max_val)}{suffix}"
        elif min_val is not None:
            return f"{curr_symbol}{fmt_k(min_val)}+{suffix}"
        else:
            return f"Up to {curr_symbol}{fmt_k(max_val)}{suffix}"

    def create_briefing(
        self,
        schedule_name: str = "morning_scan",
        window_hours: float = 24.0,
        limit: int = 50,
        trigger_run_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Evaluate new/updated jobs since the last acknowledged briefing,
        gather audit metrics, freeze snapshot items, and persist the briefing.
        """
        if not isinstance(schedule_name, str) or not schedule_name.strip():
            raise ValueError("schedule_name is required.")
        if window_hours <= 0 or window_hours > 168:
            raise ValueError("window_hours must be greater than 0 and no more than 168.")
        if limit < 1 or limit > 100:
            raise ValueError("limit must be between 1 and 100.")

        window_started_at, window_ended_at = self.repo.compute_new_jobs_window(
            schedule_name=schedule_name,
            default_window_hours=window_hours
        )

        # Retrieve recent agent runs for source provenance and error visibility
        agent_runs = self.repo.get_agent_runs(limit=10)
        source_run_ids = []
        source_status: Dict[str, str] = {}
        for run in agent_runs:
            created = run.get("created_at")
            if created and created >= window_started_at:
                source_run_ids.append(str(run.get("run_id") or run.get("id")))
                observations = self.repo.get_discovery_observations(str(run.get("id")))
                for observation in observations:
                    board = str(observation.get("source_name") or "unknown")
                    board_status = str(observation.get("status") or "success").upper()
                    if board not in source_status or source_status[board] == "SUCCESS":
                        source_status[board] = board_status

        # Query all active jobs
        all_jobs = self.repo.get_jobs(
            exclude_stale=False,
            limit=limit * 2
        )

        # Distinguish newly discovered vs updated vs omitted
        new_jobs = []
        updated_jobs = []
        omitted_unanalyzed = []

        for job in all_jobs:
            first_seen = job.get("first_seen_at")
            updated = job.get("updated_at")
            is_new = bool(first_seen and first_seen >= window_started_at)
            is_updated = bool(not is_new and updated and updated >= window_started_at)

            # Check if omitted due to missing analysis or skipped/withdrawn
            if job.get("status") in ("SKIPPED", "WITHDRAWN", "EXPIRED", "REJECTED"):
                continue

            if job.get("assessment_status") == "ANALYSIS_PENDING" and (job.get("overall_score") is None):
                omitted_unanalyzed.append(job)
                continue

            if is_new:
                new_jobs.append(job)
            elif is_updated:
                updated_jobs.append(job)

        # Combine items: rank newly discovered first, then updated, ordered by fit score
        combined_candidates = new_jobs + updated_jobs
        if not combined_candidates:
            # Fall back to top scored active jobs so user always has relevant items
            combined_candidates = [j for j in all_jobs if j.get("status") not in ("SKIPPED", "WITHDRAWN", "EXPIRED", "REJECTED")]

        # Sort deterministically: overall_score DESC (None last), then created_at DESC
        def sort_key(j: Dict[str, Any]) -> Tuple[float, str]:
            score = float(j.get("overall_score") or 0.0)
            created_str = str(j.get("created_at") or "")
            return (score, created_str)

        sorted_candidates = sorted(combined_candidates, key=sort_key, reverse=True)[:limit]

        # Construct frozen snapshots
        briefing_items = []
        for rank, job in enumerate(sorted_candidates, start=1):
            jid = str(job["job_id"])
            gaps = job.get("gaps") or []
            top_gap = gaps[0] if gaps else None
            is_new_job = bool(job.get("first_seen_at") and job["first_seen_at"] >= window_started_at)

            # Keyword coverage object or percent
            kw_cov = job.get("keyword_coverage")
            kw_percent = None
            if isinstance(kw_cov, dict):
                kw_percent = float(kw_cov.get("coverage_percentage", 0.0))
            elif kw_cov is not None:
                try:
                    kw_percent = float(kw_cov)
                except (ValueError, TypeError):
                    kw_percent = None

            ev_cov = float(job["evidence_coverage"]) if job.get("evidence_coverage") is not None else None

            # Recommendation flag
            overall = float(job["overall_score"]) if job.get("overall_score") is not None else None
            rec = job.get("recommendation")
            if not rec and overall is not None:
                rec = "RECOMMENDED" if overall >= 80.0 else ("CONSIDER" if overall >= 65.0 else "REVIEW")

            snapshot = {
                "job_id": jid,
                "title": job.get("title") or "Untitled Role",
                "company": job.get("company") or "Unknown Company",
                "location": job.get("location") or "Remote",
                "remote_type": self.normalize_work_arrangement(job.get("remote_type")),
                "compensation": self.normalize_compensation(
                    job.get("min_amount"),
                    job.get("max_amount"),
                    job.get("currency"),
                    job.get("interval")
                ),
                "freshness": job.get("freshness_bucket") or "RECENT",
                "overall_score": overall,
                "keyword_coverage": kw_percent,
                "evidence_coverage": ev_cov,
                "recommendation": rec,
                "top_gap": top_gap,
                "strengths": job.get("strengths") or [],
                "gaps": gaps,
                "risks": job.get("risks") or [],
                "source_url": job.get("apply_url") or job.get("canonical_url") or "",
                "analysis_id": str(job.get("analysis_id")) if job.get("analysis_id") else None,
                "is_new": is_new_job,
                "status": job.get("status") or "NEW"
            }
            briefing_items.append({
                "job_id": jid,
                "rank": rank,
                "snapshot": snapshot
            })

        metrics = {
            "newly_discovered_count": len(new_jobs),
            "updated_count": len(updated_jobs),
            "omitted_unanalyzed_count": len(omitted_unanalyzed),
            "total_items": len(briefing_items),
            "source_status": source_status
        }

        # Persist briefing record and frozen items
        briefing = self.repo.create_job_briefing(
            schedule_name=schedule_name,
            window_started_at=window_started_at,
            window_ended_at=window_ended_at,
            source_run_ids=source_run_ids,
            metrics=metrics,
            items=briefing_items,
            trigger_run_id=trigger_run_id,
        )

        return briefing

    def format_chat_markdown(self, briefing: Dict[str, Any], dashboard_url: str) -> str:
        """
        Generate a concise Markdown table and summary for Antigravity chat.
        """
        metrics = briefing.get("metrics") or {}
        items = briefing.get("items") or []

        new_cnt = metrics.get("newly_discovered_count", 0)
        upd_cnt = metrics.get("updated_count", 0)
        omit_cnt = metrics.get("omitted_unanalyzed_count", 0)
        source_status = metrics.get("source_status") or {}

        header_lines = [
            "### 🌅 Morning Job Search Briefing",
            f"**Window:** {briefing['window_started_at'].strftime('%b %d, %H:%M UTC')} → {briefing['window_ended_at'].strftime('%b %d, %H:%M UTC')}",
            f"**Discovered:** {new_cnt} new, {upd_cnt} updated" + (f", {omit_cnt} unanalyzed" if omit_cnt > 0 else ""),
        ]

        if source_status:
            source_pills = " | ".join(
                f"`{self._escape_markdown_table_cell(k)}: {self._escape_markdown_table_cell(v)}`"
                for k, v in source_status.items()
            )
            header_lines.append(f"**Sources:** {source_pills}")

        header_lines.append("")
        header_lines.append("| # | Role | Company | Arrangement | Fit | Freshness | Rec |")
        header_lines.append("|:---:|:---|:---|:---:|:---:|:---:|:---:|")

        for item in items[:10]:  # Top 10 for chat readability
            snap = item.get("snapshot") or {}
            rank = item.get("rank", 1)
            title = self._escape_markdown_table_cell(snap.get("title", "Role"))
            company = self._escape_markdown_table_cell(snap.get("company", "Company"))
            remote = self._escape_markdown_table_cell(snap.get("remote_type", "Remote"))
            score = f"{snap.get('overall_score'):.0f}%" if snap.get("overall_score") is not None else "Pending"
            freshness = self._escape_markdown_table_cell(snap.get("freshness", "RECENT"))
            rec = snap.get("recommendation", "-")
            rec_badge = "⭐ **REC**" if rec == "RECOMMENDED" else (
                "⚖️ Consider" if rec == "CONSIDER" else self._escape_markdown_table_cell(rec)
            )

            header_lines.append(f"| {rank} | **{title}** | {company} | {remote} | {score} | {freshness} | {rec_badge} |")

        if len(items) > 10:
            header_lines.append(f"\n*... and {len(items) - 10} more in the interactive dashboard.*")

        header_lines.append(f"\n👉 **[Open Morning Job Dashboard]({dashboard_url})** to inspect match evidence and prepare selected jobs.")

        return "\n".join(header_lines)

    @staticmethod
    def _escape_markdown_table_cell(value: Any) -> str:
        """Keep untrusted job-board text inside one Markdown table cell."""
        return str(value).replace("\\", "\\\\").replace("|", "\\|").replace("\r", " ").replace("\n", " ")
