import uuid
import pytest
from services.memory.repository import JobRepository

def test_job_repository_roundtrip(isolated_repo: JobRepository) -> None:
    repo = isolated_repo
    
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
        "evidence_fact_ids": ["fact_001", "fact_002"],
        "is_provisional": False,
    }
    saved_score = repo.save_job_score(job_id, score_payload)
    assert float(saved_score["overall_score"]) == 92.5
    with repo.get_connection() as conn:
        versions = conn.execute(
            "SELECT version_number, score_data FROM job_score_versions WHERE job_id = %s",
            (job_id,),
        ).fetchall()
    assert len(versions) == 1
    assert versions[0]["version_number"] == 1
    assert versions[0]["score_data"]["overall_score"] == 92.5

    # 4. Query job by ID
    retrieved = repo.get_job_by_id(job_id)
    assert retrieved is not None
    assert retrieved["status"] == "QUALIFIED"
    assert len(retrieved["sources"]) >= 1

    # 5. Query feed with filters
    feed = repo.get_jobs(freshness="HOT", min_score=90.0, status="QUALIFIED")
    assert any(str(j["job_id"]) == job_id for j in feed)


def make_job(key: str) -> dict:
    return {
        "source": "review_test", "source_job_id": key,
        "canonical_url": f"https://example.com/{key}",
        "apply_url": f"https://jobs.lever.co/review/{key}",
        "company": key, "title": "Product Manager",
        "normalized_title": "Product Manager", "location": "Toronto, ON, Canada",
        "content_hash": key, "age_hours": 1, "freshness_bucket": "HOT",
    }


def make_source(job: dict) -> dict:
    return {"source_name": job["source"], "source_job_id": job["source_job_id"],
            "source_url": job["canonical_url"], "raw_payload": {}}


@pytest.mark.parametrize("signal", ["canonical_url", "content_hash", "apply_url", "source_job_id", "company"])
def test_persisted_deduplication(isolated_repo: JobRepository, signal: str) -> None:
    repo = isolated_repo
    original = make_job(uuid.uuid4().hex)
    saved, _ = repo.upsert_job(original, make_source(original))
    incoming = make_job(uuid.uuid4().hex)
    incoming[signal] = original[signal]
    if signal == "company":
        incoming["company"] = f"  {original['company'].upper()}  "
        incoming["location"] = "Toronto, ON"
    merged, is_new = repo.upsert_job(incoming, make_source(incoming))
    assert not is_new
    assert merged["job_id"] == saved["job_id"]
    details = repo.get_job_by_id(str(saved["job_id"]))
    assert len(details["sources"]) == 2
    assert details["canonical_url"] == original["canonical_url"]
    # A later observation must resolve a source ID merged from another board.
    later = make_job(uuid.uuid4().hex)
    later["source_job_id"] = incoming["source_job_id"]
    merged_again, is_new = repo.upsert_job(later, make_source(later))
    assert not is_new
    assert merged_again["job_id"] == saved["job_id"]


def test_upgrade_board_link_to_ats(isolated_repo: JobRepository) -> None:
    job = make_job(uuid.uuid4().hex)
    job["apply_url"] = job["canonical_url"]
    saved, _ = isolated_repo.upsert_job(job, make_source(job))
    job["apply_url"] = f"https://jobs.lever.co/review/{uuid.uuid4().hex}"
    upgraded, is_new = isolated_repo.upsert_job(job, make_source(job))
    assert not is_new
    assert upgraded["apply_url"] == job["apply_url"]
    assert upgraded["ats_type"] == "Lever"
    job["apply_url"] = job["canonical_url"]
    retained, _ = isolated_repo.upsert_job(job, make_source(job))
    assert retained["apply_url"] == upgraded["apply_url"]


@pytest.mark.parametrize("hours,bucket", [(5, "HOT"), (30, "FRESH"), (60, "RECENT"), (80, "STALE")])
@pytest.mark.parametrize("has_posted_at", [True, False])
def test_freshness_reads_and_filters_current_age(
    isolated_repo: JobRepository, hours: int, bucket: str, has_posted_at: bool
) -> None:
    from datetime import datetime, timedelta, timezone
    job = make_job(uuid.uuid4().hex)
    posted = datetime.now(timezone.utc) - timedelta(hours=hours)
    job["posted_at"] = posted if has_posted_at else None
    saved, _ = isolated_repo.upsert_job(job, make_source(job))
    job_id = saved["job_id"]
    with isolated_repo.get_connection() as conn:
        conn.execute("UPDATE jobs SET first_seen_at = %s WHERE job_id = %s", (posted, job_id))
    details = isolated_repo.get_job_by_id(str(job_id))
    assert details["freshness_bucket"] == bucket
    assert abs(float(details["age_hours"]) - hours) < 0.1
    feed = isolated_repo.get_jobs(freshness=bucket, limit=1000)
    assert any(j["job_id"] == job_id and j["freshness_bucket"] == bucket for j in feed)
    assert all(j["job_id"] != job_id for j in isolated_repo.get_jobs(max_age_hours=hours - 1, limit=1000))
    assert any(j["job_id"] == job_id for j in isolated_repo.get_jobs(max_age_hours=hours + 1, limit=1000))


def test_profile_excludes_unverified_skills(isolated_repo: JobRepository) -> None:
    repo = isolated_repo
    profile = repo.get_candidate_profile()
    key = uuid.uuid4().hex
    with repo.get_connection() as conn:
        conn.execute("""INSERT INTO skills (candidate_id, category, name, verified)
                        VALUES (%s, 'technical', %s, FALSE)""", (profile["id"], key))
    assert all(s["name"] != key and s["verified"] for s in repo.get_candidate_profile()["skills"])
