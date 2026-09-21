# Active Architecture Decisions

This is the decision log for the rebuild. Earlier Python/PostgreSQL decisions
are historical unless explicitly carried forward here. A decision changes only
through a new entry that names what it supersedes; do not rewrite old decisions
to make history look cleaner.

## R-ADR-001 — Repository-native project harness

**Status:** accepted, 2026-09-11

Use `PROJECT.md`, `AGENTS.md`, the versioned rebuild documents, one bounded work
order per session, Git branches/worktrees, tests, and commit/PR evidence. Do not
replace Nimbalyst with another generated tracker or a second Kanban for software
delivery. Product-board data lives in SQLite; project delivery evidence lives in
Git and the concise rebuild status page.

**Supersedes:** legacy ADR-007 (Nimbalyst control plane).

## R-ADR-002 — TypeScript/SQLite modular monolith

**Status:** accepted, 2026-09-11

Build the product shell and deterministic core in a Node.js 24 LTS TypeScript
application using Next.js, React, Tailwind, Drizzle, and `better-sqlite3`. Run a
separate local worker under the same supervisor command. SQLite and the local
artifact/evidence roots become the only product persistence after cutover.

**Supersedes:** legacy PostgreSQL-as-final-runtime and Starlette-control-center
decisions. PostgreSQL remains read-only migration input until R5.

## R-ADR-003 — Port contracts, not infrastructure

**Status:** accepted, 2026-09-11

Treat the Python implementation as a temporary executable oracle. Build
runtime-neutral fixtures, prove Python outputs, and make the TypeScript port pass
the same cases. Do not create a permanent Python sidecar, dual-write path, or
PostgreSQL compatibility layer. Delete an oracle only after its parity gate.

## R-ADR-004 — Raw evidence, normalized data, and agent output are separate

**Status:** accepted, 2026-09-11

Persist source URLs/raw page evidence, normalized job fields, and structured
agent proposals as distinct versioned layers. Corrections never rewrite the raw
observation. Page content is hostile evidence and never an instruction source.

## R-ADR-005 — Board state is not worker state

**Status:** accepted, 2026-09-11

The product board has exactly `New`, `Tailored`, `Applied`, `Interviewed`, and
`Rejected`. Scrape and tailoring states have their own reason-coded lifecycles
and appear as card metadata. Failures do not create columns or silently move
cards.

## R-ADR-006 — Human approval binds an exact resume version

**Status:** accepted, 2026-09-11

An agent may propose structured content but cannot approve it. The server
derives trusted template/output paths and validates facts, requirements, hashes,
and lineage. One explicit human command approves the exact resume/artifact
digests and transitions the job to `Tailored`. Revisions are new immutable
versions. The application itself remains manual.

**Carries forward:** strict `fact_id` provenance, immutable resume versioning,
evidence-qualified keywords, reconstructable summaries, and human consent.

## R-ADR-007 — Public user-supplied URLs only

**Status:** accepted, 2026-09-11

MVP ingestion begins only from URLs pasted by the user. Use public ATS adapters,
`JobPosting` JSON-LD, and a generic Playwright fallback under SSRF, redirect,
rate, time, and size controls. Stop at authentication, CAPTCHAs, access denial,
or explicit restrictions; never add bypass or stealth behavior.

## R-ADR-008 — Provider-neutral structured agent boundary

**Status:** accepted, 2026-09-11

The first real provider is a local command adapter invoked with an argv array,
JSON on standard input, a minimal environment, output/time limits, and no shell.
Core modules depend only on versioned input/output schemas. Store concise
rationale fields and validation evidence, never hidden chain-of-thought.

## R-ADR-009 — One canonical resume projection

**Status:** accepted, 2026-09-11

One snapshot-bound canonical view model feeds Markdown, DOCX, and PDF. The
trusted existing HTML design may be ported for PDF and a trusted DOCX template
is added. Cross-format extracted-text and claim-inventory tests prevent content
drift; byte-identical DOCX/PDF files are not required when renderer metadata is
nondeterministic.

