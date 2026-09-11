# Product and Architecture Contract

## 1. Product boundary

The product prepares and tracks applications. It does not search the web for
jobs and it does not apply on the user's behalf.

### In scope

- Multiline URL intake with validation, canonicalization, and deduplication.
- SQLite-backed work queue with retryable scrape and tailoring jobs.
- Public-page extraction using allowlisted site adapters, JSON-LD, and a
  generic Playwright fallback.
- Preservation of submitted URL, final URL, raw page evidence, extraction
  output, and error details.
- Normalized job records and a five-column persistent Kanban.
- A versioned local candidate profile made from verified facts.
- Structured job requirement analysis and explicit supported/gap results.
- A pluggable local-agent adapter that returns schema-validated proposals.
- Truthful resume rendering to Markdown, DOCX, and PDF.
- Exact-version human approval and auditable manual status changes.
- Local preview/download/open actions constrained to the artifact directory.
- Backup and restore of the SQLite file plus artifact/evidence directories.

### Out of scope

- Job-board search, discovery scans, alerts, briefings, and scheduled runs.
- Authentication, CAPTCHA handling, stealth plugins, proxy rotation, or any
  attempt to evade board protections.
- ATS form filling, resume upload automation, legal/work-authorization answers,
  self-identification answers, or final application submission.
- Email or calendar ingestion.
- Multiple users, remote collaboration, or required cloud services.
- Browser-based rich document editing.
- Arbitrary prompt-authored resume claims or arbitrary user HTML templates.

## 2. Target topology

Use a modular monolith with a separate local worker process. Both processes are
started and stopped by one root command.

```text
Local browser
    │
    ▼
Next.js UI + server routes (127.0.0.1 only)
    │
    ├── commands/queries ───────────────┐
    │                                  │
    ▼                                  ▼
SQLite/Drizzle                    local artifact store
    ▲                                  ▲
    │                                  │
    └── leased work queue ── Node worker
                               ├── Playwright scraper
                               ├── extraction adapters
                               ├── local-agent adapter
                               └── resume renderers
```

The web process must not host a long-running worker inside a request handler or
development hot-reload lifecycle. A small supervisor starts the web and worker
processes, runs migrations, creates storage directories, forwards shutdown,
and fails clearly if either required process cannot start.

Recommended target layout:

```text
app/                         Next.js routes and pages
components/                  React components
src/
  db/                        Drizzle schema, migrations, repositories
  domain/                    pure contracts and state machines
  server/                    application services and route helpers
  queue/                     leasing, retry, and worker dispatch
  scraping/                  URL policy, Playwright, adapters, extraction
  tailoring/                 agent contract, validation, requirement mapping
  resumes/                   view model, templates, renderers, artifacts
  security/                  loopback, CSRF, path and URL policy
  worker/                    worker entrypoint and handlers
drizzle/                     reviewed SQL migrations
data/rebuild/                ignored target-runtime data root
  job-tracker.sqlite         SQLite database
  evidence/                  content-addressed raw page evidence
  artifacts/                 immutable generated resume versions
scripts/                     setup, local supervisor, migration/import tools
tests/                       unit, contract, integration, and end-to-end tests
legacy/                      temporary only during verified migration
```

Do not move the existing Python tree into `legacy/` merely for cosmetic
reorganization. Keep it in place until a cutover work order owns its removal;
Git history is the long-term archive.

Pin Node.js 24 LTS for the first production baseline. The host currently has a
Node.js 26 Current release, but a native SQLite dependency should not be tied to
a Current line until the complete dependency set and clean-install path are
verified. Record the selected version in `.nvmrc` and `package.json` engines.

Use `@dnd-kit/core` plus its sortable utilities for the board, and
`docxtemplater` with a trusted checked-in template for DOCX generation. Pin
actual package versions in the lockfile during R1/R4 rather than encoding
floating versions in this architecture document.

Only the Node runtime may open the target SQLite database. Keep native SQLite
dependencies external to the Next.js server bundle, do not access the database
while prerendering/building, and compile the worker as a distinct entrypoint.
Development and tests use isolated temporary data roots; they never open the
user's normal database or artifact directories.

## 3. Runtime and persistence rules

- SQLite is the only product database after cutover.
- Enable foreign keys, WAL mode, and a bounded busy timeout on every connection.
- Use short synchronous transactions. Never keep a `better-sqlite3`
  transaction open across `await` or external work.
