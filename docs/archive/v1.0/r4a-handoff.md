# R4-A Handoff — Candidate import and immutable snapshots

```text
Work order: R4-A (Candidate import and immutable snapshots)
Outcome: implemented — versioned master-resume import schema/command, candidate
         repository, canonical hashing, profile activation, immutable
         candidate/JD snapshot service with get-or-create semantics, reviewed
         synthetic seed conversion, CLI, and tests.
Status: accepted
Files changed:
  new: src/domain/canonical.ts, src/domain/candidate.ts, src/db/candidates.ts,
       src/server/candidates.ts, drizzle/0002_candidate_snapshot_dedupe.sql,
       scripts/import-candidate.mjs, tests/fixtures/candidate/master-resume.v1.json,
       tests/fixtures/candidate/README.md, tests/unit/domain/canonical.test.ts,
       tests/unit/domain/candidate.test.ts, tests/unit/server/candidates.test.ts,
       tests/unit/scripts/import-candidate.test.ts
  mod: src/db/schema/candidates.ts (unique index), src/db/utils.ts
       (sha256HexUtf8), package.json (candidate:import script),
       eslint.config.mjs (.next-e2e ignore),
       drizzle/README.md (generate-merge note), tests/unit/db/migrate.test.ts
       + startup.test.ts (3-file baseline), status.md
Migrations/data effects: 0002 adds UNIQUE(candidate_snapshots.version, sha256);
  additive, existing rows untouched. No data migration.
Verification performed and exact result:
  - npx tsc --noEmit: clean, 0 errors
  - npx eslint .: clean, 0 errors (.next-e2e added to ignores)
  - npx vitest run: 72 files / 418 tests green
  - npx playwright test: 7/7 tests green
  - node scripts/check-project-context.mjs: consistent
Acceptance criteria not yet proven: Real-profile authoring with production candidate
  data (fixture is synthetic); profile UI (deferred to future milestone).
Decisions or deviations:
  - Canonical bytes follow arch section 3 exactly; they are intentionally
    NOT byte-compatible with the oracle's ad-hoc json.dumps form (which
    lacks NFC/LF/fail-closed rules). R5-A imports data, never hashes.
  - preferences/standard_answers (work-auth, compensation) are excluded
    from the import schema: the MVP never auto-answers those questions.
  - Reused fact_ids across versions require byte-identical content;
    conflicts fail with zero writes (test-proven rollback).
  - Stale-analysis rejection proper belongs to R4-C/E; R4-A provides the
    current-snapshot resolution primitive they build on.
Safety/human checkpoint: importer stores exactly what the reviewed file
  declares (default PENDING); activation is an explicit human-attributed
  action; no routes/UI added, so no new web attack surface. Bash sandbox
  on; no legacy code touched.
```

## What was built

- `src/domain/canonical.ts` (pure): `canonicalJson` (sorted keys, NFC/LF
  strings, finite numbers; throws on NaN/Infinity, bigint, undefined,
  functions, symbols, Dates, cyclical or non-plain objects) and
  `canonicalText` (NUL-strip, NFC, CRLF→LF, trim — the oracle's
  strip/trim plus the NFC/LF quote contract).
- `src/domain/candidate.ts` (pure): `CandidateImportV1`
  (`candidate-import/v1`), `CandidateProfilePayloadV1`
  (`candidate-profile/v1`), `FactEvidenceV1` (`fact-evidence/v1`),
  `CandidateSnapshotV1` (`candidate-snapshot/v1`). Strict shapes, real
  calendar dates, current/past employment consistency, unique
  employment ids and fact_ids, dangling-reference rejection.
- `src/db/candidates.ts`: thin sync repository — profile root, version
  numbering/insert/list/get, single-active activation, fact
  insert/get/list, PENDING-only review transition, snapshot
  insert/lookup/membership, JD snapshot lookup, job description
  pointers, extraction ownership.
- `src/server/candidates.ts`: `importCandidate` (validate → immutable
  version + facts; pre-checks all conflicts before writing, so
  rejection leaves zero rows — the first test run caught a partial
  commit here and the service was restructured), `activateProfileVersion`
  (idempotent, human actor), `getActiveProfile` (null = setup state),
  `getOrCreateCandidateSnapshot` (self-contained canonical JSON:
  full payload + approved facts ordered by fact_id, membership mirror,
  insert-or-reselect on the new unique index),
  `getOrCreateJdSnapshot` (canonical text hash, reuse by (job, hash),
  fail-closed on empty text and cross-job extractions),
  `resolveCurrentSnapshots` (active-version + active-extraction
  resolution with PROFILE_REQUIRED / EXTRACTION_INCOMPLETE /
  STALE_INPUT reason codes for the R4-E worker).
- `drizzle/0002_candidate_snapshot_dedupe.sql` (+ schema `unique()`):
  `(profile_version_id, sha256)` idempotency for concurrent
  web/worker snapshot creation. README notes the next `db:generate`
  merge step.
- `scripts/import-candidate.mjs` (`npm run candidate:import -- <file>
  [--activate] [--json]`): human-operated importer over the ignored
  data root (convention: `data/candidate/master-resume.json`), 1MB
  file cap, exit 2 usage / 1 failure / 0 success.
- `tests/fixtures/candidate/master-resume.v1.json`: reviewed
  field-by-field conversion of `db/seeds/001_candidate_seed.sql`
  (fact_001–006 preserved verbatim; employment UUIDs become stable
  `emp-*` slugs). Synthetic, like the seed — never real career data.

## Oracle parity notes (for R4-B/C)

Ported behaviors: approved-only snapshot inventory ordered by fact_id
(`context.py`), JD upsert by (job, content hash) (`repository.py`),
current-input staleness comparison shape (`pipeline.py` preconditions
1–3), verbatim fact binding expectations (`validator.py`). Deliberate
non-ports: wording variants (deferred per reuse-map), fit scoring,
`default=str` coercion (fail-closed instead).

## For the user

To onboard a real profile: copy the fixture to
`data/candidate/master-resume.json` (ignored), replace every value with
reviewed real data, then run
`npm run candidate:import -- data/candidate/master-resume.json --activate`.
