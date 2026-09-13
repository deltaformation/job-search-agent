# Rebuild Milestones and Acceptance Gates

## Delivery model

The rebuild has seven sequential outcome milestones. Work orders inside a
milestone may run in parallel only when their file ownership and dependencies
do not overlap. A milestone is complete only when its acceptance evidence is
recorded in the pull request or commit; editing this document is not completion
evidence.

| Milestone | Outcome | Depends on |
|---|---|---|
| R0 | Preserve current value and remove Nimbalyst | None |
| R1 | Bootable Node/Next/SQLite local platform | R0 |
| R2 | Reliable pasted-URL ingestion and public scraping | R1 |
| R3 | Persistent five-column manual Kanban | R1; integrates with R2 |
| R4 | Truthful resume tailoring, artifacts, and approval | R2, R3 |
| R5 | Import, hardening, and final legacy cutover | R4 |
| R6 | Polished, accessible UI over the accepted product | R5 |

## R0 — Preservation and Nimbalyst exit

### Outcome

All valuable current work is recoverably preserved, every Nimbalyst dependency
is removed from active project control, and coding agents use the neutral
rebuild documents plus repository evidence.

### Scope

- Preserve the current dirty Milestone 7/8 implementation and its test evidence
  before deleting anything.
- Make this rebuild package and root `AGENTS.md` the coding-agent entrypoint.
- Harvest any remaining architectural decisions and acceptance criteria that
  are not already represented here.
- Remove `.nimbalyst/`, `nimbalyst-local/`, `scripts/populate_nimbalyst.py`,
  `tests/test_nimbalyst_workspace.py`, and active Nimbalyst references.
- Remove Nimbalyst-specific commands from operational docs.
- Add a guard test that active files contain no Nimbalyst dependency or startup
  path. Historical Git commits are the archive.

### Explicit non-goals

- No product runtime rewrite.
- No PostgreSQL or Python deletion.
- No reinterpretation of M7/M8 as accepted merely because their code exists.

### Acceptance evidence

- A recoverable commit/branch contains the pre-cleanup dirty work.
- `git status` after cleanup contains no accidental candidate-data or artifact
  deletions.
- A case-insensitive repository scan finds no active Nimbalyst references.
- Existing Python tests still pass, or every environment-only failure is
  recorded without being misrepresented as a regression.
- `AGENTS.md` points only to existing, non-Nimbalyst planning files.

## R1 — Local platform foundation

### Outcome

The repository starts a local Next.js app and separate worker with one root
command, creates/migrates an SQLite database, and exposes a secure health page.

### Scope

- Root Node.js/TypeScript project with pinned dependencies and lockfile.
- Node.js 24 LTS baseline recorded in `.nvmrc` and package engines; newer
  Current releases require an explicit clean-install/native-addon check.
- Next.js App Router, React, Tailwind, and a minimal accessible shell.
- Drizzle SQLite schema and reviewed initial migration.
- `better-sqlite3` connection policy: foreign keys, WAL, busy timeout.
- Typed domain enums/schemas for board, scrape, tailoring, artifact, and review
  state.
- Data-root configuration with safe defaults and `.gitignore` rules.
- Web/worker supervisor for `npm run dev` and `npm run start`, including signal
  forwarding and single actionable startup errors.
- Loopback-only bind, Host/Origin checks, CSRF protection, security headers,
  structured redacted logs, and artifact-root path utilities.
- Seed/import format for the canonical candidate profile; no invented example
  values in the user's active profile.

### Explicit non-goals

- No real page scraping.
- No completed board or resume generation.
- No PostgreSQL import yet.

### Acceptance evidence

- Fresh-data-root startup creates the database and storage directories.
- A second startup applies no duplicate migrations or seed data.
- Web and worker shut down cleanly together.
- Database constraint tests cover foreign keys, immutable event rows, and enum
  checks.
- Security tests reject foreign Origin/Host, traversal, symlink, and arbitrary
  filesystem access.
- Unit/type/lint tests pass on the documented Node version.

## R2 — URL intake and public scraping

### Outcome

The user can clip jobs directly in their browser with 1 click (past any anti-bot
challenges naturally) or paste public URLs, having every job normalized with full
evidence and landed directly on the board.

### Scope

- 1-click browser clipper extension and bookmarklet sending rendered DOM
  directly to `POST /api/intake/clip` for immediate normalization into `NEW`.
- Multiline intake UI with blank-line handling, invalid-line reporting, and
  duplicate feedback.
- URL policy and canonicalization with submitted URL retention.
- SSRF and redirect protections, origin rate limits, bounded time/size limits,
  and reason-coded failures.
- Transactional enqueue with an idempotency key derived from canonical URL.
- Lease-based worker claim, retry/backoff, stale-lease recovery, and graceful
  interruption.
