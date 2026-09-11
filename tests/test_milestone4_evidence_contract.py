"""Dedicated test suite for Milestone 4: Evidence and Preparation Contract."""
import hashlib
import json
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4
import pytest

from services.documents.pipeline import generate_documents
from services.documents.tailor import ResumeTailor
from services.documents.validator import ClaimValidator
from services.intelligence.models import (
    CanonicalRequirement,
    KeywordCoverageResult,
    PreparationRequestModel,
    PreparationRequestStatus,
    RequirementCategory,
    RequirementImportance,
    RequirementMatchStatus,
    RequirementReviewStatus,
    validate_preparation_request_transition,
)
from services.intelligence.scorer import FitScorer
from services.memory.repository import JobRepository


class FakeRenderer:
    def __init__(self, tmp_path: Path, fail: bool = False) -> None:
        self.tmp_path = tmp_path
        self.fail = fail

    def render_resume_to_html(self, profile: dict, draft: dict, variants: object = None) -> str:
        return "<html><body>Fake Resume</body></html>"

    def template_info(self) -> dict:
        return {
            "template_id": "test_template",
            "template_version": "v0",
            "template_hash": "0" * 64,
            "render_schema_version": "v1",
        }

    def compile_html_to_pdf(self, html: str, job_id: str, version: int, digest: str):
        if self.fail:
            raise RuntimeError("Renderer crash simulation")
        source = self.tmp_path / f"resume_{version}.html"
        pdf = self.tmp_path / f"resume_{version}.pdf"
        pdf.write_bytes(b"%PDF-1.4 Fake PDF Content")
        source.write_text(html)
        return str(source), str(pdf), 1


def create_test_job(repo: JobRepository, desc: str = "Senior PM with API platform experience") -> str:
    key = uuid4().hex
    job, _ = repo.upsert_job({
        "canonical_url": f"https://example.com/job/{key}",
        "content_hash": hashlib.sha256(f"{key}{desc}".encode("utf-8")).hexdigest(),
        "company": f"TestCorp_{key[:8]}",
        "title": "Senior Technical Product Manager",
        "location": "Toronto, ON, Canada",
        "description": desc
    }, {})
    return str(job["job_id"])


# -------------------------------------------------------------
# 1. Canonical Requirement Serialization Tests
# -------------------------------------------------------------
def test_canonical_requirement_serialization() -> None:
    req = CanonicalRequirement(
        requirement_id="req_001",
        jd_quote="5+ years in product management",
        description="Core PM experience",
        category=RequirementCategory.EXPERIENCE,
        importance=RequirementImportance.REQUIRED,
        match_status=RequirementMatchStatus.PARTIAL,
        evidence_fact_ids=["fact_001"],
        evidence_quotes=["Scaled platform to $150M+ ARR"],
        review_status=RequirementReviewStatus.PROPOSED,
        analysis_notes="Proposed partial evidence match"
    )
    dumped = req.model_dump()

    assert dumped["requirement_id"] == "req_001"
    assert dumped["jd_quote"] == "5+ years in product management"
    assert dumped["match_status"] == "partial"
    assert dumped["evidence_fact_ids"] == ["fact_001"]
    assert dumped["evidence_quotes"] == ["Scaled platform to $150M+ ARR"]
    assert dumped["review_status"] == "proposed"
    assert "matched_fact_ids" not in dumped


def test_legacy_matched_fact_ids_translation() -> None:
    legacy_input = {
        "requirement_id": "req_002",
        "jd_quote": "Experience with cloud platforms",
        "description": "Cloud platform experience",
        "category": "skill",
        "importance": "required",
        "status": "matched",
        "matched_fact_ids": ["fact_002", "fact_003"],
        "evidence_quotes": ["Quote 1", "Quote 2"]
    }
    req = CanonicalRequirement.model_validate(legacy_input)
    assert req.evidence_fact_ids == ["fact_002", "fact_003"]
    assert req.match_status == RequirementMatchStatus.MATCHED

    dumped = req.model_dump()
    assert dumped["evidence_fact_ids"] == ["fact_002", "fact_003"]
    assert "matched_fact_ids" not in dumped