## R-ADR-011 — Queue attempt history is append-only; retries extend budget

**Status:** accepted, 2026-09-12

`work_attempts` rows are never deleted or rewritten, and `work_items.attempt_count`
never decreases: it is the next attempt's number under the unique
`(work_item_id, attempt_number)` key. A human retry of a FAILED item therefore
grants its fresh bounded budget by extending `max_attempts`
(`attempt_count + 3`), never by resetting the counter — resetting collided with
kept history on the next completion or stale-lease recovery and crash-looped
`npm run dev` (fixed 2026-09-12 in `src/queue/leases.ts`, uncommitted).

## R-ADR-010 — Automatic preparation stops at review

**Status:** accepted, 2026-09-11

A successful scrape creates the `New` card and idempotently enqueues tailoring
when an active verified candidate profile and provider configuration exist. If
either prerequisite is absent, the card remains `New` with a reason-coded
blocked tailoring state. Automation ends at `AWAITING_REVIEW`; no automatic
approval, application navigation, form filling, or submission follows.

## R-ADR-012 — Multi-profile candidate persistence

**Status:** accepted, 2026-09-14

`candidate_profiles` holds multiple named career tracks (unique slug, one
default flag, work preferences, executive narrative) instead of a single
implicit profile. Profile versions, snapshots, facts, and resume lineage
key off the owning profile row, while version immutability, fact-id
uniqueness, activation, and the human review protocol are unchanged.
Preferences steer tailoring emphasis only and never become resume claims.
Implemented in migration `0005_multi_candidate_profiles` (`WO-1.1-E`,
`WO-1.1-G`).

## R-ADR-013 — Interactive tailoring envelope

**Status:** accepted, 2026-09-14

Human tailoring guidance — the selected career profile id, up to 20
selected ATS keywords, and up to 1000 chars of directive notes — rides the
`tailor-queue/v1` payload and the `tailoring-input/v1` envelope, and is
hashed into `job_analyses.input_hash` with the rest of the inputs. Guided
runs use a guidance-scoped idempotency key so new guidance enqueues a fresh
run while identical guidance dedupes. Providers must treat guidance as
ranking/wording steering subordinate to the evidence rules: claims still
require approved `fact_id` citations and gaps stay gaps. Implemented in
`WO-1.1-H`.

## R-ADR-014 — Direct cloud providers (Google AI Studio & Meta Muse)

**Status:** accepted, 2026-09-14

Tailoring and salary-fact extraction may call Google AI Studio and Meta
Muse directly through REST client adapters (`scripts/google-client.mjs`,
`scripts/meta-client.mjs`) returning the same schema-validated JSON the
OpenRouter path produces. `ACTIVE_AI_PROVIDER` (`openrouter` default,
`google`, `meta`) routes all provider calls; keys live only in
`.env.local` (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `META_API_KEY`) and
are never persisted, logged, or returned to clients — the UI sees
fingerprints and a ping diagnostic. Cloud providers stay strictly
optional: without a key the app boots, tailoring blocks with a reason
code, and the deterministic no-key fallback keeps the pipeline testable.
Implemented in `WO-1.1-F`.

## R-ADR-015 — Explicit user-started generation

**Status:** accepted, 2026-09-14 (`WO-1.2-A`)

**Supersedes:** R-ADR-010 (automatic tailoring enqueue after extraction).
R-ADR-010's remaining rules — automation ends at `AWAITING_REVIEW`, no
automatic approval, application, navigation, form filling, or
submission — carry forward unchanged.

A successful scrape/extraction stores the JD, makes guidance available,
and enqueues nothing. Resume generation starts only through an explicit
user command (`Generate resume` / `Generate new version`) carrying
complete guidance. `jobs.tailoring_state` gains a `READY` preparation
state (extracted JD available, no run queued or running); stored
`PENDING` means an explicit request is queued awaiting worker claim,
and the UI never renders stored `PENDING` as queued work unless a
`QUEUED` work item exists. `READY` is a preparation state, never a
board column. Migration and command implementation belong to `WO-1.2-D`;
see [`lifecycle-contracts-v1.2.md`](lifecycle-contracts-v1.2.md).

