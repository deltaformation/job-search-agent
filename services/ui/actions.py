"""Action schemas and dispatcher for control center interactions."""
from typing import Any, Dict, Optional, Tuple
from pydantic import BaseModel, Field
from services.memory.repository import JobRepository
from services.ui.sessions import SessionManager


class BridgePingPayload(BaseModel):
    client_timestamp: str = Field(description="ISO client timestamp")
    nonce: str = Field(description="Unique ping nonce")
    message: Optional[str] = Field(default=None, description="Optional diagnostic message")


class ActionSubmissionRequest(BaseModel):
    action_type: str
    entity_type: str = "system"
    entity_id: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str


def dispatch_action(
    repo: JobRepository,
    session: Dict[str, Any],
    submission: ActionSubmissionRequest
) -> Tuple[Dict[str, Any], bool]:
    """
    Validate session authorization, enforce idempotency, and persist an append-only action.
    Returns (action_record, is_new).
    """
    session_mgr = SessionManager(repo)
    authorized, reason = session_mgr.authorize_action(
        session,
        action_type=submission.action_type,
        entity_id=submission.entity_id
    )
    if not authorized:
        raise PermissionError(reason)

    # Validate specific action payload schemas
    if submission.action_type == "bridge_ping":
        BridgePingPayload.model_validate(submission.payload)

    record, is_new = repo.create_ui_action(
        ui_session_id=str(session["id"]),
        action_type=submission.action_type,
        entity_type=submission.entity_type,
        entity_id=submission.entity_id,
        payload=submission.payload,
        idempotency_key=submission.idempotency_key
    )
    return record, is_new
