"""
Antigravity hook integration.
Resolves active conversationId from Antigravity hook context/environment,
registers an expiring, scoped UI session in PostgreSQL, and generates
an opaque single-use redemption URL.
"""
import os
import sys
from pathlib import Path
from typing import List, Optional

# Ensure project root is on sys.path
BASE_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository
from services.ui.security import generate_secure_token, hash_token
from services.ui.server import read_state_file
from services.ui.sessions import SessionManager


def get_active_conversation_id() -> Optional[str]:
    """Extract conversation ID from Antigravity hook environment variables."""
    return (
        os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
        or os.environ.get("CONVERSATION_ID")
        or os.environ.get("AGY_CONVERSATION_ID")
    )


def create_session_url(
    purpose: str = "dashboard",
    allowed_actions: Optional[List[str]] = None,
    allowed_entity_ids: Optional[List[str]] = None,
    conversation_id: Optional[str] = None,
    workspace_path: Optional[str] = None
) -> str:
    """
    Generate an opaque, single-use URL bound to the exact conversation ID.
    Does not expose raw conversation ID in the URL.
    """
    conv_id = conversation_id or get_active_conversation_id()
    if not conv_id:
        raise ValueError("Cannot create UI session without an active Antigravity conversation ID.")

    ws_path = workspace_path or str(BASE_DIR)
    repo = JobRepository()
    session_mgr = SessionManager(repo)

    raw_token, session = session_mgr.create_session(
        conversation_id=conv_id,
        workspace_path=ws_path,
        purpose=purpose,
        allowed_actions=allowed_actions or ["bridge_ping"],
        allowed_entity_ids=allowed_entity_ids or [],
        ttl_minutes=60
    )

    state = read_state_file()
    base_url = state.get("url") if state else "http://127.0.0.1:8000"
    return f"{base_url}/redeem?token={raw_token}"


if __name__ == "__main__":
    conv = get_active_conversation_id() or "local_test_conversation"
    url = create_session_url(purpose="bridge_test", conversation_id=conv)
    print(f"Generated single-use redemption URL: {url}")