## R-ADR-016 — Profile-owned master sources

**Status:** accepted, 2026-09-14 (`WO-1.2-A`)

**Amends:** R-ADR-012 (multi-profile persistence). Profile rows,
version immutability, activation, and preference-steering rules are
unchanged; only source-document ownership changes.

Each career profile owns its active master version and source document
history: source bytes live immutably beneath the allowlisted data root
with profile/version-owned metadata, and every upload, preview, export,
and read API takes database IDs and validates ownership. The single
global source file is retired as a write target; existing profiles
migrate from their stored active payloads as authoritative, and the
legacy file is preserved as evidence where applicable — never assigned
to every profile. Uploading, editing, previewing, or exporting profile
B never requires changing the global default away from A. Implemented
by `WO-1.2-B` (migration `0006`) and surfaced by `WO-1.2-C`.

## R-ADR-017 — Snapshot-bound guidance and steering

**Status:** accepted, 2026-09-14 (`WO-1.2-A`)

**Amends:** R-ADR-013 (interactive tailoring envelope). Guidance still
rides queue → provider input → hashed lineage as subordinate
ranking/wording steering; what changes is binding and durability.

Every explicit generation request persists an immutable server-built
guidance record at submission: concrete profile version id, JD snapshot
id, frozen steering (executive narrative plus the relevant
work-preference metadata), selected keywords with canonical set
semantics, directive text, revision note when relevant, parent version,
and a request identity. The same validated snapshot travels through
queue, worker, provider prompt, and version history; retries preserve
it, and later default/profile changes never retarget a queued run.
Deduplication is by request identity, not guidance content: a retry or
double-submit reuses the operation identity, while a deliberate later
request creates a new version even with unchanged guidance. Stale
inputs abort attachment with an actionable message; inputs are never
silently rebuilt from current defaults. Implemented by `WO-1.2-D`.

## R-ADR-018 — Draft, approval, and application identity are separate pointers

**Status:** accepted, 2026-09-14 (`WO-1.2-A`)

**Amends:** the single-pointer practice around
`jobs.active_resume_version_id` (latest published version). No prior
ADR defined that pointer; this decision freezes the three meanings
that later agents must not re-merge.

- `jobs.active_resume_version_id`: latest published version (draft
  pointer), still written only at publish time.
- `jobs.selected_resume_version_id` (new, `WO-1.2-D` migration): the
  approved version selected for application, written only by the
  approval transaction, `NULL` until the first approval.
- `applications.resume_version_id` (new nullable, `WO-1.2-D`
  migration): the approved version bound when a human manually records
  an application; `NULL` means "not recorded" (all legacy rows and any
  record made with no selected version — never inferred).

From `New`, approving an eligible exact version moves the job to
`Tailored` and sets the selected pointer. From `Tailored`, approving a
newer exact version updates the selected pointer and leaves the board
status. On `Applied`/`Interviewed`, new drafts and exact-version review
stay possible but cannot change the recorded application row; any
replacement approval is recorded separately. `Rejected` jobs need the
existing explicit reopen/correction before new generation. Approval
still re-hashes the exact three artifacts and validates fact evidence;
generation alone never moves `New` to `Tailored`.

## R-ADR-019 — Decline is terminal; revise opens guidance without running

**Status:** accepted, 2026-09-14 (`WO-1.2-A`)

**Extends:** R-ADR-006 (human approval binds an exact version).
Approval semantics are unchanged; the revision/decline side gains an
explicit contract.

`Decline version` records a terminal decision on an eligible
awaiting-review version: it requires a human note, appends review
history, sets a terminal `DECLINED` review state (new value, `WO-1.2-D`
migration), queues nothing, and leaves board column, drafts, approvals,
and application rows untouched. `Revise` opens the guidance form for
editing and starts no run until the user submits a complete new-version
request (parent version, revision note, full guidance). Creating a
draft never implicitly declines another draft or revokes an approval.
Eligible older awaiting-review versions stay reviewable while their
JD/profile inputs are current; stale ones stay previewable with a clear
explanation and a new-version action. Implemented by `WO-1.2-D`.