- Playwright Chromium runtime with network/navigation guard.
- Adapter interface and first high-value public ATS adapters, followed by
  JSON-LD `JobPosting` and generic semantic fallback.
- Normalized title, company, location, arrangement, salary, description,
  application URL, and extraction confidence/missing-field report.
- Raw HTML/text/structured-data artifacts stored with size/hash metadata.
- Successful extraction creates a `NEW` job; failed extraction remains in the
  intake/attempt UI and creates no malformed card.
- Content paste fallback on attempt deep-dives for blocked pages.

### Explicit non-goals

- No search queries, JobSpy scans, job alerts, authentication, CAPTCHA solving,
  stealth browser behavior, or anti-bot bypass.
- No promise of perfect extraction for every site.

### Acceptance evidence

- Tests cover invalid protocols, credentials, private/loopback IPs, DNS/redirect
  changes, duplicate tracking URLs, size/time limits, and blocked pages.
- Adapter and generic fixtures cover static, JavaScript-rendered, JSON-LD,
  partial, login, CAPTCHA, and access-denied pages.
- One failed URL does not prevent another URL in the same batch from succeeding.
- Repeated intake and worker retries do not create duplicate jobs or evidence.
- A real, user-provided public test URL succeeds without login/bypass, or the
  milestone records a reason-coded site restriction honestly.

## R3 — Persistent manual Kanban

### Outcome

Jobs are inspectable and movable through exactly five persisted board columns,
with deterministic transition rules and a complete human-readable history.

### Scope

- Board queries grouped into `New`, `Tailored`, `Applied`, `Interviewed`, and
  `Rejected`.
- Accessible drag/drop with keyboard controls and a non-drag status action.
- Optimistic UI with server-authoritative conflict handling and rollback.
- Card summary: title, company, location/arrangement, salary text, scrape and
  tailoring state, active resume state, notes indicator, and source link.
- Card detail: raw/normalized source, attempts, missing fields, requirements,
  resume versions/artifacts, notes, application metadata, and workflow history.
- Append-only workflow events for every move/correction.
- Human-only `Applied` modal with timestamp and optional confirmation number.
- Explicit correction/reopen action requiring a note.
- Search/filter/sort limited to local job data; no discovery feature.

### Transition rules

- `NEW → TAILORED` is not available through ordinary drag until an approved
  active resume exists. Approval performs the transition.
- `NEW → REJECTED` and `TAILORED → REJECTED` are allowed with a reason.
- `TAILORED → APPLIED` is manual and records application metadata.
- `APPLIED → INTERVIEWED | REJECTED` is manual.
- Corrections outside those transitions require the explicit correction action
  and remain fully audited.

### Acceptance evidence

- Reload and restart preserve card positions and order.
- Concurrent/stale UI mutations return a conflict instead of losing an event.
- Every accepted transition creates exactly one matching event transactionally.
- The `Tailored` gate and `Applied` human confirmation cannot be bypassed via a
  direct route call.
- Keyboard-only board movement and card inspection pass accessibility tests.

## R4 — Truthful tailoring and resume artifacts

### Outcome

Every `NEW` job can receive an agent-assisted but deterministically validated
resume version, the user can inspect all output and gaps, and explicit approval
produces immutable Markdown, DOCX, and PDF artifacts and moves the job to
`Tailored`.

### Scope

- Versioned candidate profile import and immutable candidate/JD snapshots.
- `TailoringInputV1` and `ResumeProposalV1` Zod schemas.
- Provider-neutral `TailoringProvider`; deterministic fixture provider for
  tests and one local command adapter for actual use.
- Structured requirement extraction/mapping with exact JD quotes, importance,
  match status, evidence `fact_id` values, and explicit gaps.
- Port and parity-test claim validation, coverage-first fact ranking, keyword
  reporting, tenure union, summary derivation, and canonical view model.
- Port the trusted standard resume design and add a reviewed DOCX template.
- Markdown, DOCX, and PDF output from one canonical view model.
- Immutable version lineage, parent version, content/template/ranker hashes,
  claim evidence, artifact metadata, and deterministic change summary.
- Card review UX showing proposed changes, evidence facts, gaps, artifact
  previews/downloads, revision request, and human approval.
- Approval transaction binds exact verified artifact hashes and transitions the
  board to `TAILORED`.

### Explicit non-goals

- No free-form claim invention, autonomous approval, rich browser editing, ATS
  score claims, form filling, file upload automation, or submission.
- No provider-specific agent behavior in core domain code.

### Acceptance evidence

- Shared parity fixtures pass in the old Python oracle and new TypeScript port
  before the oracle is removed.
