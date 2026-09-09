import hashlib
import json
from pathlib import Path
from typing import Tuple, List, Dict, Optional, Any
from uuid import uuid4
from bs4 import BeautifulSoup
import pytest

from services.memory.repository import JobRepository
from services.applications.readiness import (
    is_safe_apply_url, check_application_readiness, ApplicationPackage
)
from services.applications.policy import (
    FieldRiskClass, FieldDecision, classify_field,
    is_decision_allowed, reconcile_risk
)
from services.applications.validator import FieldPlanValidator
from services.applications.service import ApplicationCopilotService
from services.documents.renderer import DocumentRenderer, ARTIFACTS_DIR
from services.documents.pipeline import generate_documents

class FakePdfRenderer:
    """Creates real deterministic PDF artifacts for test validation."""
    def __init__(self, root: Path):
        self.artifacts_dir = root / "resumes"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)

    def render_and_compile(self, job_id, version_number, content_hash, html_content):
        job_dir = self.artifacts_dir / str(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        stem = f"v{version_number}_{content_hash[:8]}"
        html_path = job_dir / f"{stem}.html"
        pdf_path = job_dir / f"{stem}.pdf"
        html_path.write_text(html_content, encoding="utf-8")
        pdf_path.write_bytes(b"%PDF-1.4 test synthetic pdf content")
        return str(html_path), str(pdf_path), 1

def create_ready_job_with_approved_resume(repo: JobRepository, monkeypatch) -> Tuple[str, str, str]:
    """Helper that creates a job, moves it through pipeline, and generates an approved resume."""
    key = uuid4().hex
    canonical_url = f"https://boards.greenhouse.io/testcompany/jobs/{key}"
    job, _ = repo.upsert_job({
        "canonical_url": canonical_url,
        "apply_url": canonical_url,
        "content_hash": key,
        "company": f"TestCorp_{key[:6]}",
        "title": "Senior Technical Product Manager",
        "normalized_title": "Senior Technical Product Manager",
        "location": "Toronto, ON, Canada",
        "description": "Building cloud APIs with AWS and Kafka.",
        "status": "NEW"
    }, {"source_name": "greenhouse", "source_url": canonical_url})
    job_id = str(job["job_id"])

    profile = repo.get_candidate_profile()
    assert profile is not None
    candidate_snapshot_id = repo.save_candidate_snapshot(str(profile["id"]), profile)
    jd_snapshot_id = repo.save_jd_snapshot(
        job_id, job["description"], job["description"]
    )
    repo.save_job_analysis(
        job_id,
        jd_snapshot_id,
        candidate_snapshot_id,
        [],
        notes="Synthetic application-copilot fixture",
    )

    # Generate document
    doc_result = generate_documents(repo, job_id, renderer=DocumentRenderer())
    resume_id = doc_result["resume_version_id"]
    content_hash = doc_result["content_hash"]

    # Approve resume
    ok, _ = repo.confirm_human_approval(resume_id, content_hash, reviewer="human_tester", human_confirmed=True)
    assert ok is True

    # Transition job to READY via REVIEWED
    repo.transition_job_workflow(job_id, "REVIEWED")
    ok, err = repo.transition_job_workflow(job_id, "READY")
    assert ok is True, f"Failed transition to READY: {err}"

    return job_id, resume_id, doc_result["pdf_path"]

def test_safe_apply_url_validation():
    # Valid HTTPS endpoints
    ok, _ = is_safe_apply_url("https://boards.greenhouse.io/company/jobs/12345")
    assert ok is True
    ok, _ = is_safe_apply_url("https://jobs.lever.co/company/abc-def")
    assert ok is True

    # Invalid schemes
    ok, err = is_safe_apply_url("http://insecure.com/jobs/1")
    assert ok is False
    assert "scheme must be HTTPS" in err

    ok, err = is_safe_apply_url("file:///etc/passwd")
    assert ok is False

    ok, err = is_safe_apply_url("javascript:alert(1)")
    assert ok is False

    # Embedded credentials
    ok, err = is_safe_apply_url("https://user:pass@company.com/apply")
    assert ok is False
    assert "embedded credentials" in err

    # Localhost and loopback
    ok, err = is_safe_apply_url("https://localhost:8080/apply")
    assert ok is False
    assert "Prohibited local/loopback" in err

    ok, err = is_safe_apply_url("https://127.0.0.1/apply")
    assert ok is False

    # Private IP ranges
    ok, err = is_safe_apply_url("https://192.168.1.50/apply")
    assert ok is False
    assert "private or reserved IP" in err

    ok, err = is_safe_apply_url("https://10.0.0.1/apply")
    assert ok is False


def test_application_service_rejects_malformed_identifiers_without_database_access() -> None:
    service = ApplicationCopilotService(repo=object())

    assert service.prepare_application("not-a-uuid")["status"] == "error"
    assert service.get_application_context("bad", "also-bad")["status"] == "error"
    assert service.record_form_snapshot("bad", "https://example.com", "0" * 64, [])["status"] == "error"
    assert service.get_application_status("bad")["status"] == "error"

def test_application_readiness_validation(clean_db: JobRepository, monkeypatch):
    repo = clean_db

    # 1. Non-existent job
    ok, _, blockers = check_application_readiness(repo, str(uuid4()))
    assert ok is False
    assert any("not found" in b for b in blockers)

    # 2. Job in NEW status (not READY)
    key = uuid4().hex
    job, _ = repo.upsert_job({
        "canonical_url": f"https://example.com/j_{key}",
        "content_hash": key,
        "company": "New Corp",
        "title": "PM",
        "location": "Toronto",
        "description": "Desc",
        "status": "NEW"
    }, {})
    job_id = str(job["job_id"])
    ok, _, blockers = check_application_readiness(repo, job_id)
    assert ok is False
    assert any("expected 'READY'" in b for b in blockers)

    # 3. Create ready job with approved resume
    ready_job_id, resume_id, pdf_path = create_ready_job_with_approved_resume(repo, monkeypatch)

    ok, package, blockers = check_application_readiness(repo, ready_job_id)
    assert ok is True
    assert package is not None
    assert package.job_id == ready_job_id
    assert package.resume_version_id == resume_id
    assert Path(package.pdf_path).exists()

    # 4. Tampered PDF digest blocks readiness
    pdf = Path(pdf_path)
    original_pdf_bytes = pdf.read_bytes()
    try:
        pdf.write_bytes(b"%PDF-1.4 tampered bytes")
        ok, _, blockers = check_application_readiness(repo, ready_job_id)
        assert ok is False
        assert any("digest mismatch" in b for b in blockers)
    finally:
        pdf.write_bytes(original_pdf_bytes)

    # Restored PDF passes again
    ok, _, _ = check_application_readiness(repo, ready_job_id)
    assert ok is True

def test_field_risk_classifier():
    # Safe fields
    assert classify_field("First Name")[0] == FieldRiskClass.SAFE
    assert classify_field("Last Name")[0] == FieldRiskClass.SAFE
    assert classify_field("Email Address")[0] == FieldRiskClass.SAFE
    assert classify_field("Phone")[0] == FieldRiskClass.SAFE
    assert classify_field("Location (City)")[0] == FieldRiskClass.SAFE
    assert classify_field("LinkedIn Profile")[0] == FieldRiskClass.SAFE
    assert classify_field("GitHub URL")[0] == FieldRiskClass.SAFE
    assert classify_field("Attach Resume", control_type="file")[0] == FieldRiskClass.SAFE

    # Human Review fields
    assert classify_field("Are you legally authorized to work in Canada?")[0] == FieldRiskClass.HUMAN_REVIEW
    assert classify_field("Will you require visa sponsorship?")[0] == FieldRiskClass.HUMAN_REVIEW
    assert classify_field("Desired Salary Expectations")[0] == FieldRiskClass.HUMAN_REVIEW
    assert classify_field("Earliest start date")[0] == FieldRiskClass.HUMAN_REVIEW
    assert classify_field("Why are you interested in joining us?")[0] == FieldRiskClass.HUMAN_REVIEW

    # Prohibited fields
    assert classify_field("Gender Identity")[0] == FieldRiskClass.PROHIBITED
    assert classify_field("Race / Ethnicity")[0] == FieldRiskClass.PROHIBITED
    assert classify_field("Veteran Status")[0] == FieldRiskClass.PROHIBITED
    assert classify_field("I certify and attest under penalty of perjury")[0] == FieldRiskClass.PROHIBITED
    assert classify_field("Submit Application")[0] == FieldRiskClass.PROHIBITED
    assert classify_field("Enter your password")[0] == FieldRiskClass.PROHIBITED

    # Unknown fields
    assert classify_field("Favorite Sci-Fi Movie")[0] == FieldRiskClass.UNKNOWN

    # Invariant: Escalation allowed, downgrade prohibited
    final_risk, valid = reconcile_risk(FieldRiskClass.SAFE, FieldRiskClass.HUMAN_REVIEW)
    assert valid is True
    assert final_risk == FieldRiskClass.HUMAN_REVIEW

    final_risk, valid = reconcile_risk(FieldRiskClass.PROHIBITED, FieldRiskClass.SAFE)
    assert valid is False
    assert final_risk == FieldRiskClass.PROHIBITED

    final_risk, valid = reconcile_risk(FieldRiskClass.HUMAN_REVIEW, FieldRiskClass.SAFE)
    assert valid is False
    assert final_risk == FieldRiskClass.HUMAN_REVIEW

def test_field_plan_validator(candidate_data):
    job_id = str(uuid4())
    fake_pdf = "/tmp/test_resume.pdf"
    Path(fake_pdf).write_bytes(b"%PDF-1.4 mock")

    package = ApplicationPackage(
        job_id=job_id,
        application_url="https://example.com/apply",
        ats_type="greenhouse",
        resume_version_id=str(uuid4()),
        version_number=1,
        content_hash="a" * 64,
        pdf_path=fake_pdf,
        pdf_hash=hashlib.sha256(Path(fake_pdf).read_bytes()).hexdigest(),
        candidate_profile=candidate_data,
        candidate_snapshot_id=str(uuid4()),
        jd_snapshot_id=str(uuid4()),
        analysis_id=None
    )

    validator = FieldPlanValidator(candidate_data, package)
    snapshot = {
        "id": "snap_001",
        "fields_metadata": [
            {"field_key": "f_first", "label": "First Name", "control_type": "text", "name": "first_name"},
            {"field_key": "f_email", "label": "Email", "control_type": "text", "name": "email"},
            {"field_key": "f_work_auth", "label": "Are you authorized to work in Canada?", "control_type": "select", "name": "work_auth"},
            {"field_key": "f_resume", "label": "Attach Resume", "control_type": "file", "name": "resume"},
            {"field_key": "f_gender", "label": "Gender Identity", "control_type": "select", "name": "gender"},
        ],
    }

    # 1. Valid plan with truthful safe fields
    valid_plan = {
        "form_snapshot_id": "snap_001",
        "fields": [
            {
                "field_key": "f_first",
                "label": "First Name",
                "control_type": "text",
                "risk_class": "safe",
                "proposed_value": "Mouad",
                "source_type": "candidate_profile",
                "decision": "fill"
            },
            {
                "field_key": "f_email",
                "label": "Email",
                "control_type": "text",
                "risk_class": "safe",
                "proposed_value": "mouad@example.com",
                "source_type": "candidate_profile",
                "decision": "fill"
            },
            {
                "field_key": "f_work_auth",
                "label": "Are you authorized to work in Canada?",
                "control_type": "select",
                "risk_class": "human_review",
                "decision": "ask_human"
            },
            {
                "field_key": "f_resume",
                "label": "Attach Resume",
                "control_type": "file",
                "risk_class": "safe",
                "proposed_value": fake_pdf,
                "source_type": "resume_artifact",
                "decision": "upload"
            }
        ]
    }

    is_valid, allowed, blocked, errors = validator.validate_plan(valid_plan, snapshot)
    assert is_valid is True
    assert len(errors) == 0
    assert len(allowed) == 3 # first name, email, upload
    assert len(blocked) == 1 # work auth

    # 2. Untruthful email rejected
    bad_plan_untruthful = {
        "form_snapshot_id": "snap_001",
        "fields": [
            {
                "field_key": "f_email",
                "label": "Email",
                "control_type": "text",
                "risk_class": "safe",
                "proposed_value": "invented_hacker@evil.com",
                "source_type": "candidate_profile",
                "decision": "fill"
            }
        ]
    }
    is_valid, allowed, blocked, errors = validator.validate_plan(bad_plan_untruthful, snapshot)
    assert is_valid is False
    assert any("does not match canonical" in e for e in errors)

    # 3. Policy violation: Attempting to fill a prohibited field
    bad_plan_prohibited = {
        "form_snapshot_id": "snap_001",
        "fields": [
            {
                "field_key": "f_gender",
                "label": "Gender Identity",
                "control_type": "select",
                "risk_class": "safe", # Downgraded!
                "proposed_value": "Male",
                "decision": "fill"
            }
        ]
    }
    is_valid, allowed, blocked, errors = validator.validate_plan(bad_plan_prohibited, snapshot)
    assert is_valid is False
    assert any("cannot downgrade risk" in e for e in errors)

def test_application_copilot_service_lifecycle(clean_db: JobRepository, monkeypatch):
    repo = clean_db
    ready_job_id, resume_id, pdf_path = create_ready_job_with_approved_resume(repo, monkeypatch)
    service = ApplicationCopilotService(repo=repo)

    # 1. Prepare Application
    prep_res = service.prepare_application(ready_job_id, idempotency_key="attempt_k1")
    assert prep_res["status"] == "ready"
    app_id = prep_res["application_id"]
    attempt_id = prep_res["attempt_id"]
    assert prep_res["is_new_application"] is True
    assert prep_res["is_new_attempt"] is True

    # Idempotent re-preparation
    prep_res_2 = service.prepare_application(ready_job_id, idempotency_key="attempt_k1")
    assert prep_res_2["status"] == "ready"
    assert prep_res_2["is_new_attempt"] is False
    assert prep_res_2["attempt_id"] == attempt_id

    # 2. Get Scoped Context
    ctx = service.get_application_context(app_id, attempt_id)
    assert ctx["status"] == "success"
    assert ctx["candidate_safe_fields"]["full_name"] == "Mouad Atfi"
    assert ctx["resume_artifact"]["pdf_path"] == pdf_path

    # 3. Record Form Snapshot
    snap_res = service.record_form_snapshot(
        attempt_id=attempt_id,
        page_url="https://boards.greenhouse.io/test/apply",
        form_fingerprint=hashlib.sha256(b"lifecycle-form-v1").hexdigest(),
        fields_metadata=[
            {"field_key": "f1", "label": "First Name", "control_type": "text", "name": "first_name"},
            {"field_key": "f2", "label": "Work Authorization", "control_type": "select", "name": "work_auth"}
        ]
    )
    assert snap_res["status"] == "success"
    snap_id = snap_res["form_snapshot_id"]

    # 4. Submit Field Plan
    plan_res = service.submit_field_plan(
        application_id=app_id,
        attempt_id=attempt_id,
        form_snapshot_id=snap_id,
        fields=[
            {"field_key": "f1", "label": "First Name", "control_type": "text", "risk_class": "safe", "proposed_value": "Mouad", "source_type": "candidate_profile", "decision": "fill"},
            {"field_key": "f2", "label": "Work Authorization", "control_type": "select", "risk_class": "human_review", "decision": "ask_human"}
        ]
    )
    assert plan_res["status"] == "validated", plan_res["errors"]
    assert plan_res["allowed_count"] == 1
    assert plan_res["blocked_count"] == 1

    # 5. Record Actions
    act_res = service.record_actions(
        attempt_id=attempt_id,
        form_snapshot_id=snap_id,
        actions=[
            {"field_key": "f1", "idempotency_key": "fill-f1-v1", "action_type": "FILL", "status": "SUCCESS", "value": "Mouad"}
        ]
    )
    assert act_res["status"] == "success"
    assert act_res["recorded_actions_count"] == 1

    repeated = service.record_actions(
        attempt_id=attempt_id,
        form_snapshot_id=snap_id,
        actions=[
            {"field_key": "f1", "idempotency_key": "fill-f1-v1", "action_type": "FILL", "status": "SUCCESS", "value": "Mouad"}
        ],
    )
    assert repeated["status"] == "success"
    assert repeated["recorded_actions_count"] == 0

    unplanned = service.record_actions(
        attempt_id=attempt_id,
        form_snapshot_id=snap_id,
        actions=[
            {"field_key": "f2", "idempotency_key": "unsafe-f2", "action_type": "SELECT", "status": "SUCCESS", "value": "Yes"}
        ],
    )
    assert unplanned["status"] == "error"
    assert "not approved" in unplanned["message"]

    # 6. Capture Pre-Submit Checkpoint
    chk_res = service.create_checkpoint(
        application_id=app_id,
        attempt_id=attempt_id,
        stage="pre_submit_review",
        page_url="https://boards.greenhouse.io/test/apply",
        blockers=["Work authorization requires selection by applicant"],
        next_action="human_review",
        human_checklist=[
            {"field": "Work Authorization", "action": "Select eligibility in browser"}
        ]
    )
    assert chk_res["status"] == "checkpointed"
    assert chk_res["has_blockers"] is True

    # Check application status
    status_res = service.get_application_status(app_id)
    assert status_res["status"] == "success"
    assert status_res["application"]["status"] == "NEEDS_HUMAN_INPUT"

def test_human_submission_recording(clean_db: JobRepository, monkeypatch):
    repo = clean_db
    ready_job_id, resume_id, pdf_path = create_ready_job_with_approved_resume(repo, monkeypatch)
    service = ApplicationCopilotService(repo=repo)

    prep_res = service.prepare_application(ready_job_id)
    app_id = prep_res["application_id"]
    attempt_id = prep_res["attempt_id"]

    # 1. Direct call without human_confirmed=True is rejected
    ok, err = repo.record_human_submission(app_id, reviewer="agent", human_confirmed=False)
    assert ok is False
    assert "Explicit human confirmation" in err

    checkpoint = service.create_checkpoint(
        application_id=app_id,
        attempt_id=attempt_id,
        stage="pre_submit_review",
        page_url=prep_res["application_url"],
        blockers=[],
        next_action="human_takeover",
        human_checklist=[],
    )
    assert checkpoint["status"] == "checkpointed"

    # 2. Valid human confirmation
    ok, msg = repo.record_human_submission(
        application_id=app_id,
        reviewer="mouad_human",
        notes="Personally submitted in Chrome",
        reference_number="GH-109283",
        human_confirmed=True
    )
    assert ok is True

    app = repo.get_application_by_id(app_id)
    assert app["status"] == "SUBMITTED_CONFIRMED"
    assert app["applied_at"] is not None

    job = repo.get_job_by_id(ready_job_id)
    assert job["status"] == "SUBMITTED"

def test_synthetic_greenhouse_fixture_parsing(clean_db: JobRepository, monkeypatch):
    repo = clean_db
    ready_job_id, resume_id, pdf_path = create_ready_job_with_approved_resume(repo, monkeypatch)
    service = ApplicationCopilotService(repo=repo)
    prep_res = service.prepare_application(ready_job_id)
    app_id = prep_res["application_id"]
    attempt_id = prep_res["attempt_id"]

    fixture_path = Path(__file__).parent / "fixtures" / "ats" / "greenhouse_sample.html"
    html_content = fixture_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(html_content, "html.parser")

    # Extract fields
    fields_meta = []
    for div in soup.find_all("div", class_="field"):
        label_elem = div.find("label")
        if not label_elem:
            continue
        label = label_elem.get_text(strip=True).replace("*", "").strip()
        inp = div.find(["input", "select", "textarea"])
        if not inp:
            continue
        ctl_type = inp.get("type", inp.name)
        key_by_name = {
            "first_name": "k_first",
            "last_name": "k_last",
            "email": "k_email",
            "phone": "k_phone",
            "location": "k_location",
            "resume": "k_resume",
            "custom_work_authorization": "k_auth",
            "custom_sponsorship": "k_sponsorship",
            "eeo_gender": "k_gender",
        }
        fields_meta.append({
            "field_key": key_by_name.get(inp.get("name"), f"captured_{len(fields_meta)}"),
            "label": label,
            "control_type": ctl_type,
            "name": inp.get("name"),
            "options": [option.get_text(strip=True) for option in inp.find_all("option")],
            "required": inp.has_attr("required"),
        })

    snap_res = service.record_form_snapshot(
        attempt_id=attempt_id,
        page_url="https://boards.greenhouse.io/sample",
        form_fingerprint=hashlib.sha256(html_content.encode("utf-8")).hexdigest(),
        fields_metadata=fields_meta
    )
    assert snap_res["status"] == "success"

    # Build plan
    plan_fields = [
        {"field_key": "k_first", "label": "First Name", "control_type": "text", "risk_class": "safe", "proposed_value": "Mouad", "source_type": "candidate_profile", "decision": "fill"},
        {"field_key": "k_last", "label": "Last Name", "control_type": "text", "risk_class": "safe", "proposed_value": "Atfi", "source_type": "candidate_profile", "decision": "fill"},
        {"field_key": "k_email", "label": "Email", "control_type": "email", "risk_class": "safe", "proposed_value": "mouad.atfi@example.com", "source_type": "candidate_profile", "decision": "fill"},
        {"field_key": "k_phone", "label": "Phone", "control_type": "tel", "risk_class": "safe", "proposed_value": "+1-647-000-0000", "source_type": "candidate_profile", "decision": "fill"},
        {"field_key": "k_location", "label": "Location (City, Province/State)", "control_type": "text", "risk_class": "safe", "proposed_value": "Toronto, ON, Canada", "source_type": "candidate_profile", "decision": "fill"},
        {"field_key": "k_resume", "label": "Resume/CV (PDF, DOCX)", "control_type": "file", "risk_class": "safe", "proposed_value": pdf_path, "source_type": "resume_artifact", "decision": "upload"},
        {"field_key": "k_auth", "label": "Are you legally authorized to work in Canada?", "control_type": "select", "risk_class": "human_review", "decision": "ask_human"},
        {"field_key": "k_sponsorship", "label": "Will you now or in the future require visa sponsorship?", "control_type": "select", "risk_class": "human_review", "decision": "ask_human"},
        {"field_key": "k_gender", "label": "Gender Identity", "control_type": "select", "risk_class": "prohibited", "decision": "leave_blank"}
    ]

    plan_res = service.submit_field_plan(
        application_id=app_id,
        attempt_id=attempt_id,
        form_snapshot_id=snap_res["form_snapshot_id"],
        fields=plan_fields
    )
    assert plan_res["status"] == "validated", plan_res["errors"]
    assert plan_res["allowed_count"] == 6 # 5 contact fields + 1 upload
    assert plan_res["blocked_count"] == 3 # two eligibility fields and one demographic field

def test_synthetic_lever_fixture_parsing(clean_db: JobRepository, monkeypatch):
    fixture_path = Path(__file__).parent / "fixtures" / "ats" / "lever_sample.html"
    html_content = fixture_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(html_content, "html.parser")

    # Verify input classifications
    assert classify_field("Full name")[0] == FieldRiskClass.SAFE
    assert classify_field("Resume/CV", control_type="file")[0] == FieldRiskClass.SAFE
    assert classify_field("Are you legally eligible to work in Canada without sponsorship?")[0] == FieldRiskClass.HUMAN_REVIEW
    assert classify_field("What is your expected annual compensation (CAD)?")[0] == FieldRiskClass.HUMAN_REVIEW
    assert classify_field("Voluntary Self-Identification: Gender")[0] == FieldRiskClass.PROHIBITED
    assert classify_field("Submit application")[0] == FieldRiskClass.PROHIBITED

def test_synthetic_generic_fixture_parsing():
    fixture_path = Path(__file__).parent / "fixtures" / "ats" / "generic_sample.html"
    html_content = fixture_path.read_text(encoding="utf-8")
    soup = BeautifulSoup(html_content, "html.parser")

    # Unfamiliar inputs must default safely to UNKNOWN / HUMAN_REVIEW
    risk, _ = classify_field("Select Preferred Evaluation Tier", control_type="radio")
    assert risk == FieldRiskClass.UNKNOWN
    # UNKNOWN fields cannot be auto-filled
    assert is_decision_allowed(risk, FieldDecision.FILL) is False
    assert is_decision_allowed(risk, FieldDecision.ASK_HUMAN) is True


def test_cross_application_and_stale_snapshot_rejected(clean_db: JobRepository, monkeypatch):
    service = ApplicationCopilotService(repo=clean_db)
    first_job, _, _ = create_ready_job_with_approved_resume(clean_db, monkeypatch)
    second_job, _, _ = create_ready_job_with_approved_resume(clean_db, monkeypatch)
    first = service.prepare_application(first_job, idempotency_key="first-attempt")
    second = service.prepare_application(second_job, idempotency_key="second-attempt")

    context = service.get_application_context(second["application_id"], first["attempt_id"])
    assert context["status"] == "error"
    assert "does not belong" in context["message"]

    metadata = [{
        "field_key": "email",
        "label": "Email",
        "control_type": "email",
        "name": "email",
        "required": True,
    }]
    old_snapshot = service.record_form_snapshot(
        first["attempt_id"],
        first["application_url"],
        hashlib.sha256(b"old-form").hexdigest(),
        metadata,
    )
    service.record_form_snapshot(
        first["attempt_id"],
        first["application_url"],
        hashlib.sha256(b"new-form").hexdigest(),
        metadata,
    )
    stale = service.submit_field_plan(
        first["application_id"],
        first["attempt_id"],
        old_snapshot["form_snapshot_id"],
        [{
            "field_key": "email",
            "label": "Email",
            "control_type": "email",
            "risk_class": "safe",
            "proposed_value": "mouad.atfi@example.com",
            "source_type": "candidate_profile",
            "decision": "fill",
        }],
    )
    assert stale["status"] == "error"
    assert "stale" in stale["message"]


def test_snapshot_and_resume_binding_validation(clean_db: JobRepository, monkeypatch):
    service = ApplicationCopilotService(repo=clean_db)
    job_id, _, _ = create_ready_job_with_approved_resume(clean_db, monkeypatch)
    prepared = service.prepare_application(job_id, idempotency_key="binding-attempt")

    unsafe = service.record_form_snapshot(
        prepared["attempt_id"],
        "https://evil.invalid/application",
        hashlib.sha256(b"unsafe-form").hexdigest(),
        [],
    )
    assert unsafe["status"] == "error"
    assert "Unexpected application redirect" in unsafe["message"]

    invalid_fingerprint = service.record_form_snapshot(
        prepared["attempt_id"],
        prepared["application_url"],
        "not-a-sha256",
        [],
    )
    assert invalid_fingerprint["status"] == "error"

    current_analysis = clean_db.get_job_analysis(job_id)
    assert current_analysis is not None
    clean_db.save_job_analysis(
        job_id,
        str(current_analysis["jd_snapshot_id"]),
        str(current_analysis["candidate_snapshot_id"]),
        current_analysis["requirements"],
        notes="Superseding analysis version",
    )
    stale_binding = service.get_application_context(
        prepared["application_id"], prepared["attempt_id"]
    )
    assert stale_binding["status"] == "blocked"
    assert any("analysis changed" in blocker for blocker in stale_binding["blockers"])