- Use checked-in, ordered SQL migrations generated/reviewed through Drizzle.
- Store timestamps as UTC ISO-8601 text and render them in the user's locale.
- Store currency amounts in integer minor units when an amount is parseable;
  preserve the original salary string regardless.
- Store structured JSON as text only behind versioned Zod schemas.
- Canonical hashes use UTF-8, Unicode NFC, LF line endings, lexicographically
  sorted object keys, UTC timestamps, and finite JSON numbers. Arrays retain
  semantic order. Reject `NaN`, infinities, ambiguous dates, and unversioned
  serialization rather than producing unstable bytes.
- Large raw HTML and generated documents live on disk; SQLite stores relative
  paths, media types, byte sizes, and SHA-256 hashes.
- Resolve every stored path beneath an explicit data root. Reject absolute
  paths, traversal, and symlinks for trusted artifacts.
- Publishing a file and its database row is a recoverable protocol: reserve an
  ID/path, write and fsync a temporary file on the same filesystem, hash it,
  atomically rename it, then commit its metadata in a short transaction. A
  startup reconciler removes or quarantines abandoned temporary/orphan files
  and reports metadata whose file is missing; it never silently blesses either.
- Backups use SQLite's online backup API (with WAL checkpoint coordination),
  then copy content-addressed evidence/artifacts and a hash manifest to staging.
  Restore validates the staged set before replacing anything and creates a
  pre-restore backup. A raw copy of a live SQLite file is not a supported backup.

## 4. Core data model

The first SQLite baseline should model the following concepts. Names may be
refined in implementation, but splitting raw evidence, normalized state, and
AI output is mandatory.

| Table | Purpose | Important invariants |
|---|---|---|
| `intake_batches` | One multiline paste operation | Stable batch ID and counts; partial failure is representable |
| `intake_items` | Every submitted line before it becomes a job | Preserves input/order and invalid/duplicate/blocked outcome plus reason |
| `jobs` | Normalized job and board state | Current status/rank, `row_version`, and active extraction/resume pointers |
| `job_sources` | Submitted/canonical/final/apply URLs and source identity | Every submitted URL retained; canonical key indexed; sources may merge |
| `scrape_attempts` | Every fetch attempt and outcome | Failures are inspectable and never erase prior success |
| `source_artifacts` | Raw HTML/text/JSON-LD file metadata | Content-addressed relative path, media type, size, and SHA-256 |
| `job_extractions` | Immutable parsed output from one attempt | Version/schema/parser lineage; active pointer changes without overwrite |
| `work_items` | Durable scrape/tailor queue | Unique idempotency key; lease token; bounded retry; cancellation/fencing |
| `work_attempts` | Every execution of any queued item | Append-only timing, worker, input/output hashes, result, and error |
| `workflow_events` | Append-only board/status history | Actor, from/to, rank, row version, timestamp, reason, metadata |
| `job_notes` | Optional user notes | User-authored and separate from extracted evidence |
| `candidate_profiles` | Candidate identity root | One local profile; missing profile is a setup state, not a boot failure |
| `candidate_profile_versions` | Reviewed structured profile versions | Immutable typed source payload; one explicitly activated version |
| `candidate_facts` | Verified achievement/claim facts | Immutable `fact_id`, typed source, verification and version membership |
| `candidate_snapshots` | Immutable generation inputs | Canonical JSON plus schema/version/SHA-256 |
| `jd_snapshots` | Immutable job-description inputs | Exact text plus canonical bytes/hash and extraction lineage |
| `job_analyses` | Structured requirements and gaps | Bound to exact JD/profile snapshots and proposal attempt |
| `resume_versions` | Immutable structured resume versions | Parent, analysis, template/ranker/policy/config lineage and review state |
| `resume_claims` | Claim-level fact provenance | Every claim cites approved facts or a reconstructable derivation |
| `resume_artifacts` | Markdown/DOCX/PDF metadata | All three created before review; unique kind and digest per version |
| `resume_reviews` | Append-only human review actions | Request revision/approve with actor, time, note, and exact hashes |
| `applications` | Human-recorded application metadata | Manual source, applied time, optional confirmation number |

Use database constraints and triggers for invariants that must survive a bug in
application code: immutable extraction/snapshot/resume payloads, immutable
approved facts, unique version numbers per job, unique artifact kind per resume
version, valid active pointers, and append-only workflow/review/attempt events.
Foreign keys from rendered claims to snapshot membership must prevent a claim
from citing a fact that was not in the exact bound profile snapshot.

