import pytest
import psycopg
from services.intelligence.scorer import FitScorer
from services.documents.validator import ClaimValidator
from tests.fixtures.scoring_corpus import CALIBRATION_JOBS

def test_calibration_corpus_strong_fit(candidate_data):
    scorer = FitScorer()
    job = CALIBRATION_JOBS["strong_fit"]
    score = scorer.score_job(job, candidate_data)

    assert score["overall_score"] >= 85.0
    assert score["recommendation"] == "apply"
    assert score["score_band"] in ("strong", "exceptional")
    assert score["role_alignment"] >= 90.0
    assert score["location_score"] == 100.0
    assert len(score["strengths"]) >= 2

def test_calibration_corpus_weak_fit(candidate_data):
    scorer = FitScorer()
    job = CALIBRATION_JOBS["weak_fit"]
    score = scorer.score_job(job, candidate_data)

    assert score["overall_score"] < 65.0
    assert score["recommendation"] == "skip"
    assert score["score_band"] == "weak"
    assert score["role_alignment"] <= 50.0

def test_calibration_corpus_us_only_remote(candidate_data):
    scorer = FitScorer()
    job = CALIBRATION_JOBS["us_only_remote"]
    score = scorer.score_job(job, candidate_data)

    # Must receive location score 0 and severe penalty
    assert score["location_score"] == 0.0
    assert any("visa barrier" in r.lower() or "us-only" in r.lower() for r in score["risks"])
    # Score should drop drastically due to penalty
    assert score["overall_score"] < 60.0
    assert score["recommendation"] == "skip"

def test_calibration_corpus_absent_salary(candidate_data):
    scorer = FitScorer()
    job = CALIBRATION_JOBS["absent_salary"]
    score = scorer.score_job(job, candidate_data)

    # Missing compensation marked unknown in uncertainties
    assert any("not disclosed" in u.lower() for u in score["uncertainties"])
    assert score["factor_breakdown"]["compensation_fit"]["evidence_known"] is False
    # Overall score remains strong due to strong role/experience/location
    assert score["overall_score"] >= 75.0

def test_requirement_analysis_validation(candidate_data):
    validator = ClaimValidator(candidate_data)
    jd_text = "Must have 5+ years experience building cloud platforms with AWS and Kafka."

    # 1. Valid requirement analysis
    valid_reqs = [
        {
            "requirement_id": "req_001",
            "jd_quote": "5+ years experience building cloud platforms with AWS and Kafka",
            "description": "5+ years cloud platform experience with AWS and Kafka",
            "category": "experience",
            "importance": "required",
            "match_status": "partial",
            "evidence_fact_ids": ["fact_001"],
            "evidence_quotes": ["Architected and launched a distributed multi-region API platform reducing p99 latency by 42% while scaling to 50M+ daily requests."],
            "review_status": "proposed",
            "notes": "Fact 001 provides distributed API platform on AWS and Kafka"
        }
    ]
    ok, errors = validator.validate_requirement_analysis(valid_reqs, jd_text=jd_text)
    assert ok is True
    assert len(errors) == 0

    # 2. Reject unapproved fact_id
    bad_reqs_fake_id = [
        {
            "requirement_id": "req_002",
            "jd_quote": "5+ years experience building cloud platforms with AWS and Kafka",
            "category": "experience",
            "importance": "required",
            "match_status": "partial",
            "evidence_fact_ids": ["fact_9999_fake"],
            "review_status": "proposed"
        }
    ]
    ok, errors = validator.validate_requirement_analysis(bad_reqs_fake_id, jd_text=jd_text)
    assert ok is False
    assert any("unknown or unapproved fact_id" in e for e in errors)

    # 3. Reject non-verbatim quote
    bad_reqs_non_quote = [
        {
            "requirement_id": "req_003",
            "jd_quote": "Invented requirement not in JD text",
            "category": "skill",
            "importance": "required",
            "match_status": "unsupported",
            "evidence_fact_ids": []
        }
    ]
    ok, errors = validator.validate_requirement_analysis(bad_reqs_non_quote, jd_text=jd_text)
    assert ok is False
    assert any("must quote exact JD text" in e for e in errors)

def test_analysis_submission_snapshot_mismatch(candidate_data):
    validator = ClaimValidator(candidate_data)
    jd_snapshot = {"id": "11111111-1111-1111-1111-111111111111", "cleaned_text": "We need AWS experience."}
    cand_snapshot = {"id": "22222222-2222-2222-2222-222222222222"}

    # Submission with stale snapshot ID
    sub_data = {
        "jd_snapshot_id": "wrong-stale-id",
        "candidate_snapshot_id": str(cand_snapshot["id"]),
        "requirements": [{"requirement_id": "r1", "jd_quote": "AWS", "match_status": "unsupported", "category": "skill", "importance": "required"}]
    }

    ok, errors = validator.validate_analysis_submission(sub_data, jd_snapshot, cand_snapshot)
    assert ok is False
    assert any("Stale or mismatched jd_snapshot_id" in e for e in errors)

def test_job_analysis_persistence_and_immutability(clean_db):
    repo = clean_db
    profile = repo.get_candidate_profile()
    assert profile is not None

    # Create test job and snapshots
    job = dict(CALIBRATION_JOBS["strong_fit"])
    job["canonical_url"] = "https://example.com/j_analysis_immut"
    saved_job, _ = repo.upsert_job(job, {"source_name": "indeed", "source_url": job["canonical_url"]})
    job_id = str(saved_job["job_id"])

    jd_snap_id = repo.save_jd_snapshot(job_id, job["description"], job["description"])
    cand_snap_id = repo.save_candidate_snapshot(str(profile["id"]), profile)

    # Save analysis version 1
    reqs = [{
        "requirement_id": "req_001",
        "jd_quote": "cloud platforms, REST APIs",
        "category": "skill",
        "importance": "required",
        "match_status": "matched",
            "evidence_fact_ids": ["fact_001"],
            "evidence_quotes": ["Architected and launched a distributed multi-region API platform reducing p99 latency by 42% while scaling to 50M+ daily requests."],
        "review_status": "confirmed"
    }]
    analysis_1 = repo.save_job_analysis(job_id, jd_snap_id, cand_snap_id, reqs, notes="V1 notes")
    assert analysis_1["version_number"] == 1

    # Save analysis version 2 (append-only)
    analysis_2 = repo.save_job_analysis(job_id, jd_snap_id, cand_snap_id, reqs, notes="V2 notes")
    assert analysis_2["version_number"] == 2

    # Verify immutability trigger on job_analyses: UPDATE should raise exception
    with pytest.raises(psycopg.Error, match="Job analysis versions are immutable"):
        with repo.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE job_analyses SET notes = 'tampered' WHERE id = %s;", (analysis_1["id"],))