## R-ADR-020 — Shared career history by explicit copy with provenance

**Status:** accepted, 2026-09-14 (`WO-1.2-A`)

**Amends:** the single-owner sharing behavior of `importCandidate`
(identical `fact_id` content silently reuses one globally owned fact
row across profiles). No prior ADR defined fact reuse.

`fact_id` stays a globally unique primary key, and every existing
fact row, snapshot, membership row, claim citation, artifact, and
review stays exactly as stored. Reusing career history in another
profile or version inserts new fact rows with new minted fact ids —
ordinary form entry never requires the user to hand-author ids — each
carrying explicit provenance (origin profile/version/fact plus evidence
equality). User-authored JSON imports keep declared-verification
governance (default `PENDING`); any altered statement needs fresh
review. The `Create from existing profile` operation (B6) is the one
explicit path that retains verification: it copies an immutable source
version's unchanged evidence with its verification states, records the
source profile/version on every copied fact, and lands in an
independent draft that requires explicit human activation — it never
upgrades a state (`PENDING`/`REJECTED` stay), never copies generated
resumes, approvals, or application history, and later edits on either
side never cross over. Silent sharing — profile B's import
transparently reusing profile A's fact row, verification included, with
no lineage — is forbidden. Within one lineage, the existing rules
stand: same id plus identical content reuses, same id plus different
content conflicts and must mint a new id. Snapshot membership remains
per owning version, so the claim-to-snapshot foreign-key guards hold
unchanged. Implemented by `WO-1.2-B`.

## R-ADR-021 — Workspace drafts use revision CAS, independent of job CAS

**Status:** accepted, 2026-09-16 (`WO-1.3-A`)

Each job owns at most one mutable tailoring draft
(`tailoring_workspaces`), versioned by a monotonically increasing
`revision` exposed as a quoted strong ETag `"tw:{jobId}:{revision}"`.
`GET` on an absent workspace returns `200` with a null body and a
revision-0 ETag without inserting anything; `PUT` requires exactly
one `If-Match` (absent → `428`, malformed/wildcard/list → `400`,
wrong job/revision → `412 WORKSPACE_CONFLICT`). Job
optimistic-concurrency stays separate through `jobs.row_version`
(`409 JOB_CONFLICT`); a workspace save never bumps the job version
and never touches queue/review state. Autosave chains on the
returned revision and stops with retained input on `412`.

**Extends:** R-ADR-017 (immutable guidance binding). The workspace is
the editable staging area; submission (G) freezes it into immutable
request inputs, after which later edits cannot retarget the run.

## R-ADR-022 — Generation binds an immutable input extension; the worker never reads the workspace

**Status:** accepted, 2026-09-16 (`WO-1.3-A`)

**Amends:** R-ADR-017 storage (guidance still rides queue →
provider → hashed lineage; what changes is where the frozen v1.3
inputs live). R-ADR-017's request-identity dedup and stale-input
rules are unchanged.

Every `G` submission inserts one immutable
`tailoring_request_inputs` row alongside the generation request:
workspace revision, submit hash, workflow input hash, candidate
snapshot, full focus, full recommendations, and the frozen
`master-text/1` projection. Updates and deletes are refused by
trigger; later workspace saves cannot alter the row. The worker
verifies and executes only this frozen input — it never consults
the mutable workspace revision. The v3 queue payload wraps the
byte-identical v2 request object with the workflow input hash, and
the v2 reader, v2 hash bytes, and `genreq:v1:` identity are
preserved unchanged for historical work.

## R-ADR-023 — Progress is fenced boundary events with stable attempt timing

**Status:** accepted, 2026-09-16 (`WO-1.3-A`)

