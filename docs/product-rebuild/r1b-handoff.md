# R1-B Handoff — SQLite Schema and Repository Foundation

Status: accepted 2026-09-11. Branch: `rebuild/r1-platform` (R1-A + R1-B
files uncommitted in working tree; R0 checkpoint is commit `de8a533` on `main`).

## Outcome

Drizzle + better-sqlite3 foundation: 24-table schema from the architecture
data model, a two-file reviewed migration baseline (generated tables plus
hand-authored trigger guards), connection policy (foreign keys, WAL, bounded
busy timeout), an idempotent migration runner with drift detection, short
nest-safe transaction helper, temp-directory test helper, and 39 database
tests. No product services yet; nothing outside tests opens a database.

## Added pins (exact, in package.json + package-lock.json, 649 packages)

drizzle-orm 0.45.2, better-sqlite3 13.0.3 (prebuilt binary, SQLite 3.53.4),
drizzle-kit 0.31.10 (dev), @types/better-sqlite3 9.6.0 (dev). One new script:
`db:generate` (drizzle-kit generate). Node baseline unchanged: 24.x.

## Schema notes for reviewers

- All 22 architecture tables are present, plus two join tables the mandated
  claim invariant requires: `candidate_snapshot_facts` (snapshot membership)
  and `resume_claim_facts` (normalized citations; JSON arrays cannot be
  foreign-keyed). `source_artifacts` stays per-attempt (no join table);
  byte-identical evidence shares files by content hash at the storage layer.
- `jobs.active_extraction_id` / `active_resume_version_id` have no Drizzle FK
  (circular pair); triggers enforce existence plus same-job ownership.
- `scrape_attempts` / `work_attempts` are written once at completion;
  in-flight work lives in `work_items` (lease held iff RUNNING, CHECKed).
  `workflow_events` order is the SQLite rowid (documented in schema).
- Wording variants table intentionally absent (reuse-map defers it to a later
  phase with its review UX).
- `0000_*.sql` is pristine `drizzle-kit generate` output; `0001_*` is the
  reviewed trigger/index companion. `drizzle/README.md` records the ordering
  rule (rename the next generated file to `0002_*`, update the journal).

## Verification evidence (all on Node v24.21.0)

- `tsc --noEmit`: exit 0.
- `eslint .`: exit 0, no output.
- `vitest run`: 9 files, 41/41 passed (40 new DB tests + 1 R1-A scaffold
  test). Covers: pragmas/policy, fresh + repeat startup, restart persistence,
  migration atomicity and drift, FK/enum/unique violations, append-only and
  immutability triggers, approval freezing, activation rotation, same-job
  pointers/lineage, NULL pointer clearing, claim membership + approval
  gating, and transaction commit/rollback/nesting.
- `node scripts/check-project-context.mjs`: consistent (16 files, 9
  entrypoints, harness absent).
- better-sqlite3 smoke: `new Database(':memory:')` + `sqlite_version()`
  returns 3.53.4.
- Not rerun: `next build` (R1-B adds no UI/bundle code; R1-A build evidence
  stands) and the legacy Python suite (no Python touched).

## Decisions and deviations

- `npm view`/`npm install` needed `NPM_CONFIG_CACHE=/tmp/npm-cache-r1b`
  because `~/.npm/_cacache` contains root-owned files (pre-existing
  environment issue, unrelated to this work).
- One test-expectation fix during the run: citing an unknown `fact_id` raises
  the trigger's membership error, not a FK error, because BEFORE INSERT
  triggers fire first. The row is still rejected; the test now asserts that.
- `applications.recorded_by` has a single-value `IN ('human')` CHECK as
  defense-in-depth for the manual-application boundary; R3-A still owns the
  service-level human confirmation.

## Review findings disposition (2026-09-11)

1. Missing `WHEN` on `trg_jobs_check_active_resume_update` — confirmed at
   `0001:238-245`, fixed by adding `WHEN NEW.active_resume_version_id IS NOT
   NULL`. Edited pre-acceptance (the file never touched a durable database;
   only ephemeral test DBs), consistent with the drizzle/README drift rule.
   Regression test `allows clearing active pointers back to NULL` added to
   `constraints-relational.test.ts`. Proof: a scratch repro against the old
   SQL aborts the NULL update with `active resume version must belong to the
   same job`; the fixed suite is 41/41 green. All other WHEN-less guards in
   `0001` were scanned: they operate on NOT NULL columns or carry inline
   NULL checks, so this was the only instance.
2. Node 26 default shell vs the 24.x pin — all acceptance verification ran
   on v24.21.0 via explicit PATH (unchanged). Informational extra: the full
   suite also passes 41/41 under the default v26.2.0 with the
   better-sqlite3 13.0.3 prebuild, so no ABI break is observed for this pin;
   the 24.x baseline stands regardless. No code change; future sessions keep
   using `nvm use 24` or the Node 24 binary path.
3. Vite `configLoader: 'native'` warning — no change. It is cosmetic (suite
   green), both proposed fixes touch R1-A-owned toolchain surface, and
   `"type": "module"` flips module resolution repo-wide for a future-facing
   note. Noted for a later toolchain pass instead.

## Next ready work

R1-C (domain contracts + state machines) can proceed now; it should mirror the
CHECK value lists in this schema with Zod enums. R1-D (supervisor, storage,
security) is unblocked on the R1-B migration command once this is accepted.
R1-B's `ensureDatabase()` takes an explicit `migrationsDir` so the R1-D
supervisor can wire it to the production data root.
