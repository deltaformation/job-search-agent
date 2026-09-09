# Implementation Plan: Job Search Control Center

## Purpose

This plan extends the existing discovery, intelligence, document, and guarded
application systems into one human-friendly workflow operated through
Antigravity and two local HTML views:

1. A morning job dashboard for reviewing and selecting new jobs.
2. A resume review page for approving an exact version or requesting changes.

The HTML views are control surfaces over the existing PostgreSQL and MCP
services. They do not replace the database, create a second source of truth, or
weaken the human-review boundaries.

## Target User Experience

### Morning briefing

The user says:

> Good morning. What new jobs do I have today?

Antigravity:

1. Runs or retrieves the latest completed discovery window.
2. Completes structured analysis for eligible jobs that are still pending.
3. Returns a concise table in the conversation.
4. Opens or links to a local dashboard containing the complete sortable list.
5. Waits for the user to select jobs.

The dashboard shows:

- Role and company.
- Remote, hybrid, or onsite classification.
- Location.
- Compensation when explicitly present in the posting.
- Posting freshness.
- Overall fit score.
- Keyword coverage score.
- Evidence coverage.
- Recommendation flag.
- Important strengths, gaps, and risks.

The user checks one or more jobs and presses **Prepare Selected**. The selection
is persisted and sent to the same Antigravity conversation. The wording
"Prepare Selected" is intentional: this action authorizes analysis and resume
preparation, not application submission.

### Resume review

For each selected job, Antigravity analyzes the exact JD snapshot, maps its
requirements to verified candidate facts, selects and orders relevant facts,
and produces a new immutable resume version.

The local resume review page shows:

- The exact resume HTML and PDF.
- The bound job, JD snapshot, candidate snapshot, and analysis version.
- Requirement-to-fact evidence.
- Partial matches, unsupported requirements, and gaps.
- Fact selection and ordering changes from the baseline.
- Artifact and validation status.

The page ends with two actions:

- **Approve Resume**: approves the exact displayed version and allows guarded
  application preparation to begin.
- **Request Changes**: captures feedback, preserves the current version, and
  returns the work to the same Antigravity conversation for a new version.

After approval, Antigravity may prepare the ATS form, fill only validated safe
fields, and upload the approved PDF. It must stop at `WAITING_FOR_HUMAN`. The
user performs the final ATS review and clicks the final submit button manually.

## Non-Negotiable Invariants

1. Candidate facts are immutable. Tailoring may select, omit, or reorder facts;
   it must not silently change them.
2. Every resume career claim maps to at least one approved `fact_id`.
3. Unsupported requirements remain visibly `partial`, `unsupported`, or `gap`.
4. Agent-generated analysis cannot claim human confirmation.
5. Every dashboard and review action is idempotent and auditable.
6. A revision creates a new resume version. Existing versions are never
   overwritten.
7. Resume approval applies to one exact resume version and its bound dossier.
8. Resume approval does not authorize final application submission.
9. No MCP tool or agent-accessible endpoint can attest final human submission.
10. Do not grant global `command(python)` or `command(job)` permission.

## Architecture

```text
Antigravity conversation
        |
        | career-memory MCP
        v
PostgreSQL-backed domain services
        |
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
Morning briefing       Resume review bundle    Application Copilot
        |                      |                      |
        v                      v                      v
Local dashboard        Local review page       Headed ATS browser
        |                      |
        +----------+-----------+
                   |
                   | authenticated UI action
                   v
       Loopback control service / sidecar
                   |
                   | agentapi send-message
                   v
       Same Antigravity conversation
```

The local control service binds only to `127.0.0.1`. PostgreSQL remains the
authoritative state store. A UI action is committed before a notification is
sent to Antigravity, so a lost notification never loses the user's decision.

---

# Milestone 4: Evidence and Preparation Contract

## Goal

Make analysis, scoring, tailoring, and review use one explicit evidence schema
and fail closed when their immutable inputs do not agree.

This milestone must land before either HTML control surface.

## 4.1 Canonical requirement model

Create a Pydantic model shared by intelligence, documents, reviews, repository,
and MCP layers. Its serialized field names are:

```json
{
  "requirement_id": "req_001",
  "jd_quote": "Exact text from the JD snapshot",
  "description": "Short normalized description",
  "category": "experience",
  "importance": "required",
  "match_status": "partial",
  "evidence_fact_ids": ["fact_006"],
  "evidence_quotes": ["Exact approved candidate fact text"],
  "review_status": "proposed",
  "analysis_notes": "Why the evidence is partial"
}
```

Rules:

- `evidence_fact_ids` is the only canonical evidence-ID field.
- Accept `matched_fact_ids` only as a temporary input alias at legacy
  repository boundaries.
- Newly persisted analysis must never emit `matched_fact_ids`.
- `matched` and `partial` require at least one approved fact ID and exact
  evidence quotations.
- `unsupported` and `gap` must not contain evidence IDs that imply coverage.
- Semantic evidence remains `partial` unless a human has explicitly reviewed
  it through a future dedicated requirement-review flow.
- Antigravity submissions must always use `review_status=proposed`.

## 4.2 Analysis and snapshot preconditions

Before resume generation, require:

- A nonempty JD snapshot.
- A candidate profile snapshot.
- A validated analysis bound to both snapshots.
- The analysis to be the current analysis version for the job.
- Every cited fact to exist in the bound candidate snapshot and be approved.

Remove the document pipeline fallback that generates an application-bound
resume without a current `analysis_id`. Return a structured blocker instead.

If the JD changes after analysis, create a new JD snapshot and require a new
analysis. Do not mutate or silently reuse the old analysis.

## 4.3 Transparent keyword coverage

Add a separate keyword-coverage calculation. Do not rename the existing
weighted fit score.

Recommended definition for V1:

```text
keyword coverage =
  supported normalized required terms / total normalized required terms * 100
```

Only count support from verified skills and technologies or exact candidate
fact text. Store:

- Coverage percentage.
- Matched normalized terms.
- Unsupported normalized terms.
- Source fact IDs for every matched term.
- Scoring algorithm version.

Do not treat keyword coverage as proof that an entire requirement is met.

## 4.4 Preparation request model

Add migration `010_job_control_center.sql` with an append-oriented preparation
request table:

```text
preparation_requests
- id UUID primary key
- job_id UUID not null
- briefing_id UUID nullable
- requested_by VARCHAR not null
- idempotency_key VARCHAR not null
- status VARCHAR not null
- analysis_id UUID nullable
- resume_version_id UUID nullable
- error_summary TEXT nullable
- created_at TIMESTAMPTZ not null
- updated_at TIMESTAMPTZ not null
```

Statuses:

```text
QUEUED -> ANALYZING -> TAILORING -> READY_FOR_REVIEW
       -> BLOCKED
       -> FAILED
       -> SUPERSEDED
```

Enforce a unique `(job_id, idempotency_key)` constraint. Retrying the same UI
action returns the existing request instead of creating duplicate analyses or
resume versions.

## 4.5 Services and MCP changes

Add or update:

- `services/intelligence/models.py`
- `services/intelligence/scorer.py`
- `services/documents/pipeline.py`
- `services/documents/validator.py`
- `services/memory/repository.py`
- `services/mcp/server.py`

MCP tools:

- Keep `get_pending_analysis` and `submit_analysis_version`.
- Keep `get_tailoring_context` and `submit_resume_draft`.
- Add `create_preparation_request(job_id, briefing_id, idempotency_key)`.
- Add `get_preparation_status(request_id)`.
- Do not expose resume approval through MCP.

The existing `prepare_application` tool retains its current meaning: begin the
post-approval ATS workflow. Do not reuse that name for resume preparation.

## 4.6 Tests

- Canonical requirement serialization tests.
- Legacy `matched_fact_ids` input translation tests.
- Regression test proving `evidence_fact_ids` affects resume fact ranking.
- Rejection of resumes with no analysis ID.
- Stale JD, profile, and analysis rejection.
- Keyword coverage with verified and unverified terms.
- Idempotent preparation requests.
- Concurrent request allocation.

## Exit criteria

- Analysis, scoring, tailoring, and review consume the same schema.
- No application-bound resume can be generated without current snapshot and
  analysis lineage.
- Keyword coverage is reproducible and carries fact-level evidence.
- Retry behavior cannot create duplicate work for the same UI action.

## Milestone 4 implementation review (2026-09-09)

The post-implementation review corrected the following contract gaps before
the milestone was committed:

- Repository writes now reject invalid canonical requirements instead of
  stripping legacy fields and persisting the remaining invalid payload.
- Analysis persistence verifies that the JD snapshot belongs to the job and
  that the candidate snapshot exists.
- Resume generation validates candidate identity, snapshot structure, exact JD
  quotations, exact evidence quotations, and approved fact membership before
  creating an immutable resume version.
- Analysis contexts refresh stale JD snapshots, and stale submissions are
  rejected before a new analysis version can be saved.
- Keyword coverage is persisted in `job_scores`, returned by job and shortlist
  reads, and distinguishes approved fact sources from verified skill sources.
  Preferred requirements are excluded from the required-term denominator.
- Preparation requests require a caller-supplied idempotency key. Status
  updates are serialized with a row lock, follow the declared lifecycle, and
  clear obsolete blocker text when work resumes.

Focused verification is intentionally database-free in the restricted review
environment. It covers canonical serialization and rejection behavior,
snapshot evidence validation, scoring and provenance compatibility, keyword
coverage persistence parameters, idempotency input validation, and lifecycle
rules. PostgreSQL-backed integration coverage remains in the test suite for an
environment where the isolated test schema is available.

---

# Milestone 5: Local Control Service and Same-Conversation Bridge

## Goal

Provide a secure local action channel from the two HTML pages back to the exact
Antigravity conversation that opened them.

## 5.1 Runtime shape

Build a small local control service with explicit dependencies and a checked-in
entrypoint. Prefer FastAPI/Starlette plus Uvicorn for typed request validation,
origin handling, and testability. Pin any new direct dependencies in both
`pyproject.toml` and `requirements.txt`.

Suggested files:

- `services/ui/app.py`
- `services/ui/security.py`
- `services/ui/sessions.py`
- `services/ui/actions.py`
- `services/ui/templates/`
- `services/ui/static/`
- `scripts/run_control_center.py`

The service must:

- Bind only to `127.0.0.1`.
- Prefer an automatically selected free port.
- Never listen on `0.0.0.0`.
- Serve only allowlisted dashboard and review resources.
- Never expose arbitrary filesystem paths.
- Use POST for state-changing actions.
- Reject unexpected `Origin` and `Host` values.
- Use `SameSite=Strict`, `HttpOnly` session cookies.
- Use CSRF tokens and short-lived opaque UI tokens.
- Store only token hashes in PostgreSQL.
- Rate-limit action endpoints.
- Cap revision feedback length and sanitize rendered output.

## 5.2 UI session and action persistence

Add:

```text
ui_sessions
- id UUID primary key
- token_hash VARCHAR(64) unique not null
- conversation_id VARCHAR not null
- workspace_path TEXT not null
- purpose VARCHAR not null
- expires_at TIMESTAMPTZ not null
- revoked_at TIMESTAMPTZ nullable
- created_at TIMESTAMPTZ not null

ui_actions
- id UUID primary key
- ui_session_id UUID not null
- action_type VARCHAR not null
- entity_type VARCHAR not null
- entity_id UUID nullable
- payload JSONB not null
- idempotency_key VARCHAR not null
- delivery_status VARCHAR not null
- delivered_at TIMESTAMPTZ nullable
- processed_at TIMESTAMPTZ nullable
- error_summary TEXT nullable
- created_at TIMESTAMPTZ not null
```

Use a unique `(ui_session_id, idempotency_key)` constraint. UI actions are
append-only audit records.

## 5.3 Exact conversation binding

Use an Antigravity project hook to capture the active `conversationId` supplied
to hook handlers. The hook registers an expiring local UI session and injects
only an opaque session token into the agent context. Antigravity passes that
opaque token when requesting a dashboard or review URL.

Do not put the raw conversation ID in a browser URL or HTML source.

Package the conversation notifier as an Antigravity sidecar. After committing
a UI action, the sidecar calls:

```text
agentapi send-message <conversation_id> <structured prompt>
```

Notifications must contain stable IDs, not only company names or titles.
Example:

```json
{
  "event": "jobs_selected",
  "briefing_id": "...",
  "preparation_request_ids": ["..."],
  "job_ids": ["..."],
  "instruction": "Prepare selected jobs for resume review. Do not submit applications."
}
```

Treat notification delivery as best effort. If delivery fails, leave the UI
action in `PENDING` and retry with bounded backoff. Antigravity must also check
for pending actions at the start of the next relevant user turn.

