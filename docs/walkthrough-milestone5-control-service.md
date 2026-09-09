# Walkthrough: Milestone 5 - Local Control Service and Same-Conversation Bridge

## Overview

Milestone 5 implements a secure, local-only HTTP control service and transactional outbox bridge. This infrastructure connects local browser-based HTML surfaces (the Morning Dashboard and Resume Review Studio) back to the exact active Antigravity conversation without exposing sensitive tokens, bypassing human safety boundaries, or dropping notifications.

---

## Changes by Component

### 1. Loopback-Only Web Application (`services/ui/`)
- **`server.py`**:
  - `ControlCenterServer`: Strictly restricts host binding to `127.0.0.1` and `localhost`; rejects `0.0.0.0` or external interfaces with `ValueError("Loopback violation")`.
  - Dynamic free port resolution (`find_free_port()`).
  - File-based discovery and PID heartbeat state file (`~/.job_search_ui_state.json` and workspace state file) with graceful teardown cleanup.
- **`app.py` & `security.py`**:
  - Comprehensive HTTP security headers on all responses (`Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`).
  - Host validation against loopback to defeat DNS rebinding attacks.
  - Strict Origin & Referer checks on all mutating HTTP POST endpoints.
  - Single-use redemption URL flow (`/redeem?token=...`) exchanging an opaque token for an `HttpOnly`, `SameSite=Strict` cookie.
  - Cryptographic token hashing (`SHA-256`) ensuring cleartext tokens never touch the database.
  - Double-submit CSRF token generation and validation.
  - Per-IP rate limiting and request body size caps.

### 2. Transactional Persistence & Audit Immutability (`db/migrations/011_ui_sessions_and_actions.sql`)
- **`ui_sessions`**:
  - Scoped by conversation ID, workspace path, allowed actions, and expiration timestamp.
- **`ui_actions`**:
  - Stores action payloads with `UNIQUE (ui_session_id, idempotency_key)` to guarantee idempotency under concurrent or rapid submissions.
  - States: `PENDING -> LEASED -> DELIVERED` (with `FAILED`, `DEAD_LETTER`, `SUPERSEDED`).
- **`ui_action_deliveries`**:
  - Append-only attempt log tracking worker attempts, durations, and error details.
- **PostgreSQL Immutability Triggers**:
  - `protect_ui_action_content`: Prevents modification of existing action payloads or metadata.
  - `protect_ui_action_deliveries`: Enforces strictly append-only audit records, raising exceptions on any UPDATE or DELETE.

### 3. Leased Outbox Delivery Engine (`services/ui/notifier.py`)
- **`LeasedOutboxWorker`**:
  - Atomically leases batches of pending actions using `SELECT ... FOR UPDATE SKIP LOCKED`.
  - Recovers stranded leases if a worker process terminates unexpectedly.
  - Exponential backoff retry logic with dead-letter queueing on persistent failure.
- **`AgentApiSender`**:
  - Formats and dispatches structured event notifications to Antigravity via `agentapi send-message <conv_id> <payload>`.

### 4. Antigravity Harness Integrations & Entrypoints
- **`integrations/antigravity/hook.py`**:
  - Extracts the active Antigravity `conversation_id` from environment context and mints scoped, expiring single-use redemption URLs.
- **`integrations/antigravity/sidecar.py`**:
  - Supervises the loopback Uvicorn server and runs the background outbox worker inside the Antigravity lifecycle.
- **`scripts/run_control_center.py`**:
  - Standalone diagnostic runner supporting `--status`, `--stop`, and `--drain-outbox`.
- **Dependencies (`pyproject.toml` & `requirements.txt`)**:
  - Added pinned dependencies: `starlette>=1.6.0` and `uvicorn>=0.52.0`.

### 5. Human-Action Safety Boundaries
- Verified that resume approvals and final application submissions are completely absent from MCP tools.
- Ensured no agent tool or automated endpoint can attest to legal, work-authorization, or final ATS submissions.

---

## Verification & Test Results

The milestone is validated by 14 comprehensive tests in `tests/test_milestone5_control_service.py`:

- `test_loopback_only_bind_configuration`: Verified loopback-only enforcement.
- `test_security_headers_enforced`: Verified CSP, X-Frame-Options, and cache control headers.
- `test_host_and_origin_validation`: Verified rejection of foreign hosts and cross-origin POSTs.
- `test_csrf_protection_enforced`: Verified CSRF validation on mutating endpoints.
- `test_single_use_token_redemption`: Verified token-to-cookie exchange and replay rejection.
- `test_session_expiration`: Verified expired sessions are rejected.
- `test_session_scoping_and_authorization`: Verified action-type and entity-id authorization checks.
- `test_idempotency_protection`: Verified rapid duplicate clicks return cached responses without creating extra actions.
- `test_persist_before_notify_behavior`: Verified actions persist before delivery attempts.
- `test_leased_outbox_delivery_flow`: Verified atomic `SKIP LOCKED` leasing, delivery, and retry backoff.
- `test_stranded_lease_recovery`: Verified lease timeout recovery after simulated worker failure.
- `test_immutability_trigger_enforcement`: Verified database triggers prevent altering action payloads or deleting delivery audit records.
- `test_human_boundary_no_approval_via_mcp`: Verified MCP does not expose resume approval.
- `test_no_final_submission_endpoint`: Verified control service has no automated final-submission route.

```bash
.venv/bin/pytest tests/test_milestone5_control_service.py
============================== 14 passed in 1.48s ==============================
```