def test_unsupported_and_gap_forbid_evidence_ids_and_quotes() -> None:
    with pytest.raises(ValueError, match="must not contain evidence_fact_ids"):
        CanonicalRequirement(
            requirement_id="req_003",
            jd_quote="Deep expertise in Rust and Haskell",
            match_status=RequirementMatchStatus.UNSUPPORTED,
            evidence_fact_ids=["fact_001"],
            evidence_quotes=[]
        )

    with pytest.raises(ValueError, match="must not contain evidence_quotes"):
        CanonicalRequirement(
            requirement_id="req_004",
            jd_quote="Must have active Top Secret security clearance",
            match_status=RequirementMatchStatus.GAP,
            evidence_fact_ids=[],
            evidence_quotes=["Some quote"]
        )


def test_canonical_requirement_rejects_blank_or_duplicate_evidence() -> None:
    with pytest.raises(ValueError, match="nonempty strings"):
        CanonicalRequirement(
            requirement_id="req_blank",
            jd_quote="Python",
            match_status="partial",
            evidence_fact_ids=["fact_001"],
            evidence_quotes=["   "],
        )

    with pytest.raises(ValueError, match="must not contain duplicates"):
        CanonicalRequirement(
            requirement_id="req_duplicate",
            jd_quote="Python",
            match_status="partial",
            evidence_fact_ids=["fact_001", "fact_001"],
            evidence_quotes=["Approved fact text"],
        )


def test_repository_rejects_invalid_requirement_before_database_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = JobRepository("postgresql://unused")

    def fail_if_called() -> None:
        pytest.fail("invalid requirements must fail before database access")

    monkeypatch.setattr(repo, "get_connection", fail_if_called)
    with pytest.raises(ValueError, match="requires at least one evidence_fact_id"):
        repo.save_job_analysis(
            job_id=str(uuid4()),
            jd_snapshot_id=str(uuid4()),
            candidate_snapshot_id=str(uuid4()),
            requirements=[{
                "requirement_id": "req_invalid",
                "jd_quote": "Python",
                "match_status": "matched",
                "evidence_fact_ids": [],
                "evidence_quotes": [],
            }],
        )

def test_validator_enforces_evidence_contract(candidate_data: dict) -> None:
    validator = ClaimValidator(candidate_data)
    # Unsupported citing evidence must fail validation
    invalid_reqs = [{
        "requirement_id": "req_unsupp",
        "jd_quote": "Exact JD text",
        "category": "experience",
        "importance": "required",
        "match_status": "unsupported",
        "evidence_fact_ids": ["fact_001"],
        "evidence_quotes": []
    }]
    valid, errors = validator.validate_requirement_analysis(invalid_reqs, jd_text="Exact JD text")
    assert not valid
    assert any("contains evidence fact IDs" in err for err in errors)


# -------------------------------------------------------------
# 2. Evidence Fact IDs Affect Resume Fact Ranking
# -------------------------------------------------------------
def test_evidence_fact_ids_affects_resume_fact_ranking(candidate_data: dict) -> None:
    tailor = ResumeTailor(candidate_data)
    approved_facts = [
        f for f in candidate_data.get("verified_facts", [])
        if f.get("verification_status") == "approved"
    ]
    assert len(approved_facts) >= 2
    fact_a = approved_facts[0]["fact_id"]
    fact_b = approved_facts[1]["fact_id"]

    neutral_job = {
        "job_id": str(uuid4()),
        "title": "General Product Manager",
        "company": "NeutralCorp",
        "description": "General product management responsibilities."
    }

    # Prioritize fact_b
    draft_b = tailor.generate_tailored_draft(neutral_job, evidence_fact_ids=[fact_b])
    claims_b = [c for c in draft_b["claims"] if c.get("section") in ("summary", "experience")]
    first_fact_b = claims_b[0]["fact_ids"][0]
    assert first_fact_b == fact_b

    # Prioritize fact_a
    draft_a = tailor.generate_tailored_draft(neutral_job, evidence_fact_ids=[fact_a])
    claims_a = [c for c in draft_a["claims"] if c.get("section") in ("summary", "experience")]
    first_fact_a = claims_a[0]["fact_ids"][0]
    assert first_fact_a == fact_a


