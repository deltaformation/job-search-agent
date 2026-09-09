import pytest
from pathlib import Path
from services.discovery.config import (
    AppConfig,
    ConfigurationError,
    validate_jobs_config,
    validate_scoring_config,
    validate_schedule_config,
)

def test_load_valid_config():
    cfg = AppConfig()
    params = cfg.resolve_discovery_params()
    assert params["country"] == "Canada"
    assert len(params["roles"]) >= 1
    assert "indeed" in params["sources"]
    assert params["hours_old"] == 72.0

def test_schedule_resolution_precedence():
    cfg = AppConfig()
    # Base is 72h, morning_scan config specifies 24h
    morning_params = cfg.resolve_discovery_params(schedule_name="morning_scan")
    assert morning_params["hours_old"] == 24.0
    assert morning_params["schedule"]["name"] == "morning_scan"

    # CLI override has highest precedence (e.g. 12h)
    cli_params = cfg.resolve_discovery_params(
        schedule_name="morning_scan",
        hours_old=12.0,
        roles=["Custom Role"],
        sources=["indeed"]
    )
    assert cli_params["hours_old"] == 12.0
    assert cli_params["roles"] == ["Custom Role"]
    assert cli_params["sources"] == ["indeed"]

def test_reject_unsupported_board():
    cfg = AppConfig()
    with pytest.raises(ConfigurationError, match="Unsupported sources"):
        cfg.resolve_discovery_params(sources=["monster"])

def test_reject_invalid_weights():
    bad_scoring = {
        "weights": {
            "role_alignment": 0.5,
            "relevant_experience": 0.5,
            "seniority": 0.5, # Sum > 1.0
            "required_skills": 0.0,
            "domain_relevance": 0.0,
            "location_fit": 0.0,
            "compensation_fit": 0.0,
            "preference_fit": 0.0,
        },
        "thresholds": {"exceptional": 90, "strong": 80, "review": 70, "weak": 60}
    }
    with pytest.raises(ConfigurationError, match="weights must sum to 1.0"):
        validate_scoring_config(bad_scoring)

def test_reject_non_increasing_thresholds():
    bad_scoring = {
        "weights": {
            "role_alignment": 0.25,
            "relevant_experience": 0.20,
            "seniority": 0.15,
            "required_skills": 0.15,
            "domain_relevance": 0.10,
            "location_fit": 0.05,
            "compensation_fit": 0.05,
            "preference_fit": 0.05,
        },
        "thresholds": {"exceptional": 70, "strong": 85, "review": 75, "weak": 60} # exceptional < strong
    }
    with pytest.raises(ConfigurationError, match="thresholds must be strictly increasing"):
        validate_scoring_config(bad_scoring)

def test_reject_invalid_timezone():
    bad_schedule = {
        "timezone": "Invalid/Timezone_Not_Real",
        "schedules": {
            "morning": {"cron": "0 7 * * *", "max_hours_old": 24}
        }
    }
    with pytest.raises(ConfigurationError, match="invalid timezone"):
        validate_schedule_config(bad_schedule)