Repository-contained integration assets should live under
`integrations/antigravity/`. Provide an explicit human-run installation step
for any files that must be copied into Antigravity's global sidecar directory.
Do not modify global Antigravity configuration autonomously.

## 5.4 Human-action boundary

The control service may accept a resume approval only from its dedicated local
review endpoint. It must not expose that operation through MCP.

The project rules must explicitly prohibit agents and browser subagents from:

- Calling the approval endpoint.
- Clicking the review page's approval control.
- Replaying an approval request.
- Calling any final-submission endpoint.

Open the review page in the user's normal browser rather than the browser
profile controlled by the ATS automation agent. Approval should require a
confirmation dialog showing the exact company, role, resume version, and short
artifact digest. For stronger intent evidence, require the user to type
`APPROVE` in that dialog.

There must be no endpoint for final ATS submission.

## 5.5 Tests

- Loopback-only bind configuration.
- Host-header, Origin, CSRF, expiry, and token-replay rejection.
- UI session token hashing.
- Conversation binding isolation across simultaneous conversations.
- Double-click/idempotency behavior.
- Persist-before-notify behavior.
- Notification retry behavior.
- Test proving approval is absent from MCP.
- Test proving no final-submission endpoint exists.

## Exit criteria

- A test dashboard button sends one persisted event to its bound test
  conversation.
- Two concurrent conversations cannot receive each other's actions.
- Restarting the sidecar does not lose pending actions.
- Agent tools cannot invoke the resume approval pathway through MCP.

## Milestone 5 implementation review (2026-09-09)

The post-implementation review verified the following operational and security properties:

