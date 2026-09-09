import logging
import time
from decimal import Decimal
from datetime import datetime, date
from typing import List, Dict, Any, Optional, Tuple, Union
import math
import pandas as pd
from jobspy import scrape_jobs

from services.discovery.normalizer import clean_url, normalize_title, normalize_location, generate_content_hash
from services.discovery.freshness import calculate_freshness
from services.discovery.deduplicator import detect_ats_type

logger = logging.getLogger(__name__)

DEFAULT_SITES = ["indeed", "linkedin"]

def sanitize_value(val: Any) -> Any:
    """
    Recursively sanitizes NaN, Decimal, dates, and nested payloads before strict JSON serialization.
    """
    if val is None:
        return None
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    if isinstance(val, dict):
        return {k: sanitize_value(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return [sanitize_value(item) for item in val]
    # Check pandas/numpy NaN
    try:
        if pd.isna(val):
            return None
    except Exception:
        pass
    return val

def normalize_single_job_row(
    raw_dict: Dict[str, Any],
    fallback_location: str,
    fallback_site: str
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Converts a single raw job dictionary into normalized (job_record, source_record).
    Raises ValueError on fatal schema violations for this individual row.
    """
    raw_dict = sanitize_value(raw_dict)

    raw_url = str(raw_dict.get("job_url") or "").strip()
    raw_direct_url = str(raw_dict.get("job_url_direct") or "").strip()
    if not raw_url and not raw_direct_url:
        raise ValueError("Missing both job_url and job_url_direct")

    canonical_url = clean_url(raw_url or raw_direct_url)
    apply_url = clean_url(raw_direct_url) if raw_direct_url else canonical_url

    raw_title = str(raw_dict.get("title") or "").strip()
    if not raw_title:
        raw_title = "Unknown Title"
    norm_title = normalize_title(raw_title)

    raw_loc = str(raw_dict.get("location") or fallback_location).strip()
    is_remote = bool(raw_dict.get("is_remote", False))
    norm_loc, remote_type = normalize_location(raw_loc, is_remote)

    desc = str(raw_dict.get("description") or "").strip()
    company = str(raw_dict.get("company") or "").strip() or "Unknown Company"
    c_hash = generate_content_hash(company, norm_title, desc)

    date_posted = raw_dict.get("date_posted")
    fresh_res = calculate_freshness(date_posted)

    ats_detected = detect_ats_type(apply_url) or detect_ats_type(raw_direct_url)
    source_name = str(raw_dict.get("site") or fallback_site).strip().lower()
    source_job_id = str(raw_dict.get("id") or "").strip()

    min_amt = raw_dict.get("min_amount")
    max_amt = raw_dict.get("max_amount")

    job_record = {
        "source": source_name,
        "source_job_id": source_job_id,
        "canonical_url": canonical_url,
        "apply_url": apply_url,
        "company": company,
        "title": raw_title,
        "normalized_title": norm_title,
        "location": norm_loc,
        "remote_type": remote_type,
        "employment_type": str(raw_dict.get("job_type") or "full_time"),
        "posted_at": date_posted if date_posted else None,
        "posted_at_source": str(raw_dict.get("date_posted") or ""),
        "posted_at_confidence": fresh_res.confidence,
        "is_observation_age": fresh_res.is_observation_age,
        "date_inconsistent": fresh_res.date_inconsistent,
        "age_hours": fresh_res.age_hours,
        "freshness_bucket": fresh_res.bucket,
        "description": desc,
        "ats_type": ats_detected,
        "requirements": [],
        "preferred_requirements": [],
        "keywords": [],
        "content_hash": c_hash,
        "status": "NEW",
        "assessment_status": "ANALYSIS_PENDING",
        "min_amount": float(min_amt) if min_amt is not None else None,
        "max_amount": float(max_amt) if max_amt is not None else None,
        "currency": str(raw_dict.get("currency") or "CAD")
    }

    source_record = {
        "source_name": source_name,
        "source_url": canonical_url,
        "source_job_id": source_job_id,
        "raw_payload": sanitize_value({k: v for k, v in raw_dict.items() if k != "description"})
    }

    return job_record, source_record

def fetch_single_board_query(
    site: str,
    search_term: str,
    location: str,
    country: str,
    hours_old: float,
    results_wanted: int,
    max_retries: int = 2
) -> Tuple[List[Tuple[Dict[str, Any], Dict[str, Any]]], Dict[str, Any]]:
    """
    Executes JobSpy scraping against a single board.
    Retries only on transient network failures. Isolates errors completely from other queries.
    Returns (collected_jobs, observation_dict).
    """
    start_time = time.time()
    errors: List[Dict[str, str]] = []
    collected_jobs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    records_received = 0
    records_normalized = 0
    records_rejected = 0
    df = None

    for attempt in range(max_retries + 1):
        try:
            logger.info(f"Querying board '{site}' for '{search_term}' in '{location}, {country}' (attempt {attempt+1})...")
            df = scrape_jobs(
                site_name=[site],
                search_term=search_term,
                location=location,
                country_indeed=country,
                results_wanted=results_wanted,
                hours_old=int(math.ceil(hours_old))
            )
            break
        except Exception as exc:
            err_str = str(exc)
            logger.warning(f"Error scraping '{site}' on attempt {attempt+1}: {err_str}")
            # Check if non-transient auth/permission failure
            if any(code in err_str.lower() for code in ["401", "403", "unauthorized", "forbidden"]):
                errors.append({"code": "AUTH_ERROR", "message": f"Authorization error on {site}: {err_str}"})
                break
            if attempt < max_retries:
                time.sleep(1.0 * (attempt + 1))
            else:
                errors.append({"code": "SCRAPE_FAILED", "message": f"Scrape failed after {max_retries+1} attempts: {err_str}"})

    duration_ms = int((time.time() - start_time) * 1000)

    if df is not None:
        if df.empty:
            status = "success"
        else:
            records_received = len(df)
            for idx, row in df.iterrows():
                try:
                    raw_dict = row.to_dict()
                    job_rec, src_rec = normalize_single_job_row(raw_dict, location, site)
                    collected_jobs.append((job_rec, src_rec))
                    records_normalized += 1
                except Exception as row_exc:
                    records_rejected += 1
                    errors.append({"code": "ROW_NORMALIZATION_ERROR", "message": f"Row {idx} rejected: {str(row_exc)}"})

            if records_rejected > 0 and records_normalized > 0:
                status = "partial"
            elif records_rejected > 0 and records_normalized == 0:
                status = "failed"
            else:
                status = "success"
    else:
        status = "failed"

    observation = {
        "source": site,
        "query": {
            "role": search_term,
            "location": location,
            "country": country,
            "hours_old": hours_old,
            "results_wanted": results_wanted
        },
        "status": status,
        "records_received": records_received,
        "records_normalized": records_normalized,
        "records_rejected": records_rejected,
        "errors": errors,
        "duration_ms": duration_ms
    }

    return collected_jobs, observation

def fetch_jobs_from_boards(
    search_term: str,
    location: str = "Toronto, ON",
    country: str = "Canada",
    hours_old: float = 72,
    results_wanted: int = 15,
    sites: Optional[List[str]] = None,
    return_observations: bool = False
) -> Union[List[Tuple[Dict[str, Any], Dict[str, Any]]], Tuple[List[Tuple[Dict[str, Any], Dict[str, Any]]], List[Dict[str, Any]]]]:
    """
    Executes isolated scraping across all configured boards independently.
    Failure on one board cannot abort or discard results from another board.
    """
    sites_to_query = sites or DEFAULT_SITES
    all_jobs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    all_observations: List[Dict[str, Any]] = []

    for site in sites_to_query:
        jobs, obs = fetch_single_board_query(
            site=site,
            search_term=search_term,
            location=location,
            country=country,
            hours_old=hours_old,
            results_wanted=results_wanted
        )
        all_jobs.extend(jobs)
        all_observations.append(obs)

    if return_observations:
        return all_jobs, all_observations
    return all_jobs