## 5. State model

Board state and background processing state must not be conflated.

### Board state

```text
NEW → TAILORED → APPLIED → INTERVIEWED
 │       │          │            │
 └───────┴──────────┴────────────┴──→ REJECTED
```

- A successful scrape creates a `NEW` job.
- Only an explicit human approval of an exact resume version may transition
  `NEW` to `TAILORED`.
- `TAILORED` to `APPLIED` is a human action and records `applied_at`; a
  confirmation number is optional.
- `APPLIED` to `INTERVIEWED` or `REJECTED` is manual.
- `INTERVIEWED` to `REJECTED` is an ordinary manual outcome. `NEW` or
  `TAILORED` may also move to `REJECTED` when the user decides not to apply.
- Corrections and reopening are performed through an explicit correction action
  requiring a note; they are not silent arbitrary drag transitions.
- Every card has a persistent rank within its column. Move commands carry the
  observed `row_version`; status, rank, event, and incremented version commit in
  one compare-and-swap transaction or return a conflict.

### Scrape state

`QUEUED → RUNNING → SUCCEEDED | FAILED | BLOCKED`

### Tailoring state

`PENDING | BLOCKED → RUNNING → AWAITING_REVIEW → APPROVED | REVISION_REQUESTED | FAILED`

A failed worker state remains visible on a card in its current board column.
Retries create new attempts/events rather than mutating history.

Every successful new extraction idempotently requests tailoring. When no active
reviewed profile or provider configuration exists, the job remains `NEW` and
tailoring becomes `BLOCKED` with a reason code and manual retry action. Rejecting
or superseding a job cancels/fences its queued work: completion must compare the
lease token, input hashes, job `row_version`, and active snapshot pointers before
attaching output. Stale work may be retained as an unattached attempt but can
never resurrect or mutate the job.

## 6. URL and scraper safety

Treat every submitted URL and page as hostile input.

- Accept only public `http` and `https`. Preserve a public non-HTTPS application
  URL as evidence, but show a warning and require an explicit human open action;
  never silently upgrade or discard it.
- Reject embedded credentials, nonstandard local schemes, invalid hostnames,
  and URLs resolving to loopback, private, link-local, multicast, or reserved
  addresses.
- Enforce the public-address decision at connect time through a controlled
  resolver/proxy or equivalent address pinning, not only a preflight lookup.
  Revalidate every redirect and cover navigation, subresources, popups,
  downloads, service workers, WebSockets, and mixed DNS answers so rebinding
  cannot reach local services.
- Retain the submitted URL before canonicalization. Strip known tracking
  parameters only for the canonical dedupe key.
- Rate-limit by origin and bound batch size, URL length, redirects, time,
  response bytes, rendered text, and retry count.
- Stop with a reason-coded result when a login, CAPTCHA, access-denied page, or
  robots/terms restriction is encountered. Never add stealth or bypass logic.
- Prefer adapters for common public ATS pages, then `JobPosting` JSON-LD, then
  generic semantic/meta extraction. Preserve the generic fallback's confidence
  and missing fields rather than inventing them.
- One URL failure must not abort other submitted URLs.
- Dedupe twice: canonicalize before fetch to avoid duplicate work, then compare
  source identity and normalized extraction signals after fetch. A merge keeps
  every intake item, submitted URL, source, and attempt. Byte-identical raw
  evidence is stored once by content hash and referenced from every observation.