# -------------------------------------------------------------
# 3. Fail-Closed Analysis & Snapshot Lineage Preconditions
# -------------------------------------------------------------
def test_resume_generation_rejected_without_analysis(clean_db: JobRepository, tmp_path: Path) -> None:
    job_id = create_test_job(clean_db)
    result = generate_documents(clean_db, job_id, renderer=FakeRenderer(tmp_path))
    assert result["status"] == "blocked"
    assert "ANALYSIS_REQUIRED" in result["blockers"]
    assert clean_db.get_latest_resume_for_job(job_id) is None


def test_resume_generation_rejected_on_stale_jd(clean_db: JobRepository, tmp_path: Path) -> None:
    initial_desc = "Initial JD description with API platform leadership."
    job_id = create_test_job(clean_db, desc=initial_desc)
    profile = clean_db.get_candidate_profile()
    cand_snap_id = clean_db.save_candidate_snapshot(str(profile["id"]), profile)
    jd_snap_id = clean_db.save_jd_snapshot(job_id, initial_desc, initial_desc)

    clean_db.save_job_analysis(
        job_id=job_id,
        jd_snapshot_id=jd_snap_id,
        candidate_snapshot_id=cand_snap_id,
        requirements=[],
        notes="Initial analysis"
    )

    # First generation succeeds with current snapshots
    first_gen = generate_documents(clean_db, job_id, renderer=FakeRenderer(tmp_path))
    assert first_gen["status"] == "success"

    # Now mutate the job description in the database
    updated_desc = "MUTATED JD: We also require 10+ years in distributed systems."
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE jobs SET description = %s WHERE job_id = %s;", (updated_desc, job_id))
            conn.commit()

    # Second generation must be blocked due to stale JD
    second_gen = generate_documents(clean_db, job_id, renderer=FakeRenderer(tmp_path))
    assert second_gen["status"] == "blocked"
    assert "STALE_ANALYSIS_JD" in second_gen["blockers"]
    assert "NEW_ANALYSIS_REQUIRED" in second_gen["blockers"]

    # Verify a new JD snapshot was created
    new_jd_snap = clean_db.get_jd_snapshot(job_id)
    assert new_jd_snap["id"] != jd_snap_id
    assert updated_desc in new_jd_snap["cleaned_text"]


def test_resume_generation_rejected_on_stale_candidate_profile(clean_db: JobRepository, tmp_path: Path) -> None:
    desc = "Standard JD description for Senior PM."
    job_id = create_test_job(clean_db, desc=desc)
    profile = clean_db.get_candidate_profile()
    cand_snap_id = clean_db.save_candidate_snapshot(str(profile["id"]), profile)
    jd_snap_id = clean_db.save_jd_snapshot(job_id, desc, desc)

    clean_db.save_job_analysis(
        job_id=job_id,
        jd_snapshot_id=jd_snap_id,
        candidate_snapshot_id=cand_snap_id,
        requirements=[],
        notes="Analysis bound to profile snapshot"
    )

    # Mutate candidate profile in database
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE candidate_profile SET headline = 'Updated Headline' WHERE id = %s;",
                (profile["id"],)
            )
            conn.commit()

    result = generate_documents(clean_db, job_id, renderer=FakeRenderer(tmp_path))
    assert result["status"] == "blocked"
    assert "STALE_ANALYSIS_PROFILE" in result["blockers"]


