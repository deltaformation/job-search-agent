import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal
from datetime import datetime, timezone
import pandas as pd

from services.discovery.scraper import (
    sanitize_value,
    fetch_single_board_query,
    fetch_jobs_from_boards,
    normalize_single_job_row
)
from services.discovery.service import DiscoveryService
from services.memory.repository import JobRepository

def test_sanitize_value():
    assert sanitize_value(float("nan")) is None
    assert sanitize_value(float("inf")) is None
    assert sanitize_value(Decimal("123.45")) == 123.45
    d = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    assert sanitize_value(d) == "2026-01-01T12:00:00+00:00"
    nested = {"a": float("nan"), "b": [Decimal("10.5"), {"c": None}]}
    assert sanitize_value(nested) == {"a": None, "b": [10.5, {"c": None}]}

def test_board_failure_isolation():
    """If one board fails with an exception, other boards continue and return results."""
    def mock_scrape(site_name, **kwargs):
        if site_name == ["indeed"]:
            raise ConnectionError("Indeed connection refused (HTTP 503)")
        elif site_name == ["linkedin"]:
            return pd.DataFrame([{
                "title": "Senior Product Manager",
                "company": "LinkedIn Corp",
                "location": "Toronto, ON",
                "job_url": "https://www.linkedin.com/jobs/view/999999",
                "job_url_direct": None,
                "description": "API Platform PM",
                "site": "linkedin",
                "id": "li_999",
                "date_posted": "2026-09-08",
                "min_amount": 160000,
                "max_amount": 180000,
                "currency": "CAD",
                "is_remote": False
            }])
        return pd.DataFrame()

    with patch("services.discovery.scraper.scrape_jobs", side_effect=mock_scrape):
        jobs, obs = fetch_jobs_from_boards(
            search_term="Senior Product Manager",
            sites=["indeed", "linkedin"],
            return_observations=True
        )

        # LinkedIn succeeded and returned 1 job
        assert len(jobs) == 1
        assert jobs[0][0]["company"] == "LinkedIn Corp"

        # Indeed failed, LinkedIn succeeded
        assert len(obs) == 2
        indeed_obs = next(o for o in obs if o["source"] == "indeed")
        linkedin_obs = next(o for o in obs if o["source"] == "linkedin")

        assert indeed_obs["status"] == "failed"
        assert len(indeed_obs["errors"]) > 0
        assert linkedin_obs["status"] == "success"
        assert linkedin_obs["records_normalized"] == 1

def test_row_level_fault_tolerance():
    """One malformed row in a dataframe does not discard other valid rows."""
    df_data = [
        {
            # Malformed row: missing job_url and job_url_direct
            "title": "Broken Job",
            "company": "Broken Co",
            "job_url": None,
            "job_url_direct": None,
            "description": "Missing URL",
            "site": "indeed",
            "id": "bad_1"
        },
        {
            # Valid row
            "title": "Senior Technical Product Manager",
            "company": "Solid Co",
            "job_url": "https://ca.indeed.com/viewjob?jk=solid123",
            "job_url_direct": None,
            "description": "Cloud platform PM role",
            "site": "indeed",
            "id": "solid_1",
            "date_posted": "2026-09-08",
            "min_amount": 155000,
            "max_amount": 175000,
            "currency": "CAD"
        }
    ]

    with patch("services.discovery.scraper.scrape_jobs", return_value=pd.DataFrame(df_data)):
        jobs, obs = fetch_single_board_query(
            site="indeed",
            search_term="Senior PM",
            location="Toronto, ON",
            country="Canada",
            hours_old=24,
            results_wanted=5
        )

        assert len(jobs) == 1
        assert jobs[0][0]["company"] == "Solid Co"
        assert obs["status"] == "partial"
        assert obs["records_received"] == 2
        assert obs["records_normalized"] == 1
        assert obs["records_rejected"] == 1
        assert len(obs["errors"]) == 1

def test_zero_results_vs_failure():
    """Zero results returns success with 0 records, not a failure."""
    with patch("services.discovery.scraper.scrape_jobs", return_value=pd.DataFrame()):
        jobs, obs = fetch_single_board_query(
            site="indeed",
            search_term="Ultra Rare Role",
            location="Toronto, ON",
            country="Canada",
            hours_old=24,
            results_wanted=5
        )
        assert len(jobs) == 0
        assert obs["status"] == "success"
        assert obs["records_received"] == 0
        assert len(obs["errors"]) == 0

def test_schedule_locking(clean_db):
    """Schedule lock prevents overlapping executions of the same schedule."""
    repo = clean_db
    run_1 = repo.start_agent_run("morning_scan", schedule_name="morning_scan")
    run_2 = repo.start_agent_run("morning_scan", schedule_name="morning_scan")

    locked_1 = repo.acquire_schedule_lock("morning_scan", run_1)
    assert locked_1 is True

    # Second process tries to acquire the same schedule lock -> fails
    locked_2 = repo.acquire_schedule_lock("morning_scan", run_2)
    assert locked_2 is False

    # First releases lock
    repo.release_schedule_lock("morning_scan", run_1)

    # Now second can acquire it
    locked_2_retry = repo.acquire_schedule_lock("morning_scan", run_2)
    assert locked_2_retry is True

    repo.release_schedule_lock("morning_scan", run_2)


def test_dry_run_has_no_database_side_effects():
    repo = MagicMock()
    repo.get_candidate_profile.return_value = None
    config = MagicMock()
    config.resolve_discovery_params.return_value = {
        "roles": ["Senior Product Manager"], "locations": ["Toronto"],
        "sources": ["indeed"], "country": "Canada", "hours_old": 24,
        "max_results_per_query": 3, "pipeline": {"auto_score": True},
    }
    observation = {"source": "indeed", "query": {}, "status": "success",
                   "records_received": 0, "records_normalized": 0,
                   "records_rejected": 0, "errors": []}
    with patch("services.discovery.service.fetch_jobs_from_boards", return_value=([], [observation])):
        result = DiscoveryService(repo=repo, config=config).run_discovery(
            schedule_name="morning_scan", dry_run=True
        )
    assert result["dry_run"] is True
    assert result["run_id"] is None
    repo.start_agent_run.assert_not_called()
    repo.acquire_schedule_lock.assert_not_called()
    repo.save_discovery_observation.assert_not_called()
    repo.upsert_job.assert_not_called()
    repo.finalize_agent_run.assert_not_called()
