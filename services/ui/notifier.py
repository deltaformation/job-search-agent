"""Leased outbox delivery worker and secure agentapi bridge for same-conversation notifications."""
import json
import subprocess
import time
from typing import Any, Dict, Optional, Protocol, Tuple
from uuid import uuid4
from services.memory.repository import JobRepository


class NotificationSender(Protocol):
    def send_notification(self, conversation_id: str, message: Dict[str, Any]) -> Tuple[bool, str, int]:
        """Dispatches notification and returns (success, error_or_output, duration_ms)."""
        ...


class AgentApiSender:
    """Invokes agentapi send-message via subprocess with shell=False, timeout, and output capping."""
    def __init__(self, timeout_seconds: float = 10.0, max_log_chars: int = 500) -> None:
        self.timeout_seconds = timeout_seconds
        self.max_log_chars = max_log_chars

    def send_notification(self, conversation_id: str, message: Dict[str, Any]) -> Tuple[bool, str, int]:
        start = time.time()
        json_payload = json.dumps(message, default=str)
        try:
            cmd = ["agentapi", "send-message", conversation_id, json_payload]
            proc = subprocess.run(
                cmd,
                shell=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds
            )
            duration_ms = int((time.time() - start) * 1000)
            if proc.returncode == 0:
                output = (proc.stdout or "").strip()[:self.max_log_chars]
                return True, output, duration_ms
            else:
                err = (proc.stderr or proc.stdout or f"Exited with code {proc.returncode}").strip()[:self.max_log_chars]
                return False, err, duration_ms
        except FileNotFoundError:
            duration_ms = int((time.time() - start) * 1000)
            return False, "agentapi executable not found on PATH.", duration_ms
        except subprocess.TimeoutExpired:
            duration_ms = int((time.time() - start) * 1000)
            return False, f"agentapi timed out after {self.timeout_seconds}s.", duration_ms
        except Exception as exc:
            duration_ms = int((time.time() - start) * 1000)
            return False, str(exc)[:self.max_log_chars], duration_ms


class MockNotificationSender:
    """Test and simulation sender that records sent messages in memory."""
    def __init__(self, should_succeed: bool = True, fail_error: str = "Simulated delivery failure") -> None:
        self.should_succeed = should_succeed
        self.fail_error = fail_error
        self.sent_messages: list[Tuple[str, Dict[str, Any]]] = []

    def send_notification(self, conversation_id: str, message: Dict[str, Any]) -> Tuple[bool, str, int]:
        if self.should_succeed:
            self.sent_messages.append((conversation_id, message))
            return True, "Mock delivery success", 5
        return False, self.fail_error, 5


class LeasedOutboxWorker:
    """
    Manages the leased outbox lifecycle:
    PENDING -> LEASED -> DELIVERED / FAILED (with exponential backoff) / DEAD_LETTER.
    Provides crash recovery and concurrency protection across multiple workers.
    """
    def __init__(
        self,
        repo: JobRepository,
        sender: Optional[NotificationSender] = None,
        lease_duration_seconds: int = 30
    ) -> None:
        self.repo = repo
        self.sender = sender or AgentApiSender()
        self.lease_duration_seconds = lease_duration_seconds

    def recover_stranded_leases(self) -> int:
        """Reset actions whose lease expired back to PENDING for re-processing."""
        with self.repo.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE ui_actions
                    SET status = 'PENDING',
                        lease_token = NULL,
                        lease_expires_at = NULL,
                        updated_at = NOW()
                    WHERE status = 'LEASED' AND lease_expires_at <= NOW();
                """)
                count = cur.rowcount
                conn.commit()
                return count

    def process_batch(self, limit: int = 10) -> int:
        """Lease and process a batch of eligible actions."""
        worker_token = uuid4().hex
        leased_actions = self.repo.lease_pending_ui_actions(
            limit=limit,
            lease_duration_seconds=self.lease_duration_seconds,
            worker_token=worker_token
        )
        if not leased_actions:
            return 0

        processed = 0
        for action in leased_actions:
            action_id = str(action["id"])
            conversation_id = action.get("conversation_id")
            if not conversation_id:
                # Corrupted or un-scoped action; mark permanent failure
                self.repo.fail_ui_action_delivery(
                    action_id=action_id,
                    worker_token=worker_token,
                    error_summary="Action has no bound conversation_id.",
                    is_permanent=True
                )
                continue

            # Format structured notification payload with prompt injection containment
            message = {
                "event": action["action_type"],
                "action_id": action_id,
                "conversation_id": conversation_id,
                "entity_type": action.get("entity_type"),
                "entity_id": str(action["entity_id"]) if action.get("entity_id") else None,
                "payload": action.get("payload", {}),
                "instruction": f"Local control center event '{action['action_type']}' committed by human user."
            }

            attempt_number = (action.get("retry_count") or 0) + 1
            success, output, duration_ms = self.sender.send_notification(conversation_id, message)

            if success:
                # Record delivery attempt
                self.repo.record_ui_action_delivery_attempt(
                    action_id=action_id,
                    attempt_number=attempt_number,
                    status="SUCCESS",
                    error_details=output,
                    duration_ms=duration_ms
                )
                self.repo.complete_ui_action_delivery(action_id=action_id, worker_token=worker_token)
                processed += 1
            else:
                max_retries = action.get("max_retries", 5)
                is_perm = attempt_number >= max_retries
                status_label = "PERMANENT_FAILURE" if is_perm else "RETRYABLE_FAILURE"
                self.repo.record_ui_action_delivery_attempt(
                    action_id=action_id,
                    attempt_number=attempt_number,
                    status=status_label,
                    error_details=output,
                    duration_ms=duration_ms
                )
                self.repo.fail_ui_action_delivery(
                    action_id=action_id,
                    worker_token=worker_token,
                    error_summary=output,
                    is_permanent=is_perm
                )
                processed += 1

        return processed
