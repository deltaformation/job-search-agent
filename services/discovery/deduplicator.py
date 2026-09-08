import re
from typing import Dict, Any, List, Optional
from urllib.parse import urlparse

KNOWN_ATS_DOMAINS = [
    "lever.co", "greenhouse.io", "workday.com", "ashbyhq.com",
    "smartrecruiters.com", "icims.com", "taleo.net", "bamboohr.com",
    "rippling-ats.com", "myworkdayjobs.com"
]

def is_ats_url(url: str) -> bool:
    if not url:
        return False
    domain = urlparse(url).netloc.lower()
    return any(ats in domain for ats in KNOWN_ATS_DOMAINS)

def detect_ats_type(url: str) -> Optional[str]:
    if not url:
        return None
    domain = urlparse(url).netloc.lower()
    for ats in KNOWN_ATS_DOMAINS:
        if ats in domain:
            return ats.split('.')[0].capitalize()
    return None

def deduplicate_job_stream(existing_jobs: List[Dict[str, Any]], candidate_job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Checks if candidate_job matches any existing_jobs across 5 signals:
    1. canonical_url match
    2. direct ATS apply_url match
    3. (source, source_job_id) match
    4. (company, normalized_title, location) match
    5. content_hash match
    
    Returns the matching existing_job if duplicate, else None.
    """
    c_url = candidate_job.get("canonical_url")
    c_apply = candidate_job.get("apply_url")
    c_source = candidate_job.get("source")
    c_source_id = candidate_job.get("source_job_id")
    c_company = candidate_job.get("company", "").strip().lower()
    c_title = candidate_job.get("normalized_title", "").strip().lower()
    c_loc = candidate_job.get("location", "").strip().lower()
    c_hash = candidate_job.get("content_hash")

    for ej in existing_jobs:
        # Signal 1: Canonical URL
        if c_url and ej.get("canonical_url") == c_url:
            return ej

        # Signal 2: Apply URL match (especially ATS links)
        if c_apply and ej.get("apply_url") == c_apply:
            return ej

        # Signal 3: Source and Source Job ID match
        if c_source and c_source_id and ej.get("source") == c_source and ej.get("source_job_id") == c_source_id:
            return ej

        # Signal 4: Company + Normalized Title + Location match
        ej_company = ej.get("company", "").strip().lower()
        ej_title = ej.get("normalized_title", "").strip().lower()
        ej_loc = ej.get("location", "").strip().lower()
        if c_company and c_title and ej_company == c_company and ej_title == c_title:
            # Check if locations overlap (e.g. Toronto and Toronto, ON, Canada)
            if c_loc in ej_loc or ej_loc in c_loc or "remote" in c_loc and "remote" in ej_loc:
                return ej

        # Signal 5: Content hash match
        if c_hash and ej.get("content_hash") == c_hash:
            return ej

    return None
