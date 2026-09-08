import uuid
import pytest
from services.memory.repository import JobRepository

def test_job_repository_roundtrip():
    repo = JobRepository()
    
    # 1. Candidate profile retrieval
    profile = repo.get_candidate_profile()
    assert profile is not None
    assert profile["full_name"] == "Mouad Atfi"
    assert len(profile["verified_facts"]) >= 5

    # 2. Job upsert
    test_key = str(uuid.uuid4())[:8]
    job_payload = {
        "source": "test_board",
        "source_job_id": f"src_{test_key}",
        "canonical_url": f"https://example.com/jobs/{test_key}",
        "apply_url": f"https://jobs.lever.co/test/{test_key}",
        "company": "Test Innovators Inc",
        "title": "Senior Technical Product Manager",
        "normalized_title": "Senior Technical Product Manager",
        "location": "Toronto, ON, Canada",
        "remote_type": "hybrid",
        "employment_type": "full_time",
        "posted_at": None,
        "posted_at_source": "today",
        "age_hours": 2.0,
        "freshness_bucket": "HOT",
        "description": "Building cloud scale APIs with Kafka and PostgreSQL.",
        "ats_type": "Lever",
        "requirements": ["AWS", "Kafka", "5+ years PM"],
        "content_hash": f"hash_{test_key}",
        "status": "NEW"
    }
    source_payload = {
        "source_name": "test_board",
        "source_url": job_payload["canonical_url"],
        "source_job_id": job_payload["source_job_id"],
        "raw_payload": {"test": True}
    }

    saved_job, is_new = repo.upsert_job(job_payload, source_payload)
    assert is_new is True
    job_id = str(saved_job["job_id"])

    # 3. Save score
    score_payload = {
        "overall_score": 92.5,
        "recommendation": "apply",
        "role_alignment": 95.0,
        "experience_score": 90.0,
        "seniority_score": 95.0,
        "skills_score": 90.0,
        "domain_score": 95.0,
        "location_score": 100.0,
        "comp_score": 80.0,
        "preference_score": 85.0,
        "strengths": ["Strong cloud experience"],
        "gaps": [],
        "risks": [],
        "evidence_fact_ids": ["fact_001", "fact_002"]
    }
    saved_score = repo.save_job_score(job_id, score_payload)
    assert float(saved_score["overall_score"]) == 92.5

    # 4. Query job by ID
    retrieved = repo.get_job_by_id(job_id)
    assert retrieved is not None
    assert retrieved["status"] == "QUALIFIED"
    assert len(retrieved["sources"]) >= 1

    # 5. Query feed with filters
    feed = repo.get_jobs(freshness="HOT", min_score=90.0, status="QUALIFIED")
    assert any(str(j["job_id"]) == job_id for j in feed)