- The control service is strictly loopback-only, dynamically binding to free ports on 127.0.0.1 or localhost and rejecting any non-loopback bindings.
- Security headers (CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`) are enforced on every response.
- Host header validation prevents DNS rebinding attacks, and Origin/Referer verification protects mutating POST endpoints against CSRF.
- Single-use redemption URLs exchange opaque tokens for scoped, HttpOnly, SameSite=Strict session cookies, storing only SHA-256 hashes in PostgreSQL.
- The leased outbox engine uses PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` for race-free batch claiming, handles stranded leases on process restart, and employs bounded exponential backoff with dead-letter queueing.
- Database triggers protect UI action payloads from mutation and guarantee that action delivery logs remain strictly append-only.
- Resume approval and application submission remain strictly forbidden from MCP tool exposure and automated submission endpoints.

---

# Milestone 6: Morning Job Dashboard

## Goal

Make “Good morning, what are the new jobs?” produce a useful chat summary and a
local interactive dashboard from one consistent briefing snapshot.

## 6.1 Briefing model

Add:

```text
job_briefings
- id UUID primary key
- schedule_name VARCHAR not null
- window_started_at TIMESTAMPTZ not null
- window_ended_at TIMESTAMPTZ not null
- source_run_ids JSONB not null
- status VARCHAR not null
- metrics JSONB not null
- created_at TIMESTAMPTZ not null

job_briefing_items
- id UUID primary key
- briefing_id UUID not null
- job_id UUID not null
- rank INT not null
- snapshot JSONB not null
- created_at TIMESTAMPTZ not null
```

The item snapshot freezes what the user saw: title, company, location, remote
type, compensation, freshness, scores, recommendation, and analysis ID. Later
rescoring must not rewrite an old briefing.

Use the latest acknowledged briefing boundary to define "new". Do not rely on
calendar midnight alone. Clearly distinguish:

- Newly discovered jobs.
- Previously seen jobs with meaningful updates.
- Jobs omitted because analysis is incomplete.
- Discovery sources that failed or returned partial results.

## 6.2 Dashboard UI

Route:

```text
GET /ui/briefings/{opaque-token}
```

Columns:

- Checkbox.
- Recommendation flag.
- Role.
- Company.
- Work arrangement.
- Location.
- Salary.
- Freshness.
- Overall fit.
- Keyword coverage.
- Evidence coverage.
- Top gap.

Controls:

- Sort by fit, freshness, salary, company, or role.
- Filter by recommendation, remote type, location, freshness, and score.
- Expand a row for strengths, gaps, risks, evidence, and source URL.
- Select all visible rows.
- Clear selection.
- **Prepare Selected** button fixed at the bottom.

Do not include a button labeled only "Apply". The dashboard action does not
submit applications.

## 6.3 Selection action

Route:

```text
POST /api/briefings/{opaque-token}/prepare
```

Payload:

```json
{
  "job_ids": ["uuid", "uuid"],
  "idempotency_key": "uuid"
}
```

Server behavior in one transaction:

1. Verify every job belongs to the briefing.
2. Reject expired, withdrawn, rejected, or already-submitted jobs.
3. Create or reuse preparation requests.
4. Record the UI action.
5. Commit.
6. Notify the bound Antigravity conversation.

If some jobs are invalid, return per-job results instead of discarding valid
selections. Display queued, blocked, and already-prepared outcomes clearly.

## 6.4 Antigravity workflow

Add a project skill for the morning briefing. It should:

1. Run or retrieve the desired discovery window.
2. Report individual board failures without aborting other boards.
3. Retrieve pending analysis jobs.
4. Submit structured analyses through MCP.
5. Re-score using the validated analyses.
6. Create the immutable briefing snapshot.
7. Return a compact Markdown table in chat.
8. Open or link the dashboard.
9. Stop and wait for selection.

When a `jobs_selected` UI event arrives, resume the same conversation and
process each preparation request independently. Failure for one selected job
must not abort the others.

## 6.5 Tests

- Correct "new since last briefing" window.
- Stable briefing snapshots after job updates.
- Salary absent vs explicitly provided.
- Remote/hybrid/onsite normalization.
- Partial discovery failure visibility.
- Sorting and filtering behavior.
- Selection membership validation.
- Mixed valid and blocked batch behavior.
- Conversation notification payload.
- Accessibility: keyboard selection, labels, focus, contrast, and reduced
  motion.

## Exit criteria

- The morning prompt produces both a chat table and a dashboard.
- The dashboard values agree with its persisted briefing snapshot.
- Selected jobs create preparation requests and wake the originating
  conversation once.
- No selection action can approve a resume or submit an application.

---

# Milestone 7: Evidence-Bound Resume Review Studio

## Goal

Give the user one integrated HTML page for inspecting an exact resume version,
its evidence, and its changes, then approving it or requesting a revision.

## 7.1 Immutable review bundle

Add:

```text
resume_review_bundles
- id UUID primary key
- resume_version_id UUID unique not null
- analysis_id UUID not null
- jd_snapshot_id UUID not null
- candidate_snapshot_id UUID not null
- dossier JSONB not null
- dossier_hash VARCHAR(64) not null
- markdown_path TEXT nullable
- created_at TIMESTAMPTZ not null
```

Protect the table with an immutability trigger. The dossier must be derived only
from the resume-bound snapshots and analysis, never from "latest" mutable data.

The canonical dossier includes:

```text
identity
job_snapshot
resume_artifacts
analysis_binding
requirements[]
fact_changes[]
validation
application_policy
blockers[]
```

Every requirement row includes its exact JD quote, match status, evidence fact
IDs, exact evidence text, and analysis notes.

## 7.2 Honest change model

The current generated baseline is not a canonical authored resume. Until a true
baseline artifact exists, label the comparison **Fact selection and ordering**,
not "resume text diff".

For each fact, calculate:

- `selected`
- `omitted`
- `moved_up`
- `moved_down`
- `unchanged`
- `used_as_summary`

If a true baseline is later introduced, persist its version ID and hash and add
a separate textual diff.

## 7.3 Review UI

Route:

```text
GET /ui/reviews/{opaque-token}/{resume-version-id}
```

Sections:

1. Sticky identity bar with company, role, resume version, and status.
2. Resume HTML preview.
3. PDF open/download control.
4. Requirement alignment matrix.
5. Gaps and unsupported requirements.
6. Fact selection and ordering changes.
7. Validation and integrity summary.
8. Revision history.
9. Sticky footer with **Approve Resume** and **Request Changes**.

The page must escape all JD, candidate, and feedback text. Do not insert raw JD
HTML into the DOM.

## 7.4 Approval action

Route:

```text
POST /api/reviews/{opaque-token}/{resume-version-id}/approve
```

The confirmation dialog displays:

- Company and role.
- Resume version.
- Short content, PDF, and dossier digests.
- Statement that approval does not submit the application.

Approval executes one database transaction:

1. Lock the resume, review bundle, and job.
2. Require `AWAITING_HUMAN_REVIEW`.
3. Require the displayed version to remain the latest version.
4. Recompute text, HTML, PDF, and dossier hashes.
5. Verify snapshot and analysis lineage.
6. Record the human approval event with the review bundle ID and hash.
7. Set the resume to `APPROVED`.
8. Transition the eligible job to `READY`.
9. Commit once.
10. Notify Antigravity only after commit.

If any validation fails, perform no writes and refresh the page with blockers.

## 7.5 Revision action

Route:

```text
POST /api/reviews/{opaque-token}/{resume-version-id}/revision
```

The UI opens a feedback dialog with optional structured controls:

- Choose a different verified summary fact.
- Promote selected facts.
- De-emphasize selected facts.
- Omit selected facts.
- Free-text revision instructions.

Persist:

```text
resume_revision_requests
- id UUID primary key
- resume_version_id UUID not null
- ui_action_id UUID unique not null
- requested_changes JSONB not null
- feedback_text TEXT nullable
- status VARCHAR not null
- replacement_resume_version_id UUID nullable
- created_at TIMESTAMPTZ not null
- completed_at TIMESTAMPTZ nullable
```

The action must not modify or approve the reviewed resume. It records the
request, marks it for processing, and sends a structured event to the same
conversation. Antigravity creates a new resume version with
`parent_version_id` pointing to the reviewed version.

## 7.6 Summary and bullet-editing scope

V1 remains fact-preserving:

- Reorder verified bullets.
- Select or omit verified bullets.
- Select a different verified fact as the summary.
- Update the canonical candidate fact through the separate human-reviewed
  profile workflow, then regenerate the resume.

Do not imply that arbitrary rewritten text is already supported. The current
validator accepts verbatim facts only.

If controlled rewriting is desired later, create a separate ADR and validator
milestone. Any new strategy must use atomic claims, source fact IDs, explicit
metrics and technologies, deterministic checks for new factual tokens, and
human review. It must never be introduced as an unvalidated shortcut inside
this milestone.

## 7.7 Antigravity events

Approval notification:

```json
{
  "event": "resume_approved",
  "job_id": "...",
  "resume_version_id": "...",
  "review_bundle_id": "...",
  "instruction": "Continue with guarded application preparation. Stop before final submission."
}
```

Revision notification:

```json
{
  "event": "resume_revision_requested",
  "job_id": "...",
  "resume_version_id": "...",
  "revision_request_id": "...",
  "instruction": "Create a new immutable resume version from the recorded revision request."
}
```

The notification is not the approval record. PostgreSQL state is authoritative.

## 7.8 Tests

- Dossier generated exclusively from bound snapshots.
- Requirement status and exact evidence display.
- Gap and unsupported display.
- Stable fact-order comparison.
- HTML escaping and prompt-injection containment.
- PDF path traversal, symlink, missing file, and digest rejection.
- Dossier digest rejection.
- Approval of stale/non-latest version rejected.
- Atomic rollback when READY transition fails.
- Revision preserves the old version.
- Parent/replacement version linkage.
- Double-click approval and revision idempotency.
- Approval and revision notification routing.
- Browser opener failure does not alter approval state.

## Exit criteria

- The user can inspect the exact resume, evidence, gaps, and changes in one
  page.
- Approve moves exactly that version to `APPROVED` and its job to `READY` in one
  transaction.
- Request Changes returns structured feedback to the same conversation and
  produces a new immutable version.
- No agent-accessible MCP call can approve the resume.

---

# Milestone 8: Guarded Application Continuation and Operational Hardening

## Goal

Connect UI approval to the existing Application Copilot without weakening the
manual final-submission boundary, then make the complete workflow observable
and recoverable.

## 8.1 Approval continuation

When Antigravity receives `resume_approved`:

1. Re-read the job and approved resume from `career-memory`.
2. Call the existing `prepare_application` MCP tool with an idempotency key.
3. Open the headed ATS browser.
4. Record the form snapshot.
5. Submit and validate a field plan.
6. Fill only `SAFE` fields and upload the approved PDF.
7. Record each action.
8. Create the checkpoint.
9. Stop at `WAITING_FOR_HUMAN`.

Never automate legal, work authorization, compensation, demographic,
signature, account-security, or final-submit controls.

## 8.2 Progress visibility

Show preparation status in both the originating chat and HTML pages:

```text
Selected
Analyzing
Tailoring
Ready for resume review
Revision requested
Resume approved
Preparing application
Waiting for human
Human-confirmed submitted
Blocked / Failed
```

Status display must distinguish a recoverable notification failure from a
domain workflow failure.

## 8.3 Recovery

- Sidecar restart resumes undelivered UI actions.
- Control-service restart preserves sessions until their stored expiry.
- Expired UI links produce a safe page with instructions to ask Antigravity for
  a new link.
- Duplicate UI requests return the original result.
- A changed JD, profile, analysis, or resume artifact invalidates downstream
  readiness and requires regeneration.
- Failure for one job in a selected batch does not stop other jobs.
- No recovery path rewinds `SUBMITTED`, interview, offer, rejected, withdrawn,
  or accepted states.

## 8.4 Documentation

Update:

- `README.md`
- `docs/architecture.md`
- `docs/operations.md`
- `docs/mcp.md`
- `docs/milestone2-review.md`
- `docs/playwright_workflow.md`
- `AGENTS.md`

Document:

- Starting and stopping the control center.
- Installing and enabling the Antigravity sidecar and hook.
- Morning briefing workflow.
- Dashboard selection semantics.
- Resume approval and revision semantics.
- Recovery from expired links and failed notifications.
- The two separate human checkpoints.
- How to inspect the audit trail.

Updating `AGENTS.md` is required before replacing the TTY-only resume approval
flow. The revised rule must authorize only direct human approval through the
local review UI while continuing to forbid agent, MCP, scripted, and browser-
automated approval.

## 8.5 Verification

Automated:

- Run the complete collected `pytest tests/` suite.
- Run UI unit tests without a live browser.
- Run PostgreSQL integration tests in isolated schemas.
- Run browser tests against synthetic dashboard, review, Greenhouse, Lever, and
  generic ATS fixtures.
- Verify accessibility checks.
- Verify all migrations on both a fresh database and an upgraded database.

Manual:

1. Ask for the morning briefing in a real Antigravity conversation.
2. Confirm the chat table and dashboard contain the same jobs and scores.
3. Select two jobs and press **Prepare Selected**.
4. Confirm the same conversation receives one selection event.
5. Allow both resumes to be generated independently.
6. Request changes for one resume and confirm a new version appears.
7. Approve the other resume and confirm it alone becomes `READY`.
8. Confirm the ATS is prepared with safe fields only.
9. Confirm automation stops before final submission.
10. Submit manually and use the existing human-only outcome flow.

## Exit criteria

- The complete morning-to-human-takeover workflow works without blanket shell
  permissions.
- The normal path requires one dashboard selection action, one resume decision
  per version, and one final manual ATS submission action.
- All facts, analyses, resumes, dossiers, selections, revisions, browser
  actions, and state transitions remain auditable.
- No automated path can approve a resume or submit an application.

---

# Recommended Build Order

Implement and review each slice before starting the next:

1. Milestone 4.1-4.3: evidence contract and keyword coverage.
2. Milestone 4.4-4.6: idempotent preparation requests and tests.
3. Milestone 5: loopback service and same-conversation bridge.
4. Milestone 6: morning dashboard.
5. Milestone 7.1-7.3: immutable dossier and read-only review page.
6. Milestone 7.4: direct human approval transaction.
7. Milestone 7.5-7.7: revision loop.
8. Milestone 8: Application Copilot continuation and hardening.

Do not build the approval action before the review page is read-only complete,
snapshot-bound, and covered by integrity tests.

# Definition of Done

The feature is complete when the following user journey succeeds:

1. The user asks for new jobs.
2. Antigravity shows a concise chat table and opens a matching local dashboard.
3. The user selects jobs and presses **Prepare Selected**.
4. The same conversation receives the selection and generates evidence-bound
   resumes.
5. The user reviews each resume in HTML.
6. **Request Changes** creates a new immutable version through the same chat.
7. **Approve Resume** approves only the displayed version.
8. Antigravity prepares the ATS application and stops at human takeover.
9. The user manually submits.
10. The complete history is reconstructable from PostgreSQL and immutable
    artifacts.