def test_resume_generation_rejected_on_unapproved_or_unknown_fact(clean_db: JobRepository, tmp_path: Path) -> None:
    desc = "Requires leadership in cloud scaling."
    job_id = create_test_job(clean_db, desc=desc)
    profile = clean_db.get_candidate_profile()
    cand_snap_id = clean_db.save_candidate_snapshot(str(profile["id"]), profile)
    jd_snap_id = clean_db.save_jd_snapshot(job_id, desc, desc)

    # Insert analysis citing non-existent fact_999 directly into database
    with clean_db.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO job_analyses (job_id, version_number, jd_snapshot_id, candidate_snapshot_id, requirements)
                VALUES (%s, 1, %s, %s, %s) RETURNING id;
            """, (
                job_id,
                jd_snap_id,
                cand_snap_id,
                json.dumps([{
                    "requirement_id": "req_bad",
                    "jd_quote": "Requires leadership",
                    "category": "experience",
                    "importance": "required",
                    "match_status": "matched",
                    "evidence_fact_ids": ["fact_non_existent_999"],
                    "evidence_quotes": ["Some quote"],
                    "review_status": "proposed"
                }])
            ))
            conn.commit()

    result = generate_documents(clean_db, job_id, renderer=FakeRenderer(tmp_path))
    assert result["status"] == "blocked"
    assert "UNAPPROVED_OR_UNKNOWN_FACT" in result["blockers"]


def test_resume_generation_rejects_snapshot_evidence_quote_mismatch(
    candidate_data: dict,
) -> None:
    job_id = str(uuid4())
    jd_text = "Exact JD requirement: Python"
    jd_snapshot_id = str(uuid4())
    candidate_snapshot_id = str(uuid4())
    profile_hash = hashlib.sha256(
        json.dumps(candidate_data, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()

    class SnapshotRepo:
        def get_candidate_profile(self) -> dict:
            return candidate_data

        def get_job_by_id(self, requested_job_id: str) -> dict:
            assert requested_job_id == job_id
            return {"job_id": job_id, "description": jd_text}

        def get_job_analysis(self, requested_job_id: str) -> dict:
            assert requested_job_id == job_id
            return {
                "id": str(uuid4()),
                "jd_snapshot_id": jd_snapshot_id,
                "candidate_snapshot_id": candidate_snapshot_id,
                "requirements": [{
                    "requirement_id": "req_quote",
                    "jd_quote": "Python",
                    "match_status": "partial",
                    "evidence_fact_ids": ["fact_001"],
                    "evidence_quotes": ["A fabricated evidence quote"],
                }],
            }

        def get_jd_snapshot(self, requested_job_id: str) -> dict:
            assert requested_job_id == job_id
            return {
                "id": str(uuid4()),
                "content_hash": hashlib.sha256(b"superseded JD").hexdigest(),
                "cleaned_text": "superseded JD",
            }

        def get_jd_snapshot_by_hash(self, requested_job_id: str, content_hash: str) -> dict:
            assert requested_job_id == job_id
            assert content_hash == hashlib.sha256(jd_text.encode("utf-8")).hexdigest()
            return {
                "id": jd_snapshot_id,
                "content_hash": content_hash,
                "cleaned_text": jd_text,
            }

        def get_candidate_snapshot(self, requested_snapshot_id: str) -> dict:
            assert requested_snapshot_id == candidate_snapshot_id
            return {
                "id": candidate_snapshot_id,
                "candidate_id": candidate_data["id"],
                "snapshot_hash": profile_hash,
                "profile_data": candidate_data,
            }

    result = generate_documents(SnapshotRepo(), job_id)  # type: ignore[arg-type]
    assert result["status"] == "blocked"
    assert result["blockers"] == ["INVALID_REQUIREMENT_ANALYSIS"]
    assert any("exactly match" in error for error in result["errors"])


# -------------------------------------------------------------
# 4. Transparent Keyword Coverage Tests
# -------------------------------------------------------------
def test_keyword_coverage_verified_vs_unverified(candidate_data: dict) -> None:
    scorer = FitScorer()
    job = {
        "job_id": str(uuid4()),
        "title": "Senior Product Manager",
        "description": "Looking for skills in AWS, Kafka, PostgreSQL, Haskell, Rust."
    }

    # AWS, Kafka, PostgreSQL are verified in candidate_data fixture
    # Haskell, Rust are unverified terms
    required_terms = ["AWS", "Kafka", "PostgreSQL", "Haskell", "Rust"]
    res = scorer.calculate_keyword_coverage(job, candidate_data, required_terms=required_terms)

    assert res["algorithm_version"] == "keyword_v1"
    assert res["total_required_terms"] == 5
    assert "aws" in res["matched_terms"]
    assert "kafka" in res["matched_terms"]
    assert "postgresql" in res["matched_terms"]
    assert "haskell" in res["unsupported_terms"]
    assert "rust" in res["unsupported_terms"]
    assert res["supported_required_terms"] == 3
    # 3 / 5 * 100 = 60.0%
    assert res["coverage_percentage"] == 60.0

    # Ensure source fact IDs are provided for matched terms
    assert isinstance(res["term_sources"], dict)
    assert len(res["term_sources"]["kafka"]) >= 1


def test_keyword_coverage_integrated_in_score_job(candidate_data: dict) -> None:
    scorer = FitScorer()
    job = {
        "job_id": str(uuid4()),
        "title": "Senior Technical Product Manager",
        "location": "Toronto, ON, Canada",
        "remote_type": "remote",
        "description": "Requires experience with AWS, Kafka, PostgreSQL, REST APIs."
    }
    score_result = scorer.score_job(job, candidate_data)
    assert "keyword_coverage" in score_result
    cov = score_result["keyword_coverage"]
    assert cov["algorithm_version"] == "keyword_v1"
    assert cov["coverage_percentage"] > 0.0


def test_keyword_coverage_excludes_preferred_requirements(candidate_data: dict) -> None:
    scorer = FitScorer()
    analysis = {
        "requirements": [
            {
                "requirement_id": "req_required",
                "jd_quote": "AWS",
                "description": "AWS",
                "importance": "required",
                "match_status": "unsupported",
            },
            {
                "requirement_id": "req_preferred",
                "jd_quote": "Rust",
                "description": "Rust",
                "importance": "preferred",
                "match_status": "unsupported",
            },
        ]
    }
    result = scorer.calculate_keyword_coverage(
        {"description": "AWS required; Rust preferred."},
        candidate_data,
        analysis=analysis,
    )
    assert result["total_required_terms"] == 1
    assert result["matched_terms"] == ["aws"]
    assert result["coverage_percentage"] == 100.0


def test_keyword_coverage_identifies_verified_skill_sources(candidate_data: dict) -> None:
    scorer = FitScorer()
    result = scorer.calculate_keyword_coverage(
        {"description": "Technical Product Management"},
        candidate_data,
        required_terms=["Technical Product Management"],
    )
    assert result["matched_terms"] == ["technical product management"]
    assert result["term_sources"]["technical product management"] == []
    assert result["skill_sources"]["technical product management"] == ["Technical Product Management"]


def test_score_repository_serializes_keyword_coverage_without_database() -> None:
    calls = []
    fetch_results = iter([
        {"status": "NEW"},
        {"keyword_coverage": {"coverage_percentage": 50.0}},
    ])

    class RecordingCursor:
        def __enter__(self) -> "RecordingCursor":
            return self

        def __exit__(self, *_args: Any) -> bool:
            return False

        def execute(self, query: str, params: Optional[tuple[Any, ...]] = None) -> None:
            calls.append((query, params))

        def fetchone(self) -> dict:
            return next(fetch_results)

    class RecordingConnection:
        def __enter__(self) -> "RecordingConnection":
            return self

        def __exit__(self, *_args: Any) -> bool:
            return False

        def cursor(self) -> RecordingCursor:
            return RecordingCursor()

        def commit(self) -> None:
            return None

    coverage = {
        "coverage_percentage": 50.0,
        "matched_terms": ["aws"],
        "unsupported_terms": ["rust"],
        "term_sources": {"aws": ["fact_001"]},
        "skill_sources": {"aws": ["AWS"]},
        "algorithm_version": "keyword_v1",
        "total_required_terms": 2,
        "supported_required_terms": 1,
    }
    repo = JobRepository("postgresql://unused")
    repo.get_connection = lambda: RecordingConnection()  # type: ignore[method-assign]
    repo.save_job_score("job-1", {
        "overall_score": 75.0,
        "recommendation": "review",
        "is_provisional": True,
        "keyword_coverage": coverage,
    })

    insert_query, insert_params = next(
        (query, params) for query, params in calls if "INSERT INTO job_scores" in query
    )
    assert "keyword_coverage" in insert_query
    assert json.loads(insert_params[15]) == coverage


# -------------------------------------------------------------
# 5. Idempotent Preparation Requests & Lifecycle
# -------------------------------------------------------------
def test_idempotent_preparation_requests(clean_db: JobRepository) -> None:
    job_id = create_test_job(clean_db)
    idemp_key = f"idemp_{uuid4().hex}"

    req1, is_new1 = clean_db.create_preparation_request(
        job_id=job_id,
        idempotency_key=idemp_key,
        requested_by="test_actor",
        briefing_id=None
    )
    assert is_new1 is True
    assert req1["status"] == "QUEUED"
    assert str(req1["job_id"]) == str(job_id)
    assert req1["idempotency_key"] == idemp_key

    # Re-request with identical (job_id, idempotency_key)
    req2, is_new2 = clean_db.create_preparation_request(
        job_id=job_id,
        idempotency_key=idemp_key,
        requested_by="different_actor"
    )
    assert is_new2 is False
    assert req2["id"] == req1["id"]
    assert req2["status"] == "QUEUED"


def test_preparation_request_status_transitions(clean_db: JobRepository) -> None:
    job_id = create_test_job(clean_db)
    idemp_key = f"idemp_{uuid4().hex}"

    req, _ = clean_db.create_preparation_request(job_id=job_id, idempotency_key=idemp_key)
    req_id = str(req["id"])

    # Valid transitions: QUEUED -> ANALYZING -> TAILORING -> READY_FOR_REVIEW
    updated = clean_db.update_preparation_request_status(req_id, "ANALYZING")
    assert updated["status"] == "ANALYZING"

    updated = clean_db.update_preparation_request_status(
        req_id,
        "BLOCKED",
        error_summary="Awaiting user action",
    )
    assert updated["status"] == "BLOCKED"
    assert updated["error_summary"] == "Awaiting user action"

    updated = clean_db.update_preparation_request_status(req_id, "ANALYZING")
    assert updated["status"] == "ANALYZING"
    assert updated["error_summary"] is None

    updated = clean_db.update_preparation_request_status(req_id, "TAILORING")
    assert updated["status"] == "TAILORING"

    updated = clean_db.update_preparation_request_status(req_id, "READY_FOR_REVIEW")
    assert updated["status"] == "READY_FOR_REVIEW"

    with pytest.raises(ValueError, match="Illegal preparation request transition"):
        clean_db.update_preparation_request_status(req_id, "BLOCKED")

    with pytest.raises(ValueError, match="Invalid preparation request status"):
        clean_db.update_preparation_request_status(req_id, "INVALID_STATUS")


def test_preparation_request_transition_contract_without_database() -> None:
    assert validate_preparation_request_transition("QUEUED", "ANALYZING") == PreparationRequestStatus.ANALYZING
    assert validate_preparation_request_transition("BLOCKED", "ANALYZING") == PreparationRequestStatus.ANALYZING
    with pytest.raises(ValueError, match="Illegal preparation request transition"):
        validate_preparation_request_transition("READY_FOR_REVIEW", "BLOCKED")


def test_preparation_request_model_accepts_database_uuids() -> None:
    request_id = uuid4()
    job_id = uuid4()
    model = PreparationRequestModel(
        id=request_id,
        job_id=job_id,
        requested_by="antigravity",
        idempotency_key="prepare-1",
    )
    dumped = model.model_dump()
    assert dumped["id"] == str(request_id)
    assert dumped["job_id"] == str(job_id)


def test_preparation_request_rejects_blank_idempotency_before_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = JobRepository("postgresql://unused")

    def fail_if_called() -> None:
        pytest.fail("invalid idempotency keys must fail before database access")

    monkeypatch.setattr(repo, "get_connection", fail_if_called)
    with pytest.raises(ValueError, match="idempotency_key"):
        repo.create_preparation_request(str(uuid4()), "   ")


def test_mcp_preparation_tools(clean_db: JobRepository, monkeypatch: pytest.MonkeyPatch) -> None:
    import services.mcp.server as server_mod
    monkeypatch.setattr(server_mod, "repo", clean_db)

    job_id = create_test_job(clean_db)
    idemp_key = f"mcp_idemp_{uuid4().hex}"

    resp_str = server_mod.create_preparation_request(job_id=job_id, idempotency_key=idemp_key)
    resp = json.loads(resp_str)
    assert resp["status"] == "success"
    assert resp["is_new"] is True
    request_id = resp["request_id"]

    # Check status tool
    status_str = server_mod.get_preparation_status(request_id=request_id)
    status_resp = json.loads(status_str)
    assert status_resp["status"] == "success"
    assert str(status_resp["preparation_request"]["id"]) == str(request_id)
    assert status_resp["preparation_request"]["status"] == "QUEUED"
