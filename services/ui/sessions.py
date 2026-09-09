"""Session management, single-use URL token redemption, and action authorization."""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from services.memory.repository import JobRepository
from services.ui.security import generate_secure_token, hash_token


class SessionManager:
    def __init__(self, repo: JobRepository) -> None:
        self.repo = repo

    def create_session(
        self,
        conversation_id: str,
        workspace_path: str,
        purpose: str,
        allowed_actions: Optional[List[str]] = None,
        allowed_entity_ids: Optional[List[str]] = None,
        ttl_minutes: int = 60
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Generate a one-time URL token and persist an unredeemed UI session.
        Returns (raw_url_token, session_record).
        """
        raw_token = generate_secure_token()
        token_hash = hash_token(raw_token)
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)

        session = self.repo.create_ui_session(
            token_hash=token_hash,
            conversation_id=conversation_id,
            workspace_path=workspace_path,
            purpose=purpose,
            allowed_actions=allowed_actions or [],
            allowed_entity_ids=allowed_entity_ids or [],
            expires_at=expires_at
        )
        return raw_token, session

    def redeem_url_token(self, raw_token: str) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]], str]:
        """
        Atomically redeem a one-time URL token, invalidate it, and issue an HttpOnly session cookie.
        Returns (success, cookie_token, session_record, message).
        """
        if not raw_token or not raw_token.strip():
            return False, None, None, "Missing token."

        token_hash = hash_token(raw_token.strip())
        session = self.repo.get_ui_session_by_token_hash(token_hash)
        if not session:
            return False, None, None, "Invalid or unrecognized token."

        now = datetime.now(timezone.utc)
        if session.get("revoked_at") is not None:
            return False, None, None, "Session has been revoked."

        if session["expires_at"] <= now:
            return False, None, None, "Token has expired."

        if session.get("redeemed_at") is not None:
            return False, None, None, "Token has already been redeemed (single-use only)."

        # Issue new cookie token
        cookie_token = generate_secure_token()
        cookie_hash = hash_token(cookie_token)

        updated_session = self.repo.redeem_ui_session_token(str(session["id"]), cookie_hash)
        if not updated_session:
            return False, None, None, "Token redemption failed concurrently."

        return True, cookie_token, updated_session, "Token redeemed successfully."

    def authenticate_cookie(self, raw_cookie: Optional[str]) -> Optional[Dict[str, Any]]:
        """Validate session cookie against database hash and verify active expiry."""
        if not raw_cookie or not raw_cookie.strip():
            return None

        cookie_hash = hash_token(raw_cookie.strip())
        session = self.repo.get_ui_session_by_cookie_hash(cookie_hash)
        if not session:
            return None

        now = datetime.now(timezone.utc)
        if session.get("revoked_at") is not None or session["expires_at"] <= now:
            return None

        return session

    def authorize_action(
        self,
        session: Dict[str, Any],
        action_type: str,
        entity_id: Optional[str] = None
    ) -> Tuple[bool, str]:
        """Verify action type and entity scope are permitted for this session."""
        allowed_actions = session.get("allowed_actions") or []
        if action_type not in allowed_actions:
            return False, f"Action '{action_type}' is not permitted for this session (allowed: {allowed_actions})."

        allowed_entities = session.get("allowed_entity_ids") or []
        if allowed_entities and entity_id:
            if str(entity_id) not in [str(e) for e in allowed_entities]:
                return False, f"Entity '{entity_id}' is not within this session's permitted scope."

        return True, "Authorized."
