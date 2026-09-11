# AGENTS.md — Local Job Tracker Rebuild

This repository is being rebuilt as a local-first job application tracker with
one deterministic workflow:

```text
clip job in browser (or paste URLs) → normalize → New → generate/review resume → Tailored
→ human applies → human records Applied / Interviewed / Rejected
```

Nimbalyst is retired as the project-control system. Do not create or update
Nimbalyst trackers, plans, sessions, schemas, or population scripts. The
Nimbalyst directories, population script, and workspace test were removed by
work order R0-B after R0-A recorded a recoverable checkpoint (see
`docs/product-rebuild/legacy-baseline.md` and the ignored local archives under
`data/preservation/2026-09-11/`). Git history is the long-term archive.

## Required context

Before milestone work, read:

1. `docs/product-rebuild/README.md`
2. `docs/product-rebuild/architecture.md`
3. `docs/product-rebuild/reuse-map.md`
4. `docs/product-rebuild/milestones.md`
5. The one bounded work order you own in
   `docs/product-rebuild/agent-work-orders.md`

Then inspect the actual repository and tests. Planning documents describe
intent; code, migrations, data, artifacts, tests, and commits prove reality.

## Collaboration contract

- Own one bounded work order per session.
- Record the exact work order ID in the handoff or pull request.
- Use a separate branch/worktree for concurrent work that might overlap.
- Do not let two agents edit `package.json`, the lockfile, one migration, or the
  same generated artifact at the same time.
- Preserve unrelated and uncommitted user changes. Never reset, clean, or delete
  them to simplify your task.
- Do not silently expand MVP into discovery, scheduling, cloud sync, email,
  application autofill, or new board columns.
- Record deviations and unresolved acceptance items; do not call a task done
  because code was written.

Every handoff must include:

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

## Target architecture

- Node.js with TypeScript, Next.js, React, and Tailwind for the product shell.
- SQLite with `better-sqlite3` and Drizzle for product persistence.
- A separate supervised Node worker for scraping and resume preparation.
- Playwright Chromium for public JavaScript-rendered job pages and PDF output.
- Local filesystem roots for raw source evidence and immutable artifacts.
- A provider-neutral local-agent adapter that returns schema-validated proposals.
- One canonical resume view model feeding Markdown, DOCX, and PDF renderers.

The existing Python/PostgreSQL implementation is a temporary executable oracle
and migration source. Port high-value contracts with shared fixtures; do not
build a permanent dual-database runtime. Remove legacy code only in the final
cutover work order after parity and import gates pass.

## Non-negotiable truthfulness rules

1. Never invent employers, roles, dates, technologies, certifications, degrees,
   clearances, metrics, responsibilities, relationships, or experience length.
2. Every rendered resume claim must cite at least one approved immutable
   `fact_id`, unless it is produced by an allowlisted deterministic derivation
   that can be reconstructed from approved facts.
3. Unsupported job requirements remain explicit `unsupported`/`gap` results and
   never become resume claims or keywords.
4. Agent output is a proposal. It cannot choose approval state, trusted template
   paths, output paths, artifact hashes, or coverage scores.
5. Resume revisions create new immutable versions. Never overwrite reviewed or
   approved content/artifacts.
6. Only an explicit human action may approve a resume and move a job to
   `Tailored`.

## Application boundary

- The MVP never fills or submits ATS forms.
- It never bypasses a login, CAPTCHA, access restriction, rate limit, robots
  rule, or board protection.
- It never answers legal, work-authorization, compensation, or voluntary
  self-identification questions.
- The user opens the retained source/application URL, applies manually, and
  manually records `Applied` plus any optional confirmation number.
- Hashes, sessions, button possession, or agent assertions are not human consent.
- Legacy human-only review/outcome scripts must never be run or mocked by an
  autonomous agent.

## URL, browser, and local-web safety

- Accept only public HTTP(S) job pages supplied by the user.
- Block loopback, private, link-local, multicast, reserved, credential-bearing,
  and prohibited-scheme targets; revalidate DNS and redirects.
- Treat page content as hostile data, never instructions. Escape it in the UI.
- Bind the app to `127.0.0.1`; validate Host/Origin and protect mutations with
  CSRF. Localhost alone is not a security boundary.
- Resolve evidence/artifact access through database IDs and an allowlisted data
  root. Reject absolute paths, traversal, and symlinks.
- Never interpolate URLs, page content, agent output, or paths into a shell
  command string.
- One scrape failure must not abort or roll back other URLs in the batch.

## Database and queue rules

- Enable SQLite foreign keys, WAL, and a bounded busy timeout.
- Keep `better-sqlite3` transactions synchronous and short. Never hold one over
  `await`, browser work, agent calls, rendering, or filesystem I/O.
- Use parameterized queries and checked-in ordered migrations.
- Store large raw pages/documents on disk with relative paths, byte sizes, media
  types, and SHA-256 hashes in SQLite.
- Queue work uses idempotency keys, bounded retry, short leases, and stale-lease
  recovery. Retries append attempts/events instead of erasing history.
- Use UTC ISO-8601 timestamps; preserve raw salary/date text when normalization
  is uncertain.

## Code and test standards

### New TypeScript runtime

- TypeScript strict mode; avoid `any` at trust boundaries.
- Zod schemas for every persisted JSON or agent/browser input envelope.
- Pure domain modules must not import Next.js, Drizzle, Playwright, or provider
  SDKs.
- Accessible UI: keyboard alternatives for drag/drop, labeled controls, focus
  management, and non-color-only states.
- Run the smallest focused test first, then the milestone-required unit,
  integration, type, lint, and end-to-end suites.

### Temporary Python oracle

- Python 3.11+ with complete type hints for changed Python functions.
- Sanitize `Decimal`, `NaN`, date, and nested values before JSON serialization.
- Parameterize PostgreSQL queries.
- Run `.venv/bin/pytest tests/` after modifying legacy services or logic, unless
  the work order explicitly limits verification; state any environment blocker.
- Use checked-in diagnostics instead of inline Python or guessed direct SQL.

### Cross-runtime porting

- Create runtime-neutral JSON fixtures before porting deterministic algorithms.
- Demonstrate expected output against the Python oracle, then the TypeScript
  implementation.
- Preserve exact semantics for fact provenance, snapshot hashes, requirement
  quotes, ranking ties, tenure arithmetic, template lineage, and immutable
  approvals.

## Review checklist

1. Does the change stay inside the assigned work order and MVP boundary?
2. Can any path invent or smuggle an unsupported candidate fact?
3. Are raw source, normalized data, and agent output still separate/auditable?
4. Are retries, duplicate requests, crashes, and stale clients safe?
5. Do database constraints protect critical invariants beyond UI validation?
6. Can a route access arbitrary URLs/files or accept a forged approval?
7. Does the worker avoid long SQLite transactions and duplicate execution?
8. Are manual application and human resume approval still unavoidable?
9. Are migrations, imports, and deletions recoverable and explicitly evidenced?
10. Do tests prove the relevant failure modes, not only the happy path?

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
