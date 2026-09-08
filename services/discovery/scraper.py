import logging
from typing import List, Dict, Any, Optional
import pandas as pd
from jobspy import scrape_jobs

from services.discovery.normalizer import clean_url, normalize_title, normalize_location, generate_content_hash
from services.discovery.freshness import calculate_freshness
from services.discovery.deduplicator import detect_ats_type

logger = logging.getLogger(__name__)

DEFAULT_SITES = ["indeed", "linkedin"]

def fetch_jobs_from_boards(
    search_term: str,
    location: str = "Toronto, ON",
    country: str = "Canada",
    hours_old: int = 72,
    results_wanted: int = 15,
    sites: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """
    Executes JobSpy scraping across configured boards, safely handles errors per board,
    and returns normalized dictionary records.
    """
    sites_to_query = sites or DEFAULT_SITES
    collected_jobs: List[Dict[str, Any]] = []

    try:
        logger.info(f"Scraping {sites_to_query} for '{search_term}' in '{location}, {country}' (max {hours_old}h)...")
        df: pd.DataFrame = scrape_jobs(
            site_name=sites_to_query,
            search_term=search_term,
            location=location,
            country_indeed=country,
            results_wanted=results_wanted,
            hours_old=hours_old
        )

        if df.empty:
            logger.info(f"No postings returned for '{search_term}'.")
            return []

        for _, row in df.iterrows():
            raw_dict = {k: (None if pd.isna(v) else v) for k, v in row.to_dict().items()}
            
            raw_url = str(raw_dict.get("job_url") or "")
            raw_direct_url = str(raw_dict.get("job_url_direct") or "")
            canonical_url = clean_url(raw_url)
            apply_url = clean_url(raw_direct_url) if raw_direct_url else canonical_url

            raw_title = str(raw_dict.get("title") or "Unknown Title")
            norm_title = normalize_title(raw_title)

            raw_loc = str(raw_dict.get("location") or location)
            is_remote = bool(raw_dict.get("is_remote", False))
            norm_loc, remote_type = normalize_location(raw_loc, is_remote)

            desc = str(raw_dict.get("description") or "")
            company = str(raw_dict.get("company") or "Unknown Company")
            c_hash = generate_content_hash(company, norm_title, desc)

            date_posted = raw_dict.get("date_posted")
            age_hours, freshness_bucket = calculate_freshness(date_posted)

            ats_detected = detect_ats_type(apply_url) or detect_ats_type(raw_direct_url)

            job_record = {
                "source": str(raw_dict.get("site") or "unknown").lower(),
                "source_job_id": str(raw_dict.get("id") or ""),
                "canonical_url": canonical_url,
                "apply_url": apply_url,
                "company": company,
                "title": raw_title,
                "normalized_title": norm_title,
                "location": norm_loc,
                "remote_type": remote_type,
                "employment_type": str(raw_dict.get("job_type") or "full_time"),
                "posted_at": date_posted if pd.notna(date_posted) else None,
                "posted_at_source": str(raw_dict.get("date_posted") or ""),
                "posted_at_confidence": 1.0 if pd.notna(date_posted) else 0.5,
                "age_hours": age_hours,
                "freshness_bucket": freshness_bucket,
                "description": desc,
                "ats_type": ats_detected,
                "requirements": [],
                "preferred_requirements": [],
                "keywords": [],
                "content_hash": c_hash,
                "status": "NEW",
                "min_amount": float(raw_dict["min_amount"]) if pd.notna(raw_dict.get("min_amount")) else None,
                "max_amount": float(raw_dict["max_amount"]) if pd.notna(raw_dict.get("max_amount")) else None,
                "currency": str(raw_dict.get("currency") or "CAD")
            }

            source_record = {
                "source_name": job_record["source"],
                "source_url": canonical_url,
                "source_job_id": job_record["source_job_id"],
                "raw_payload": {k: v for k, v in raw_dict.items() if k != "description"}
            }

            collected_jobs.append((job_record, source_record))

    except Exception as e:
        logger.error(f"Error scraping '{search_term}': {str(e)}", exc_info=True)

    return collected_jobs
