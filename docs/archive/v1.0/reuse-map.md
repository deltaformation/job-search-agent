# Current-Code Reuse and Decommission Map

## 1. Baseline finding

The current repository is not an early prototype. It contains roughly 21,000
lines across services, migrations, scripts, and tests, including a 2,500-line
PostgreSQL repository and a 700-line MCP server. The working tree also contains
large uncommitted Milestone 7 and Milestone 8 changes. The rebuild must begin
with a preservation checkpoint; deleting Nimbalyst or the Python tree first
would destroy planning context and potentially lose tested resume work.

The right reuse strategy has three forms:

1. **Direct asset reuse** for templates, candidate data, fixtures, and test
   cases that are runtime-independent.
2. **Contract porting** for deterministic Python logic that should become
   pure TypeScript domain modules.
3. **Quarantine then removal** for PostgreSQL, orchestration, Nimbalyst, and
   features outside the new MVP.

Do not build a permanent Python/PostgreSQL compatibility layer. It would leave
two databases, two migration systems, and two sources of workflow truth. A
temporary read-only import tool is acceptable during cutover.

## 2. Preserve and port into the MVP

| Current asset | Reuse decision | Target use |
|---|---|---|
| `services/discovery/normalizer.py` | Port behavior and fixtures | URL cleaning, title/location normalization, content hashing |
| `services/discovery/deduplicator.py` | Port selected signals | Canonical URL, direct URL/source identity, normalized company/title/location, content hash |
| `services/discovery/scraper.py` sanitization/error isolation | Port contract, not JobSpy loop | Per-URL failure isolation and JSON-safe normalization |
| `services/intelligence/models.py` | Port relevant schemas | Requirement importance, match status, evidence IDs, analysis validation |
| `services/intelligence/context.py` | Port snapshot/context envelope ideas | Immutable `TailoringInputV1`; exact JD and candidate facts |
| `services/documents/validator.py` | High-priority port | Claim-to-`fact_id` validation and explicit gaps |
| `services/documents/keywords.py` | High-priority port | Coverage-first fact ranking and honest keyword report |
| `services/documents/summary.py` | High-priority port | Reconstructable summary derivations and unioned tenure calculation |
| `services/documents/view_model.py` | High-priority port | Single projection feeding every resume renderer |
| `services/documents/templates/mouad_standard_v1.html.j2` | Reuse design/CSS after review | Trusted HTML/PDF template; remove Jinja-specific coupling as needed |
| `config/resume.yaml` | Convert to typed config | Template ID/version and page/bullet budgets |
| `services/documents/renderer.py` | Reuse security and QA behavior | Autoescape, CSP, known browser, PDF text/hash checks |
| `services/documents/pipeline.py` | Port preconditions and lineage | Snapshot binding, stale-input rejection, immutable versions, human review state |
| migrations `001`, `002`, `009`, `014` | Re-model concepts in a fresh SQLite baseline | Candidate facts, JD/profile snapshots, analysis lineage, resume/template lineage |
| `db/seeds/001_candidate_seed.sql` | Export through a reviewed importer | Initial local candidate profile and immutable fact IDs |
| document/provenance tests | Convert into language-neutral fixtures, then TypeScript tests | Parity oracle for claims, summary, ranking, HTML, hashes, and approvals |
| `services/ui/security.py` | Port the protections | Loopback bind, origin/host guard, CSRF, security headers |
| `services/applications/readiness.py` artifact validation | Port only file/digest checks | Approved-artifact binding, path traversal/symlink rejection |
| ATS HTML fixtures | Keep as scraper/extraction fixtures where useful | Public page extraction tests, not application automation |

The current implementation remains the executable oracle while each contract is
ported. For pure deterministic functions, create shared JSON fixture cases that
both Python and TypeScript can execute during the migration. Delete the Python
version only after parity is demonstrated.

## 3. Preserve for a later product phase, not MVP

| Current capability | Why deferred | Preservation approach |
|---|---|---|
| JobSpy multi-board discovery | New scope starts from pasted URLs | Keep in Git history and document the future source-adapter seam |
| Fit scoring | Useful, but not needed for the core prepare/track loop | Preserve scorer fixtures and weights for a later prioritization milestone |
| Morning briefing and scheduler | Explicitly outside pasted-URL MVP | No SQLite tables or UI in the first baseline |
| Agent discovery kickstart (M7) | Designed for automated search sessions | Harvest its exact-snapshot context contract; defer queue UX |
| MCP read/query tools | Potentially useful local integration | Reintroduce only a small TypeScript MCP adapter after the product API stabilizes |
| Wording variants | Strong truthfulness feature but adds review UX | Keep schema seam disabled until a dedicated human review workflow exists |
| Application field policy | Valuable threat model | Keep policy documentation/fixtures; no form planning or filling in MVP |

## 4. Quarantine and remove

These assets should not be translated into the new runtime.

