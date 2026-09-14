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
