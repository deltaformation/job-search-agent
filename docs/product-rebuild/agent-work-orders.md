# Coding-Agent Work Orders

## How to use this document

Each coding session owns one work order. Read the rebuild README, architecture,
reuse map, milestone containing the work, and the relevant current code before
editing. Verify repository state; never treat this plan as evidence that earlier
work is complete.

Work orders describe acceptance boundaries and likely file ownership, not a
license to overwrite user changes. If the actual tree differs, inspect and adapt
while preserving the boundary.

Every handoff must contain:

```text
Work order:
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

## R0 work orders

### R0-A — Preserve the current baseline

**Owns:** read-only audit, existing Python tests, preservation recommendation.

**Deliver:** an exact inventory of dirty M7/M8 changes, current test results,
database migration state when safely inspectable, and a recoverable checkpoint
approved by the user.

**Do not:** delete, reset, clean, or rewrite dirty files; run human-only resume
approval or application-outcome commands.

**Done when:** the current work can be recovered independently of the working
tree and its verified/unverified status is stated accurately.

### R0-B — Remove Nimbalyst and active references

**Depends on:** R0-A.

**Owns:** `.nimbalyst/`, `nimbalyst-local/`, Nimbalyst checker/test, README and
agent-guide references.

**Deliver:** deletion of Nimbalyst runtime/project-control files, clean neutral
documentation links, and a regression check for active references.

**Do not:** remove Python/PostgreSQL runtime code or candidate/artifact data.

**Done when:** R0 acceptance gates pass and no required agent instruction points
at deleted files.

## R1 work orders

### R1-A — Node/Next application scaffold

**Owns:** `package.json`, lockfile, Next/TypeScript/Tailwind configuration,
`app/`, initial shared styles, and basic component/test configuration.

**Deliver:** accessible local shell, error boundary, loading state, and pinned
toolchain scripts without product logic.

**Coordinate:** establish package/config files before other Node work orders
that need to edit them. Later dependency additions should be narrow follow-ups.

### R1-B — SQLite schema and repository foundation

**Owns:** `src/db/**`, `drizzle/**`, database test helpers.

**Deliver:** initial schema from the architecture table, connection pragmas,
migration runner, short transaction helpers, constraints/triggers, and fresh/
repeat startup tests.

**Do not:** transliterate PostgreSQL migrations or add tables for deferred
briefing/autofill features.

### R1-C — Domain contracts and state machines

**Owns:** `src/domain/**` and pure domain tests.

**Deliver:** Zod schemas and pure transitions for board, scrape, tailoring,
approval, artifacts, and versioned JSON payloads. Include correction semantics
and conflict/version tokens.

**Do not:** import Next, Drizzle, Playwright, or provider SDKs into domain code.

### R1-D — Local supervisor, storage, and security

**Owns:** root startup scripts, `src/security/**`, storage/path utilities, and
startup/security tests.

**Deliver:** migrations + web/worker supervision, graceful signals, safe data
roots, loopback/Origin/Host/CSRF policy, headers, and redacted structured logs.

**Depends on:** the entrypoint contracts from R1-A and migration command from
R1-B.

## R2 work orders

### R2-A — URL policy and intake service

**Owns:** URL parsing/canonicalization modules, intake application service, and
unit/contract tests.

**Deliver:** per-line validation, original/canonical URLs, dedupe keys, SSRF
preflight, transactional enqueue, and reason codes.

**Reuse:** port cases from `normalizer.py` and `deduplicator.py`; keep original
URLs even when canonical URLs match.

### R2-B — Queue leasing and worker dispatch

**Owns:** `src/queue/**`, worker dispatcher, lease/retry tests.

**Deliver:** atomic claim, lease expiry, heartbeat if necessary, bounded retry,
idempotent completion, stale recovery, and graceful shutdown.

**Constraint:** all external async work occurs outside SQLite transactions.

### R2-C — Playwright fetcher and network guard

**Owns:** browser lifecycle, request interception, safe redirect/DNS checks,
bounded capture, and browser fixtures/tests.

**Deliver:** one isolated browser context per job or equivalent safe isolation;
blocked login/CAPTCHA/access results; HTML/text/JSON-LD capture.

**Do not:** use stealth, stored login sessions, CAPTCHA services, proxy rotation,
or branded user profiles.

### R2-D — Extraction adapters and normalization

**Owns:** adapter interface, site adapters, JSON-LD and generic fallback,
normalization, confidence/missing-field report, extraction fixtures.

**Deliver:** deterministic extraction precedence and no invented placeholder
facts. Unknown values stay null/unknown and are visible to the user.

### R2-E — Intake and attempt UI

**Owns:** URL intake components/routes, batch progress, per-line validation and
attempt views.

**Deliver:** paste/prepare UX, duplicate/invalid feedback, live or refreshable
queue state, retry action, and links to evidence/errors.

**Depends on:** stable commands/queries from R2-A/B/D.

### R2-F — 1-Click Authenticated Browser Clipper and Direct DOM Intake

**Owns:** `app/api/intake/clip/route.ts`, `src/server/clip.ts`, `extensions/clipper/*`, and manual content fallback in `/attempts/[id]`.

**Deliver:**
- Primary 1-click intake flow: clips rendered job postings directly from the user's active desktop browser (past any CAPTCHA/login challenges naturally).
- `POST /api/intake/clip`: receives `{ url, html, title?, selectedText? }`, canonicalizes URL, enforces URL policy, writes immutable raw HTML artifact with SHA-256 hash, runs R2-D extraction synchronously, and inserts `NEW` job.
- Unpackaged Chrome/Brave Manifest V3 clipper extension in `extensions/clipper/` for seamless capture without mixed-content or CORS blocks.
- Draggable bookmarklet on `/intake`.
- Content paste fallback on `/attempts/[id]` when an automated scrape records `CAPTCHA_REQUIRED` or `EXTRACTION_INCOMPLETE`.
- Tests for URL policy, duplicate deduplication, extraction, and evidence persistence.

**Do not:**
- Access or store user browser cookies, auth tokens, or session credentials.
- Automate form-filling or application submission.

## R3 work orders

### R3-A — Workflow command service

**Owns:** status application service, workflow/application repositories, and
transition integration tests.

**Deliver:** transactional event + status updates, optimistic concurrency,
Tailored gate, Applied modal contract, correction/reopen command, and notes.

### R3-B — Board queries and card detail API

**Owns:** read models, query routes, pagination/filtering, and serialization
tests.

**Deliver:** five-column board projection and complete safe card detail without
leaking arbitrary file paths or unescaped raw markup.

### R3-C — Kanban and card detail UI

**Owns:** board/card/detail React components and UI tests.

**Deliver:** accessible pointer and keyboard drag/drop, alternative status
menu, optimistic rollback, card detail tabs, notes, history, and Applied modal.

**Depends on:** R3-A/B contracts. Do not change server state rules in UI code.

## R4 work orders

### R4-A — Candidate import and immutable snapshots

**Owns:** candidate import schema/command, candidate repository, snapshot
service, and tests.

**Deliver:** reviewed conversion of current candidate facts without fabrication,
stable `fact_id` values, canonical hashing, active version selection, and
immutable JD/profile snapshots.

### R4-B — Shared parity fixtures

**Owns:** runtime-neutral JSON fixtures and temporary Python fixture harness.

**Deliver:** cases for claim validation, rank ordering, keyword coverage,
tenure/summary derivation, view-model ordering, and stale snapshot rejection.

**Done when:** fixtures run against the current Python oracle and record expected
outputs. Do this before porting algorithms, not after.

### R4-C — TypeScript truthfulness core

**Owns:** pure modules under `src/tailoring/**` for requirements, provenance,
ranking, keywords, summary, and validation.

**Deliver:** TypeScript results matching R4-B plus adversarial tests for new
MVP inputs.

**Do not:** call an agent/provider or write files/database from these modules.

### R4-D — Canonical resume view model and renderers

**Owns:** `src/resumes/**`, trusted HTML/DOCX templates, render tests.

**Deliver:** one canonical view model, Markdown, DOCX, HTML/PDF rendering,
autoescape/CSP, artifact hashes, text parity, page/overflow checks, and visual
fixtures.

**Reuse:** current standard template design, view-model rules, browser selection,
and security tests. The DOCX path is new work.

### R4-E — Local agent adapter and tailoring orchestration

**Owns:** `TailoringProvider`, command adapter, test provider, orchestration,
queue handler, structured audit summaries.

**Deliver:** argv-based provider invocation with time/output limits, versioned
JSON schema validation, immutable input envelope, deterministic validator call,
reason-coded failures, and no shell evaluation.

**Do not:** persist chain-of-thought, accept provider approval/path/hash fields,
or couple domain code to one agent vendor.

### R4-F — Resume review and approval UI/service

**Owns:** review commands/routes/components and approval integration tests.

**Deliver:** side-by-side proposal/evidence/gap review, artifact preview/download,
revision request, exact-version human approval, hash binding, and automatic
human-attributed transition to `TAILORED`.

**Depends on:** R3-A and R4-A/C/D/E.

## R5 work orders

### R5-A — PostgreSQL read-only importer

**Owns:** isolated import tool and mapping tests.

**Deliver:** dry-run/commit modes into a new SQLite file, stable ID mapping,
explicit legacy status mapping, artifact digest verification, ambiguity report,
and JSON manifest.

**Do not:** mutate PostgreSQL, overwrite an existing SQLite database, or treat a
legacy hash/signature as human consent without the associated review evidence.

### R5-B — Backup and restore

**Owns:** backup/restore commands, manifest, integrity tests, and user docs.

**Deliver:** consistent SQLite + evidence + artifact snapshot and verified
restore. Destructive restore requires explicit confirmation and pre-restore
backup.

### R5-C — End-to-end acceptance and visual QA

**Owns:** Playwright product tests, realistic fixtures, document visual/text QA,
restart/crash scenarios, and accessibility checks.

**Deliver:** evidence for all 12 MVP acceptance steps in the rebuild README.
Keep external-site tests opt-in and reason-code restrictions honestly.

### R5-D — Final legacy removal and documentation cutover

**Depends on:** R5-A/B/C accepted.

**Owns:** retired Python/PostgreSQL/MCP/Starlette/bridge/application-copilot code,
dependencies, operational docs, root README, and final dead-reference checks.

**Deliver:** Node/SQLite-only active runtime and concise setup/operation docs.

**Do not:** delete current candidate data or generated artifacts; do not remove
the temporary parity oracle until R4 parity acceptance is recorded.

## Parallelism guide

- R1-B and R1-C can proceed after R1-A establishes the project configuration;
  R1-D integrates them and should follow their public contracts.
- R2-A, R2-B, and R2-C can run in parallel after R1; R2-D depends on the fetch
  envelope from R2-C; R2-E depends on stable intake/query contracts.
- R3-A and R3-B can run in parallel if repository interfaces are agreed first;
  R3-C follows them.
- R4-A and R4-B can run in parallel. R4-C follows R4-B. R4-D can begin from the
  existing view model/template. R4-E integrates R4-C, and R4-F integrates all.
- R5-A and R5-B can run in parallel. R5-C follows the integrated product.
  R5-D is always last.

Agents working concurrently must use separate branches/worktrees when their
changes might overlap. No two agents should edit `package.json`, the same
migration, or the same generated lockfile at the same time.
