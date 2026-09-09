import argparse
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from scripts import load_candidate_profile, review_resume


def test_valid_uuid_rejects_invalid_database_identifier() -> None:
    with pytest.raises(argparse.ArgumentTypeError, match="valid UUID"):
        review_resume.valid_uuid("not-a-uuid")


def test_advance_job_to_ready_checks_each_transition() -> None:
    repo = MagicMock()
    repo.transition_job_workflow.side_effect = [(True, "reviewed"), (True, "ready")]
    job_id = str(uuid4())

    ok, is_ready, message = review_resume.advance_job_to_ready(
        repo, job_id, "NEW", "Test Reviewer"
    )

    assert ok is True
    assert is_ready is True
    assert message == "ready"
    assert [call.args[1] for call in repo.transition_job_workflow.call_args_list] == [
        "REVIEWED",
        "READY",
    ]


def test_advance_job_to_ready_reports_failed_intermediate_transition() -> None:
    repo = MagicMock()
    repo.transition_job_workflow.return_value = (False, "database rejected transition")

    ok, is_ready, message = review_resume.advance_job_to_ready(
        repo, str(uuid4()), "SHORTLISTED", "Test Reviewer"
    )

    assert ok is False
    assert is_ready is False
    assert "database rejected transition" in message
    assert repo.transition_job_workflow.call_count == 1


def test_advance_job_to_ready_does_not_rewind_application() -> None:
    repo = MagicMock()

    ok, is_ready, message = review_resume.advance_job_to_ready(
        repo, str(uuid4()), "SUBMITTED", "Test Reviewer"
    )

    assert ok is True
    assert is_ready is False
    assert "remains in 'SUBMITTED'" in message
    repo.transition_job_workflow.assert_not_called()


def test_review_rejects_unvalidated_resume_before_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    resume_id = str(uuid4())
    job_id = str(uuid4())
    repo = MagicMock()
    repo.get_resume_version.return_value = {
        "id": resume_id,
        "job_id": job_id,
        "validation_status": "FAILED",
        "approved_by_human": False,
        "tailored_text": "Observed resume text",
        "content_hash": "abc",
        "pdf_path": "/tmp/resume.pdf",
        "version_number": 1,
    }
    repo.get_job_by_id.return_value = {
        "job_id": job_id,
        "title": "Product Manager",
        "company": "Example",
        "status": "TAILORING",
    }
    repo.get_candidate_profile.return_value = {"full_name": "Test Reviewer"}
    prompt = MagicMock()
    monkeypatch.setattr(review_resume, "JobRepository", lambda: repo)
    monkeypatch.setattr(review_resume.sys, "stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("builtins.input", prompt)

    result = review_resume.main(["--resume-id", resume_id])

    assert result == 1
    prompt.assert_not_called()
    repo.confirm_human_approval.assert_not_called()


def test_review_resumes_ready_transition_after_prior_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resume_id = str(uuid4())
    job_id = str(uuid4())
    repo = MagicMock()
    repo.get_resume_version.return_value = {
        "id": resume_id,
        "job_id": job_id,
        "validation_status": "APPROVED",
        "approved_by_human": True,
        "human_reviewer": "Test Reviewer",
        "tailored_text": "Observed resume text",
        "content_hash": "abc",
        "pdf_path": "/tmp/resume.pdf",
        "version_number": 1,
    }
    repo.get_job_by_id.return_value = {
        "job_id": job_id,
        "title": "Product Manager",
        "company": "Example",
        "status": "REVIEWED",
    }
    repo.transition_job_workflow.return_value = (True, "ready")
    monkeypatch.setattr(review_resume, "JobRepository", lambda: repo)
    monkeypatch.setattr(review_resume.sys, "stdin", SimpleNamespace(isatty=lambda: True))

    result = review_resume.main(["--resume-id", resume_id])

    assert result == 0
    repo.confirm_human_approval.assert_not_called()
    repo.transition_job_workflow.assert_called_once()
    assert repo.transition_job_workflow.call_args.args[1] == "READY"


def test_profile_replacement_requires_interactive_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    loader = MagicMock()
    monkeypatch.setattr(load_candidate_profile, "load_profile", loader)
    monkeypatch.setattr(
        load_candidate_profile.sys,
        "stdin",
        SimpleNamespace(isatty=lambda: False),
    )

    with pytest.raises(SystemExit) as exc_info:
        load_candidate_profile.main(["--confirm-replace"])

    assert exc_info.value.code == 2
    loader.assert_not_called()
