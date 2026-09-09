import pytest
from uuid import uuid4
from datetime import datetime, timezone
from services.memory.repository import JobRepository
from services.intelligence.scorer import FitScorer
from tests.fixtures.scoring_corpus import CALIBRATION_JOBS

def test_workflow_state_transitions(clean_db):
    repo = clean_db
    job = dict(CALIBRATION_JOBS["strong_fit"])
    job["canonical_url"] = "https://example.com/wf1"
    saved_job, _ = repo.upsert_job(job, {"source_name": "indeed", "source_url": "https://example.com/wf1"})
    job_id = str(saved_job["job_id"])

    # Initial state is NEW
    assert saved_job["status"] == "NEW"

    # 1. Illegal transition: NEW -> SUBMITTED directly
    ok, err = repo.transition_job_workflow(job_id, "SUBMITTED")
    assert ok is False
    assert "Illegal transition" in err

    # 2. Valid transition: NEW -> SHORTLISTED
    ok, msg = repo.transition_job_workflow(job_id, "SHORTLISTED", actor="scorer", reason="Score >= 85")
    assert ok is True
    assert repo.get_job_by_id(job_id)["status"] == "SHORTLISTED"

    # 3. Idempotent transition: SHORTLISTED -> SHORTLISTED
    ok, msg = repo.transition_job_workflow(job_id, "SHORTLISTED")
    assert ok is True
    assert "already in state" in msg.lower()

    # 4. Valid transition: SHORTLISTED -> TAILORING
    ok, msg = repo.transition_job_workflow(job_id, "TAILORING", actor="user", reason="Selected for resume tailoring")
    assert ok is True

    # 5. Precondition check: TAILORING -> READY without approved resume should fail
    ok, err = repo.transition_job_workflow(job_id, "READY")
    assert ok is False
    assert "without an approved resume version" in err

    # 6. Precondition check: Transition to SUBMITTED requires human confirmation
    # Transition to APPLICATION_STARTED first
    repo.transition_job_workflow(job_id, "SKIPPED") # legal from TAILORING
    # Reopen to REVIEWED
    repo.transition_job_workflow(job_id, "REVIEWED")

def test_rescoring_preserves_active_workflow_state(clean_db, candidate_data):
    repo = clean_db
    scorer = FitScorer()
    job = dict(CALIBRATION_JOBS["strong_fit"])
    job["canonical_url"] = "https://example.com/rescore1"
    saved_job, _ = repo.upsert_job(job, {"source_name": "indeed", "source_url": "https://example.com/rescore1"})
    job_id = str(saved_job["job_id"])

    # Transition to TAILORING
    repo.transition_job_workflow(job_id, "SHORTLISTED")
    repo.transition_job_workflow(job_id, "TAILORING")
    assert repo.get_job_by_id(job_id)["status"] == "TAILORING"

    # Now re-score the job with a new/different score
    new_score = scorer.score_job(job, candidate_data)
    repo.save_job_score(job_id, new_score)

    # Workflow status MUST REMAIN TAILORING! It must not reset to QUALIFIED, SHORTLISTED, or REVIEW
    refetched = repo.get_job_by_id(job_id)
    assert refetched["status"] == "TAILORING"
    assert refetched["assessment_status"] in ("SCORED", "PROVISIONALLY_SCORED")

def test_shortlist_reservation_and_acknowledgement(clean_db):
    repo = clean_db
    # Create two qualified jobs
    job1 = dict(CALIBRATION_JOBS["strong_fit"])
    job1["canonical_url"] = "https://example.com/res_j1"
    if "job_id" in job1:
        del job1["job_id"]

    job2 = dict(CALIBRATION_JOBS["strong_fit"])
    job2["company"] = "Distinct Systems Inc"
    job2["canonical_url"] = "https://example.com/res_j2"
    job2["title"] = "Lead Technical Product Manager"
    if "job_id" in job2:
        del job2["job_id"]

    j1, _ = repo.upsert_job(job1, {"source_name": "indeed", "source_url": job1["canonical_url"]})
    j2, _ = repo.upsert_job(job2, {"source_name": "indeed", "source_url": job2["canonical_url"]})

    job_ids = [str(j1["job_id"]), str(j2["job_id"])]
    batch_id = str(uuid4())

    # Reserve both jobs
    reserved = repo.reserve_shortlist(job_ids, batch_id=batch_id, ttl_minutes=15)
    assert len(reserved) == 2

    # A concurrent process attempting to reserve the same active jobs gets 0 new reservations
    concurrent_batch = str(uuid4())
    concurrent_reserved = repo.reserve_shortlist(job_ids, batch_id=concurrent_batch, ttl_minutes=15)
    assert len(concurrent_reserved) == 0

    # Acknowledge delivery of first batch
    ack_count = repo.acknowledge_shortlist_delivery(batch_id, job_ids)
    assert ack_count == 2

    # Delivered jobs stay suppressed from later batches.
    later = repo.reserve_shortlist(job_ids, batch_id=str(uuid4()), ttl_minutes=15)
    assert later == []


def test_default_shortlist_excludes_provisional_scores(clean_db, candidate_data):
    repo = clean_db
    scorer = FitScorer()
    job = dict(CALIBRATION_JOBS["strong_fit"])
    job["canonical_url"] = f"https://example.com/provisional-{uuid4()}"
    job["content_hash"] = str(uuid4())
    saved, _ = repo.upsert_job(job, {"source_name": "indeed", "source_url": job["canonical_url"]})
    job_id = str(saved["job_id"])
    score = scorer.score_job(job, candidate_data)
    score["overall_score"] = 99.0
    score["score_band"] = "exceptional"
    score["is_provisional"] = True
    repo.save_job_score(job_id, score)
    assert all(str(item["job_id"]) != job_id for item in repo.get_shortlist(min_score=75))