Minimum reason codes: `INVALID_URL`, `DUPLICATE_URL`, `PRIVATE_NETWORK`,
`LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `ACCESS_DENIED`, `TIMEOUT`,
`EXTRACTION_INCOMPLETE`, `UNSUPPORTED_PAGE`, `PROFILE_REQUIRED`,
`PROVIDER_UNAVAILABLE`, and `STALE_INPUT`.

## 7. Tailoring and artifact contract

The agent is a proposal generator, never the authority for facts, approval, or
stored paths.

```ts
interface TailoringProvider {
  prepare(input: TailoringInputV1): Promise<ResumeProposalV1>;
}
```

`TailoringInputV1` is constructed server-side from immutable candidate and JD
snapshots. `ResumeProposalV1` contains structured requirement mappings,
proposed claim selections/wording, keyword placements, gaps, and a concise
rationale summary. Do not request or persist hidden chain-of-thought.

Every provider attempt records provider/model identity, executable/config
version, prompt and schema versions, canonical input/output hashes, start/end
times, exit/result metadata, a bounded user-facing rationale, unanswered
candidate questions, and a structured proposed change set. LLM calls are not
described as deterministic: reproducibility starts only after an exact validated
proposal is bound to exact snapshots and policy/template/ranker versions. A
retry is a separate immutable attempt (or an explicit reuse of a cached accepted
proposal), never a rewritten call.

Before rendering, deterministic code must verify:

- every cited `fact_id` exists in the bound candidate snapshot and is approved;
- every requirement quote exists in the bound JD snapshot;
- quote offsets select the exact UTF-8/NFC/LF-normalized JD substring; any
  display whitespace normalization is versioned and cannot change what is cited;
- unsupported/gap requirements produce no resume claim;
- metrics, employers, roles, dates, credentials, and technologies are present
  in the cited fact or an allowlisted deterministic derivation;
- agent output cannot choose a template path, output path, approval status,
  artifact hash, or claimed coverage score;
- stale JD/profile inputs require a new analysis/version;
- an approved wording variant predates and belongs to the exact candidate
  profile version used to create the resume;
- revisions create a new immutable version.

Candidate onboarding imports a versioned, schema-validated master-resume JSON
file from an ignored local path. The UI previews typed identity/contact,
employment, education, skills, credentials, and achievement sources before a
human activates a version. Achievement and rendered-claim sources receive
stable `fact_id` values; contact or identity fields are not disguised as claim
facts. The app may boot without a profile and shows `PROFILE_REQUIRED` until one
is reviewed and activated.

One canonical resume view model feeds Markdown, DOCX, and PDF renderers. Content
parity tests must compare all three projections. PDF may use the existing
reviewed HTML/CSS design and Playwright; DOCX uses a trusted checked-in template.
If a PDF is generated through a different renderer than DOCX, the extracted text
and claim inventory must still match the canonical view model.

Generation creates a new immutable `AWAITING_REVIEW` resume version and publishes
its Markdown, DOCX, and PDF artifacts before review. Approval does not generate,
replace, or edit files: it re-hashes the existing three artifacts, records an
append-only review bound to the resume/content/artifact hashes, marks that exact
version approved, and moves the job to `TAILORED` in one transaction. Revision
requests also append a review and lead to a new child version. Possession of a
hash, CSRF token, UI session, or localhost access is not consent.

The port must preserve the detailed legacy resume invariants: templates are
presentation-only (no script, `contenteditable`, injected candidate content, or
external assets); default section budgets are 5 summary bullets, 3 bullets per
role, and 14 experience bullets total unless a reviewed typed config changes
them; keyword coverage uses exact evidence-qualified variants; summaries persist
`calculation_as_of` and a manifest capable of byte reconstruction; wording
variants obey review chronology; and every version records analysis, template,
ranker, policy, provider-attempt, and parent lineage. The parity suite covers
these limits, ties, stale inputs, chronology, claim inventory, and all formats.

## 8. Local web security

Localhost is not a trust boundary.

- Bind only to `127.0.0.1` by default.
- Enforce allowed `Host` and `Origin` values and CSRF protection for mutations.
- Send restrictive CSP, frame, content-type, and referrer headers.
- Never serve arbitrary filesystem paths. Artifact/evidence IDs resolve through
  database metadata and an allowlisted root.
- Escape all job-page content in the UI.
- Do not put agent commands, page text, or file paths through a shell string.
- Redact secrets and unnecessary candidate PII from logs.
- Destructive reset/import actions require an explicit UI/CLI confirmation and
  create a backup first.

## 9. Local operation

After the one-time install/setup step, the supported commands are:

```text
npm run dev       development web + worker with graceful shutdown
npm run build     reproducible production build
npm run start     migrations + production web + worker
npm test          unit and integration suite
npm run test:e2e  Playwright product acceptance suite
```

The bootstrap path creates `data/evidence` and `data/artifacts`, applies pending
migrations, verifies the candidate profile and templates, checks the browser
runtime, and reports a single actionable error when a prerequisite is missing.
It must not silently start PostgreSQL, migrate user-wide agent settings, or
download dependencies during normal startup.

## 10. Architectural seams for future features

Keep these as interfaces but do not implement them in MVP:

- discovery sources beyond pasted URLs;
- scheduling and notifications;
- fit scoring and prioritization;
- additional agent providers;
- application assistance beyond opening the original URL;
- external backup/sync.

This preserves expansion paths without carrying the current product's full
surface area into the first cutover.
