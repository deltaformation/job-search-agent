import pytest
from services.discovery.normalizer import clean_url, normalize_title, normalize_location, generate_content_hash
from services.discovery.deduplicator import deduplicate_job_stream, is_ats_url, detect_ats_type

def test_clean_url_strips_tracking():
    dirty_indeed = "https://ca.indeed.com/viewjob?jk=12345abcdef&utm_source=mailer&utm_campaign=daily"
    assert clean_url(dirty_indeed) == "https://ca.indeed.com/viewjob?jk=12345abcdef"

    dirty_linkedin = "https://www.linkedin.com/jobs/view/9988776655/?trackingId=abc&refId=def"
    assert clean_url(dirty_linkedin) == "https://www.linkedin.com/jobs/view/9988776655"

def test_normalize_title():
    assert normalize_title("Sr. Product Manager, Technical") == "Senior Technical Product Manager"
    assert normalize_title("Senior Product Manager - Growth") == "Senior Product Manager"
    assert normalize_title("Technical Product Manager") == "Technical Product Manager"
    assert normalize_title("Lead Product Manager") == "Lead Product Manager"

def test_normalize_location():
    loc, remote = normalize_location("Toronto, Ontario", is_remote=False)
    assert "Toronto" in loc
    assert remote == "onsite"

    loc_remote, remote_type = normalize_location("Ontario", is_remote=True)
    assert remote_type == "remote"

def test_ats_detection():
    assert is_ats_url("https://jobs.lever.co/company/job123") is True
    assert detect_ats_type("https://boards.greenhouse.io/corp/123") == "Greenhouse"
    assert is_ats_url("https://example.com/careers") is False

def test_deduplication_5_signals():
    existing = [{
        "canonical_url": "https://ca.indeed.com/viewjob?jk=job001",
        "apply_url": "https://jobs.lever.co/fintech/pm",
        "source": "indeed",
        "source_job_id": "job001",
        "company": "FinTech Corp",
        "normalized_title": "Senior Technical Product Manager",
        "location": "Toronto, ON, Canada",
        "content_hash": "hash12345"
    }]

    # Match by canonical URL
    assert deduplicate_job_stream(existing, {
        "canonical_url": "https://ca.indeed.com/viewjob?jk=job001",
        "company": "Other",
        "normalized_title": "Other",
        "location": "Other"
    }) is not None

    # Match by ATS apply URL
    assert deduplicate_job_stream(existing, {
        "canonical_url": "https://linkedin.com/jobs/view/9999",
        "apply_url": "https://jobs.lever.co/fintech/pm",
        "company": "Other",
        "normalized_title": "Other",
        "location": "Other"
    }) is not None

    # Match by company + normalized title + location
    assert deduplicate_job_stream(existing, {
        "canonical_url": "https://glassdoor.com/job/8888",
        "company": "fintech corp",
        "normalized_title": "Senior Technical Product Manager",
        "location": "Toronto, ON"
    }) is not None

    # Unique job (no match)
    assert deduplicate_job_stream(existing, {
        "canonical_url": "https://ca.indeed.com/viewjob?jk=different_job",
        "company": "Brand New Corp",
        "normalized_title": "Product Designer",
        "location": "Vancouver, BC",
        "content_hash": "different_hash"
    }) is None
