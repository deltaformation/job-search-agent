from typing import Any, Dict, List, Optional, Tuple

from services.applications.readiness import ApplicationPackage
from services.memory.repository import JobRepository
from scripts.show_job_context import build_job_context


class FakeRepository:
    """Minimal repository double proving the diagnostic stays on public APIs."""

    def get_job_by_id(self, job_id: str) -> Dict[str, Any]:
        return {
            "job_id": job_id,
            "title": "Product Manager",
            "company": "Example",
            "status": "READY",
            "assessment_status": "ANALYZED",
            "overall_score": 91,
            "description": "must not leak into the bounded report",
        }

    def get_job_analysis(self, job_id: str) -> Dict[str, Any]:
        return {"id": "analysis-1", "version_number": 2, "notes": "Observed notes"}

    def get_latest_resume_for_job(self, job_id: str) -> Dict[str, Any]:
        return {
            "id": "resume-1",
            "version_number": 3,
            "validation_status": "APPROVED",
            "approved_by_human": True,
            "content_hash": "abc",
            "diff_summary": "Focused revision",
            "tailored_text": "must not be printed",
        }

    def get_application_by_job_id(self, job_id: str) -> Dict[str, Any]:
        return {"id": "application-1", "status": "READY_FOR_HUMAN_REVIEW", "notes": "private"}

    def get_latest_attempt(self, application_id: str) -> Dict[str, Any]:
        return {"id": "attempt-1", "attempt_number": 1, "status": "CHECKPOINTED"}

    def get_job_requirements(self, job_id: str) -> List[Dict[str, Any]]:
        return [
            {"match_status": "supported"},
            {"match_status": "supported"},
            {"match_status": "gap"},
        ]


def ready_stub(
    repo: JobRepository, job_id: str
) -> Tuple[bool, Optional[ApplicationPackage], List[str]]:
    return True, None, []


def test_build_job_context_uses_bounded_domain_fields() -> None:
    context = build_job_context(FakeRepository(), "job-1", readiness_checker=ready_stub)  # type: ignore[arg-type]

    assert context["status"] == "ok"
    assert context["read_only"] is True
    assert context["analysis"]["notes"] == {"present": True, "character_count": 14}
    assert context["resume"]["diff_summary"] == {"present": True, "character_count": 16}
    assert context["requirements"] == {
        "count": 3,
        "by_match_status": {"gap": 1, "supported": 2},
    }
    assert "description" not in context["job"]
    assert "tailored_text" not in context["resume"]
    assert "notes" not in context["application"]


class MissingJobRepository(FakeRepository):
    def get_job_by_id(self, job_id: str) -> None:
        return None


def test_build_job_context_returns_clean_not_found_result() -> None:
    context = build_job_context(
        MissingJobRepository(),  # type: ignore[arg-type]
        "missing-job",
        readiness_checker=ready_stub,
    )

    assert context == {"status": "not_found", "job_id": "missing-job", "read_only": True}
