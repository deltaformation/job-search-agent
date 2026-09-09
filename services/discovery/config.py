import os
from pathlib import Path
from typing import Dict, Any, List, Optional
import zoneinfo
import yaml

SUPPORTED_BOARDS = {"indeed", "linkedin"}

REQUIRED_SCORING_FACTORS = [
    "role_alignment",
    "relevant_experience",
    "seniority",
    "required_skills",
    "domain_relevance",
    "location_fit",
    "compensation_fit",
    "preference_fit",
]

class ConfigurationError(ValueError):
    pass

def load_yaml(file_path: Path) -> Dict[str, Any]:
    if not file_path.exists():
        raise ConfigurationError(f"Configuration file not found: {file_path}")
    with open(file_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ConfigurationError(f"Configuration file {file_path} must be a YAML mapping/dict.")
    return data

def validate_jobs_config(data: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise ConfigurationError("jobs.yaml root must be a mapping.")

    search = data.get("search")
    if not isinstance(search, dict):
        raise ConfigurationError("jobs.yaml must have a 'search' mapping.")

    country = search.get("country")
    if not isinstance(country, str) or not country.strip():
        raise ConfigurationError("jobs.yaml: search.country must be a non-empty string.")

    roles = search.get("roles")
    if not isinstance(roles, list) or not roles or any(not isinstance(r, str) or not r.strip() for r in roles):
        raise ConfigurationError("jobs.yaml: search.roles must be a non-empty list of strings.")

    locations = search.get("locations")
    if not isinstance(locations, list) or not locations or any(not isinstance(l, str) or not l.strip() for l in locations):
        raise ConfigurationError("jobs.yaml: search.locations must be a non-empty list of strings.")

    sources = search.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ConfigurationError("jobs.yaml: search.sources must be a non-empty list.")
    unsupported = set(s.lower() for s in sources) - SUPPORTED_BOARDS
    if unsupported:
        raise ConfigurationError(f"jobs.yaml: search.sources contains unsupported boards: {unsupported}. Supported: {SUPPORTED_BOARDS}")

    fw = search.get("freshness_windows")
    if not isinstance(fw, dict):
        raise ConfigurationError("jobs.yaml: search.freshness_windows must be a mapping.")
    p_hours = fw.get("primary_hours")
    s_hours = fw.get("secondary_hours")
    if not isinstance(p_hours, (int, float)) or p_hours <= 0:
        raise ConfigurationError("jobs.yaml: primary_hours must be a positive number.")
    if not isinstance(s_hours, (int, float)) or s_hours <= 0:
        raise ConfigurationError("jobs.yaml: secondary_hours must be a positive number.")
    if p_hours >= s_hours:
        raise ConfigurationError(f"jobs.yaml: primary_hours ({p_hours}) must be less than secondary_hours ({s_hours}).")

    max_res = search.get("max_results_per_query")
    if not isinstance(max_res, int) or max_res <= 0:
        raise ConfigurationError("jobs.yaml: search.max_results_per_query must be a positive integer.")

    dedupe = data.get("deduplication", {})
    if not isinstance(dedupe, dict):
        raise ConfigurationError("jobs.yaml: deduplication must be a mapping.")
    sim = dedupe.get("similarity_threshold", 0.85)
    if not isinstance(sim, (int, float)) or not (0.0 <= sim <= 1.0):
        raise ConfigurationError("jobs.yaml: deduplication.similarity_threshold must be between 0.0 and 1.0.")

    pipeline = data.get("pipeline", {})
    if not isinstance(pipeline, dict):
        raise ConfigurationError("jobs.yaml: pipeline must be a mapping.")
    min_shortlist = pipeline.get("min_score_to_shortlist", 75)
    min_tailor = pipeline.get("min_score_to_tailor", 85)
    if not isinstance(min_shortlist, (int, float)) or not (0 <= min_shortlist <= 100):
        raise ConfigurationError("jobs.yaml: pipeline.min_score_to_shortlist must be between 0 and 100.")
    if not isinstance(min_tailor, (int, float)) or not (0 <= min_tailor <= 100):
        raise ConfigurationError("jobs.yaml: pipeline.min_score_to_tailor must be between 0 and 100.")
    if min_tailor < min_shortlist:
        raise ConfigurationError("jobs.yaml: pipeline.min_score_to_tailor cannot be lower than min_score_to_shortlist.")

    return data

def validate_scoring_config(data: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise ConfigurationError("scoring.yaml root must be a mapping.")

    weights = data.get("weights")
    if not isinstance(weights, dict):
        raise ConfigurationError("scoring.yaml must have a 'weights' mapping.")

    total_weight = 0.0
    for factor in REQUIRED_SCORING_FACTORS:
        val = weights.get(factor)
        if val is None:
            raise ConfigurationError(f"scoring.yaml: missing required factor weight '{factor}'.")
        if not isinstance(val, (int, float)) or val < 0:
            raise ConfigurationError(f"scoring.yaml: weight for '{factor}' must be a non-negative number.")
        total_weight += float(val)

    if abs(total_weight - 1.0) > 1e-3:
        raise ConfigurationError(f"scoring.yaml: weights must sum to 1.0, got {round(total_weight, 4)}.")

    thresholds = data.get("thresholds")
    if not isinstance(thresholds, dict):
        raise ConfigurationError("scoring.yaml must have a 'thresholds' mapping.")

    for k in ["exceptional", "strong", "review", "weak"]:
        v = thresholds.get(k)
        if not isinstance(v, (int, float)) or not (0 <= v <= 100):
            raise ConfigurationError(f"scoring.yaml: threshold '{k}' must be between 0 and 100.")

    if not (thresholds["weak"] < thresholds["review"] < thresholds["strong"] < thresholds["exceptional"]):
        raise ConfigurationError(
            f"scoring.yaml: thresholds must be strictly increasing: "
            f"weak ({thresholds['weak']}) < review ({thresholds['review']}) < "
            f"strong ({thresholds['strong']}) < exceptional ({thresholds['exceptional']})."
        )

    return data

def validate_schedule_config(data: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(data, dict):
        raise ConfigurationError("schedule.yaml root must be a mapping.")

    tz_name = data.get("timezone")
    if not isinstance(tz_name, str) or not tz_name.strip():
        raise ConfigurationError("schedule.yaml: timezone must be a non-empty string.")
    try:
        zoneinfo.ZoneInfo(tz_name)
    except Exception:
        raise ConfigurationError(f"schedule.yaml: invalid timezone '{tz_name}'.")

    schedules = data.get("schedules")
    if not isinstance(schedules, dict) or not schedules:
        raise ConfigurationError("schedule.yaml: schedules must be a non-empty mapping.")

    for s_name, s_conf in schedules.items():
        if not isinstance(s_conf, dict):
            raise ConfigurationError(f"schedule.yaml: schedule '{s_name}' must be a mapping.")
        cron = s_conf.get("cron")
        if not isinstance(cron, str) or len(cron.strip().split()) != 5:
            raise ConfigurationError(f"schedule.yaml: schedule '{s_name}' cron must be a valid 5-field expression.")
        hours = s_conf.get("max_hours_old")
        if not isinstance(hours, (int, float)) or hours <= 0:
            raise ConfigurationError(f"schedule.yaml: schedule '{s_name}' max_hours_old must be a positive number.")

    return data

class AppConfig:
    def __init__(self, config_dir: Optional[Path] = None) -> None:
        base_dir = Path(__file__).resolve().parent.parent.parent
        self.config_dir = config_dir or (base_dir / "config")
        self.jobs = validate_jobs_config(load_yaml(self.config_dir / "jobs.yaml"))
        self.scoring = validate_scoring_config(load_yaml(self.config_dir / "scoring.yaml"))
        self.schedule = validate_schedule_config(load_yaml(self.config_dir / "schedule.yaml"))

    def resolve_discovery_params(
        self,
        schedule_name: Optional[str] = None,
        roles: Optional[List[str]] = None,
        locations: Optional[List[str]] = None,
        sources: Optional[List[str]] = None,
        max_results_per_query: Optional[int] = None,
        hours_old: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Resolution precedence:
        1. CLI overrides
        2. Named schedule settings
        3. Base jobs.yaml settings
        """
        # 1. Base values from jobs.yaml
        base_search = self.jobs["search"]
        res_country = base_search["country"]
        res_roles = list(base_search["roles"])
        res_locations = list(base_search["locations"])
        res_sources = list(base_search["sources"])
        res_max_results = base_search["max_results_per_query"]
        res_hours_old = float(base_search["freshness_windows"]["secondary_hours"])
        schedule_info = None

        # 2. Named schedule overrides
        if schedule_name:
            schedules = self.schedule["schedules"]
            if schedule_name not in schedules:
                raise ConfigurationError(f"Unknown schedule name '{schedule_name}'. Available: {list(schedules.keys())}")
            sched = schedules[schedule_name]
            if not sched.get("enabled", True):
                raise ConfigurationError(f"Schedule '{schedule_name}' is disabled in configuration.")
            res_hours_old = float(sched["max_hours_old"])
            schedule_info = {
                "name": schedule_name,
                "cron": sched.get("cron"),
                "description": sched.get("description", ""),
                "timezone": self.schedule["timezone"]
            }

        # 3. CLI explicit overrides
        if roles:
            res_roles = [r.strip() for r in roles if r.strip()]
            if not res_roles:
                raise ConfigurationError("roles override cannot be empty.")
        if locations:
            res_locations = [l.strip() for l in locations if l.strip()]
            if not res_locations:
                raise ConfigurationError("locations override cannot be empty.")
        if sources:
            res_sources = [s.strip().lower() for s in sources if s.strip()]
            unsupported = set(res_sources) - SUPPORTED_BOARDS
            if unsupported:
                raise ConfigurationError(f"Unsupported sources in override: {unsupported}. Supported: {SUPPORTED_BOARDS}")
        if max_results_per_query is not None:
            if max_results_per_query <= 0:
                raise ConfigurationError("max_results_per_query must be a positive integer.")
            res_max_results = max_results_per_query
        if hours_old is not None:
            if hours_old <= 0:
                raise ConfigurationError("hours_old must be a positive number.")
            res_hours_old = float(hours_old)

        return {
            "country": res_country,
            "roles": res_roles,
            "locations": res_locations,
            "sources": res_sources,
            "max_results_per_query": res_max_results,
            "hours_old": res_hours_old,
            "primary_hours": float(base_search["freshness_windows"]["primary_hours"]),
            "secondary_hours": float(base_search["freshness_windows"]["secondary_hours"]),
            "schedule": schedule_info,
            "pipeline": self.jobs["pipeline"],
            "scoring": self.scoring,
        }
