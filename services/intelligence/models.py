"""Canonical data models for intelligence, evidence contracts, and preparation requests."""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Set
from uuid import UUID
from pydantic import BaseModel, Field, field_validator, model_validator


class RequirementCategory(str, Enum):
    EXPERIENCE = "experience"
    SKILL = "skill"
    RESPONSIBILITY = "responsibility"
    DOMAIN = "domain"
    LOCATION = "location"
    COMPENSATION = "compensation"
    SCREENING = "screening"
    OTHER = "other"


class RequirementImportance(str, Enum):
    REQUIRED = "required"
    PREFERRED = "preferred"
    UNSPECIFIED = "unspecified"


class RequirementMatchStatus(str, Enum):
    MATCHED = "matched"
    PARTIAL = "partial"
    UNSUPPORTED = "unsupported"
    GAP = "gap"


class RequirementReviewStatus(str, Enum):
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"


class CanonicalRequirement(BaseModel):
    requirement_id: str
    jd_quote: str
    description: str = ""
    category: RequirementCategory = RequirementCategory.EXPERIENCE
    importance: RequirementImportance = RequirementImportance.REQUIRED
    match_status: RequirementMatchStatus = RequirementMatchStatus.UNSUPPORTED
    evidence_fact_ids: List[str] = Field(default_factory=list)
    evidence_quotes: List[str] = Field(default_factory=list)
    review_status: RequirementReviewStatus = RequirementReviewStatus.PROPOSED
    analysis_notes: Optional[str] = None

    @field_validator("evidence_fact_ids")
    @classmethod
    def validate_evidence_fact_ids(cls, values: List[str]) -> List[str]:
        if any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError("evidence_fact_ids must contain only nonempty strings.")
        if len(values) != len(set(values)):
            raise ValueError("evidence_fact_ids must not contain duplicates.")
        return values

    @field_validator("evidence_quotes")
    @classmethod
    def validate_evidence_quotes(cls, values: List[str]) -> List[str]:
        if any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError("evidence_quotes must contain only nonempty strings.")
        if len(values) != len(set(values)):
            raise ValueError("evidence_quotes must not contain duplicates.")
        return values

    @model_validator(mode="before")
    @classmethod
    def translate_legacy_matched_fact_ids(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # Shallow copy to avoid mutating caller dict
            data = dict(data)
            # Accept matched_fact_ids as input alias if evidence_fact_ids is absent
            if "evidence_fact_ids" not in data and "matched_fact_ids" in data:
                data["evidence_fact_ids"] = data.pop("matched_fact_ids")
            elif "matched_fact_ids" in data:
                # Strip matched_fact_ids so it is never preserved
                data.pop("matched_fact_ids", None)

            # Legacy status field alias
            if "match_status" not in data and "status" in data:
                data["match_status"] = data.pop("status")
        return data

    @model_validator(mode="after")
    def validate_evidence_contract(self) -> "CanonicalRequirement":
        if not self.requirement_id or not self.requirement_id.strip():
            raise ValueError("requirement_id must be a nonempty string.")
        if not self.jd_quote or not self.jd_quote.strip():
            raise ValueError("jd_quote must be a nonempty string.")

        # matched and partial require evidence_fact_ids and evidence_quotes
        if self.match_status in (RequirementMatchStatus.MATCHED, RequirementMatchStatus.PARTIAL):
            if not self.evidence_fact_ids:
                raise ValueError(
                    f"Requirement '{self.requirement_id}' with status '{self.match_status.value}' "
                    "requires at least one evidence_fact_id."
                )
            if not self.evidence_quotes:
                raise ValueError(
                    f"Requirement '{self.requirement_id}' with status '{self.match_status.value}' "
                    "requires non-empty evidence_quotes."
                )
        elif self.match_status in (RequirementMatchStatus.UNSUPPORTED, RequirementMatchStatus.GAP):
            # unsupported and gap must not contain evidence IDs or quotes that imply coverage
            if self.evidence_fact_ids:
                raise ValueError(
                    f"Requirement '{self.requirement_id}' with status '{self.match_status.value}' "
                    "must not contain evidence_fact_ids."
                )
            if self.evidence_quotes:
                raise ValueError(
                    f"Requirement '{self.requirement_id}' with status '{self.match_status.value}' "
                    "must not contain evidence_quotes."
                )

        return self

    def model_dump(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        """Custom dump ensuring match_status, category, importance, review_status are strings."""
        kwargs.setdefault("mode", "json")
        dumped = super().model_dump(*args, **kwargs)
        # Ensure matched_fact_ids is never emitted
        dumped.pop("matched_fact_ids", None)
        return dumped


class KeywordCoverageResult(BaseModel):
    coverage_percentage: float
    matched_terms: List[str] = Field(default_factory=list)
    unsupported_terms: List[str] = Field(default_factory=list)
    term_sources: Dict[str, List[str]] = Field(default_factory=dict)
    skill_sources: Dict[str, List[str]] = Field(default_factory=dict)
    algorithm_version: str = "keyword_v1"
    total_required_terms: int = 0
    supported_required_terms: int = 0


class PreparationRequestStatus(str, Enum):
    QUEUED = "QUEUED"
    ANALYZING = "ANALYZING"
    TAILORING = "TAILORING"
    READY_FOR_REVIEW = "READY_FOR_REVIEW"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"
    SUPERSEDED = "SUPERSEDED"


ALLOWED_PREPARATION_REQUEST_TRANSITIONS: Dict[PreparationRequestStatus, Set[PreparationRequestStatus]] = {
    PreparationRequestStatus.QUEUED: {
        PreparationRequestStatus.ANALYZING,
        PreparationRequestStatus.BLOCKED,
        PreparationRequestStatus.FAILED,
        PreparationRequestStatus.SUPERSEDED,
    },
    PreparationRequestStatus.ANALYZING: {
        PreparationRequestStatus.TAILORING,
        PreparationRequestStatus.BLOCKED,
        PreparationRequestStatus.FAILED,
        PreparationRequestStatus.SUPERSEDED,
    },
    PreparationRequestStatus.TAILORING: {
        PreparationRequestStatus.READY_FOR_REVIEW,
        PreparationRequestStatus.BLOCKED,
        PreparationRequestStatus.FAILED,
        PreparationRequestStatus.SUPERSEDED,
    },
    PreparationRequestStatus.READY_FOR_REVIEW: {PreparationRequestStatus.SUPERSEDED},
    PreparationRequestStatus.BLOCKED: {
        PreparationRequestStatus.ANALYZING,
        PreparationRequestStatus.SUPERSEDED,
    },
    PreparationRequestStatus.FAILED: {PreparationRequestStatus.SUPERSEDED},
    PreparationRequestStatus.SUPERSEDED: set(),
}


def validate_preparation_request_transition(current: str, target: str) -> PreparationRequestStatus:
    """Return the normalized target status or reject an illegal lifecycle transition."""
    try:
        current_status = PreparationRequestStatus(current)
        target_status = PreparationRequestStatus(target)
    except ValueError as exc:
        raise ValueError(f"Invalid preparation request status: {exc}") from exc

    if current_status == target_status:
        return target_status
    allowed = ALLOWED_PREPARATION_REQUEST_TRANSITIONS[current_status]
    if target_status not in allowed:
        allowed_values = sorted(status.value for status in allowed)
        raise ValueError(
            f"Illegal preparation request transition from '{current_status.value}' "
            f"to '{target_status.value}'. Allowed: {allowed_values}."
        )
    return target_status


class PreparationRequestModel(BaseModel):
    id: UUID
    job_id: UUID
    briefing_id: Optional[UUID] = None
    requested_by: str
    idempotency_key: str
    status: PreparationRequestStatus = PreparationRequestStatus.QUEUED
    analysis_id: Optional[UUID] = None
    resume_version_id: Optional[UUID] = None
    error_summary: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @field_validator("requested_by", "idempotency_key")
    @classmethod
    def validate_nonempty_bounded_text(cls, value: str) -> str:
        if not value.strip() or len(value) > 100:
            raise ValueError("value must contain 1 to 100 non-whitespace characters.")
        return value

    def model_dump(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        kwargs.setdefault("mode", "json")
        return super().model_dump(*args, **kwargs)