- Adversarial cases reject unsupported employers, titles, dates, technologies,
  credentials, metrics, causal claims, and prompt-injected instructions.
- Every rendered claim maps to approved `fact_id` evidence or an allowlisted,
  reconstructable derivation.
- Unsupported terms remain visible as gaps and absent from all artifacts.
- Identical bound inputs produce identical structured content and lineage.
- Markdown/DOCX/PDF extracted text and claim inventories match the canonical
  view model; PDF visual QA confirms readable one-to-two-page output.
- Revision creates a new version; approved content and artifacts cannot mutate.
- Direct API calls cannot approve as an agent or move an unapproved job to
  `TAILORED`.

## R5 — Settings UI, backup/restore, and legacy cutover

### Outcome

The new tracker is a 100% standalone, local-first Node.js/SQLite application
with a dedicated Settings and Data Management interface, one-click backup and
restore, clear OpenRouter configuration and diagnostics, and zero runtime or
file dependency on Python, PostgreSQL, Docker, MCP, or Nimbalyst.

### Scope

- **Settings & Data Management UI**:
  - Persistent Settings dialog accessible from the top navigation bar.
  - One-click backup export (`job-tracker-backup-YYYY-MM-DD.tar.gz`) combining
    the SQLite database (cleanly checkpointed via `wal_checkpoint(TRUNCATE)`),
    generated resume artifacts, and candidate profile, strictly excluding `.env.local`.
  - Safe restore with schema integrity verification and automated pre-restore
    rollback snapshot.
  - Safe "Clear All Jobs" board reset action protected by a confirmation dialog.
  - AI model status check, model switcher, and OpenRouter test connection ping.
  - Candidate profile status display with "Re-sync Master Resume" action.
- **Legacy Removal & Clean Cutover**:
  - Complete deletion of retired Python runtime, `.venv/`, `services/`,
    PostgreSQL migrations, `docker-compose.yml`, Python scripts, and Python tests.
  - Zero remaining references to PostgreSQL, Python, Docker, or Nimbalyst.
  - Modernized `README.md` with single-command local run (`npm run dev`).
- **User-Led Acceptance**:
  - Human walkthrough verifying intake, scraping, AI tailoring with Top 5
    ATS keywords, resume approval, application tracking, and backup/restore.

### Explicit non-goals

- No PostgreSQL data migration (dropped per user decision).
- No automated heavy end-to-end test suite for cutover (verified via user manual walkthrough).

### Acceptance evidence

- Settings modal in `AppHeader.tsx` opens and displays backup, model, profile, and storage statistics.
- Downloading a backup produces a valid, uncorrupted archive that restores cleanly.
- Board reset clears jobs and extractions without errors and leaves schema intact.
- Repository scans confirm zero Python files, zero PostgreSQL configs, and zero running Docker dependencies.
- `npm run dev` and `npm test` pass cleanly with zero dead-reference errors.

## R6 — UI/UX design polish

### Outcome

The accepted product presents a precise, calm, dense-but-breathable interface:
clear scan paths on every surface, a consistent spacing rhythm, one functional
icon scale, and restrained motion that confirms state changes — with zero
behavior change.

### Scope

- Implement `ui-ux-design-spec.md` §§1–6 across the board, job card, card
  drawer, resume review, settings modal, and app header surfaces.
- Spacing/layout pass for visibility: shared grids, tight card internals,
  generous section separation, bounded viewports at 1280×800 through 4K.
- Interaction pass: transform/opacity-only motion per the spec timing table,
  focus management, keyboard paths for drag operations, live-region
  announcements, and `prefers-reduced-motion` support.

### Explicit non-goals

- No behavior, route, API, or data-flow changes.
- No color, font-family, or type-scale token changes.
- No UI label renames: R5-C verifies labels verbatim.
- No MVP scope expansion (no discovery, scheduling, cloud sync, email,
  autofill, or new board columns).

### Acceptance evidence

- Every `ui-ux-design-spec.md` §6 checklist item is proven with the exact
  verification run and result, including light/dark themes, 1280×800 and 4K
  viewports, keyboard-only operation, reduced motion, and interruption safety.
- The project's own tests for every touched area pass; no committed test is
  narrowed, skipped, or rewritten to fit the change.
- R5-C checklist steps still pass verbatim against the polished UI.

## Cross-milestone release rules

- Keep the old test oracle until the corresponding TypeScript parity suite is
  accepted.
- Do not combine a schema migration, mass data import, and legacy deletion in
  one irreversible step.
- Never mark a milestone complete on mocked coverage alone when its acceptance
  calls for a real local browser, document render, restart, or human review.
- Every scope increase belongs in this product contract before implementation;
  coding agents do not silently add cloud sync, discovery, autofill, or new
  board columns.