| Asset | Disposition | Removal gate |
|---|---|---|
| `.nimbalyst/` | Delete | Current M7/M8 changes preserved and replacement docs committed |
| `nimbalyst-local/` | Delete | Milestone decisions/reuse facts captured in this rebuild package |
| `scripts/populate_nimbalyst.py` | Delete | Nimbalyst directories removed |
| `tests/test_nimbalyst_workspace.py` | Delete | Replacement agent instructions validated by review |
| Nimbalyst references in `README.md`, `CLAUDE.md`, `GEMINI.md`, and docs | Remove or mark historical only | Product-rebuild context is canonical |
| `services/ui/` Starlette dashboard/control center | Delete after UI parity | Next.js card detail, actions, and local security are accepted |
| `services/briefing/` and scheduled scan scripts | Remove from active runtime | URL-intake MVP acceptance passes |
| `integrations/antigravity/` bridge/outbox | Delete after local agent adapter exists | Provider-neutral command adapter passes contract tests |
| Application copilot browser/form-fill services and tools | Quarantine, then delete from MVP branch | Manual-application flow and regression guard pass |
| FastMCP server and 31 generated schemas | Retire at cutover; selectively rebuild later | No production path depends on it |
| PostgreSQL `JobRepository`, migrator, migrations, Docker Compose, psycopg config | Remove after verified import | SQLite import counts/hashes and rollback backup are accepted |
| Python operational scripts | Remove as their product action is replaced | Equivalent supported UI/root command exists or feature is explicitly deferred |

Git history is the archive. Do not keep a second runnable legacy application in
the final tree unless a concrete support requirement justifies it.

## 5. Data mapping from PostgreSQL to SQLite

The importer should be read-only against PostgreSQL and write into a new empty
SQLite database. It must be idempotent by stable legacy IDs and produce a JSON
manifest with source counts, destination counts, skipped rows, and hashes.

### Import in MVP

- Candidate profile, work history, approved achievements/`fact_id` values,
  verified skills, education, credentials, and relevant preferences.
- Jobs and all source URLs/raw payloads that can be represented honestly.
- Job and JD snapshots.
- Structured analyses and requirement evidence needed by retained resumes.
- Resume versions, lineage fields, review events, and existing artifact paths
  only when the file exists and its hash verifies.
- Human-recorded applications and status history, mapped explicitly to the new
  five-column board.

### Do not import as active MVP state

- Schedule locks, discovery observations, agent-run orchestration, shortlist
  reservations, briefing sessions, UI sessions/actions, and bridge deliveries.
- Form snapshots, field plans, fill actions, application attempts, and browser
  checkpoints.

Those rows may be summarized in the migration manifest for audit, but they must
not create active product behavior.

### Legacy status mapping

Never guess ambiguous state silently. Use this default mapping and emit every
ambiguous row for human review:

| Legacy status | New board status |
|---|---|
| `NEW`, `QUALIFIED`, `SHORTLISTED`, `REVIEW`, `REVIEWED`, `TAILORING` | `NEW` |
| `READY`, `APPLICATION_STARTED`, `WAITING_FOR_HUMAN` | `TAILORED` only with a verified approved resume; otherwise `NEW` |
| `SUBMITTED` | `APPLIED` only with a human-recorded application outcome; otherwise review required |
| `SCREEN`, `INTERVIEW`, `FINAL`, `OFFER`, `ACCEPTED` | `INTERVIEWED` with the original legacy status retained in event metadata |
| `SKIPPED`, `REJECTED`, `EXPIRED`, `WITHDRAWN` | `REJECTED` with a reason code retaining the distinction |

## 6. Known migration traps

- The current PostgreSQL schema uses JSONB, UUID helpers, lateral joins,
  functions, and trigger syntax that cannot be copied into SQLite unchanged.
  Create a fresh SQLite schema from domain invariants.
- PostgreSQL currently computes freshness at read time. The pasted-URL tracker
  does not need freshness buckets for its primary board; preserve posted dates
  and compute display age in application code if useful.
- Existing workflow states are much richer than the five-column board. Always
  retain the legacy state in migration-event metadata.
- The current resume engine mainly produces HTML/PDF. DOCX is a new renderer,
  not an existing capability.
- A local web page cannot safely expose arbitrary `file://` paths. Resolve
  preview/download/reveal actions through artifact IDs and the allowlisted data
  root.
- Next.js development reloads can start code more than once. The worker must be
  a separate supervised process with SQLite leases and idempotency keys.
- `better-sqlite3` transactions are synchronous; network, browser, agent, and
  file-rendering work must happen outside the transaction.
- Raw pages may contain prompt injection, executable markup, tracking content,
  and PII. They are evidence, never instructions, and are escaped in every UI.

## 7. Preservation checkpoint before deletion

Before the first destructive cleanup, the owning agent must:

1. Record `git status --short` and identify every uncommitted user change.
2. Run the existing focused M7/M8 tests and full Python suite if the local
   database prerequisites are available.
3. Preserve the current work in a user-approved commit/branch or another
   explicit recoverable checkpoint.
4. Copy any still-relevant decision or acceptance detail into this neutral
   rebuild package.
5. Confirm that deletion targets are exactly `.nimbalyst/`, `nimbalyst-local/`,
   the population checker, its test, and active references—not generated resume
   artifacts or candidate data.

Only then may the Nimbalyst exit work order delete files.