**Supersedes:** the standalone `WO-POST-J-ELAPSED` plan, folded
into `WO-1.3-F` per the v1.3 release invariants. Salary extraction
stays an independent follow-up.

Each attempt emits at most five append-only boundary events
(`PREPARING_INPUTS` … `PUBLISHING_RESULT`) under the live lease
tuple `{workItemId, attemptId, leaseToken}` with an expiry and
current-attempt predicate; expired leases can neither renew,
complete, emit, nor publish. Event source (`provider`/`cached`)
is constant per attempt, and cached recovery says it loads a
saved proposal. Elapsed time derives from the persisted attempt
`started_at` plus trusted server time — never from component
mounts, poll ticks, or per-second writes — and resets per attempt.
No timer-driven stages or percentages exist; slow stages display
waiting states until an authoritative boundary or failure lands.
Failures map to the closed `Failure.code` set with safe,
actionable envelopes; unknown raw errors map to `INTERNAL` with
server-private detail.

## R-ADR-024 — Generation-time assessment without composite scores

**Status:** accepted, 2026-09-16 (`WO-1.3-A`)

Every published version commits one immutable `assessment/1`
record with exactly four measures (`selected_keywords`,
`supported_requirements`, `document_checks`,
`evidence_integrity`), each side `assessed` (numerator ≤
denominator) or `not_assessed` with an explicit reason. Zero
eligible items and unavailable baselines are `not_assessed`, never
`0%` or `100%`; deltas exist only when both sides are assessed
over the same eligible IDs. No composite ATS/Overall score exists:
provider- or browser-supplied scores fail validation and can
never set measures. The mockup's illustrative 45%/+37/82% KPI is
explicitly non-production fixture data. Assessment compares the
frozen master projection against the canonical tailored text;
insights derive from recorded diff/coverage/budget/gap rows with
no extra AI call, and any evidence-integrity failure blocks
publication.

## R-ADR-025 — Full-page tailor route with drawer parity cutover

**Status:** accepted, 2026-09-16 (`WO-1.3-A`)

**Extends:** R-ADR-005 (five board columns are unchanged; this
decision governs the tailoring surface, not board state).

Production tailoring and review live at `/jobs/[id]/tailor`, a
full page implementing the verified four-step flow (full JD,
focus, progress, exact-version review) with Properties/Notes
surfaces. The legacy drawer tailoring/review controls stay
operational until `WO-1.3-H` proves parity, then are removed;
normal job Properties/Notes access is retained throughout.
`/mockup` remains the interaction reference only — production
must never import its fixtures, simulations, or sample PDF. Board
cards gain one batched lookup resolving the selected approved
PDF artifact for Download Resume, with explicit
unavailable/error states and no latest-draft fallback.

## R-ADR-026 — User-authored tailoring text is allowed with explicit provenance

**Status:** accepted, 2026-09-18 (Step 2 correction decision)

**Amends:** R-ADR-024 evidence-integrity interpretation and the S2-A
`step2-claims/1` generation gate for new-format inputs. Historical rows and
hashes are unchanged.

The user is authoritative for text they deliberately edit in the Step 2
workspace. New-format generation therefore preserves that text verbatim and
does not block it because machine evidence is absent. The server labels each
included segment as `VERIFIED_SOURCE`, `USER_ACCEPTED_AI` or `USER_EDITED`
from its immutable origin, saved operation and exact text; providers and public
payloads cannot assign these states. User-authored and user-accepted AI text
retain contextual fact and JD-priority anchors but are not described or counted
as machine-verified. The review surface shows their provenance, and later
explicit human approval remains required before the resume becomes selected.

AI proposals must link exact same-plan JD priorities, valid candidate anchors
and server-derived eligible roles. Selecting an unchanged proposal records
user acceptance without converting the proposal into verified evidence.
Editing master or proposal text records `USER_EDITED`. These operations affect
only the job-local immutable version; they never mutate candidate facts, the
master resume or another job. Structural safety, ownership, size, immutable
binding, CAS and artifact-integrity checks still apply.
