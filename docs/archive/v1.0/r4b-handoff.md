# R4-B Handoff — Shared parity fixtures

```text
Work order: R4-B (Shared parity fixtures)
Outcome: implemented — 79 runtime-neutral JSON cases across 6 suites pinning
         the Python oracle (claim validation, rank ordering, keyword
         coverage, tenure/summary derivation, view-model ordering, stale
         snapshot rejection), each executed against the oracle with recorded
         outputs, plus a temporary record/check harness, pytest, envelope
         schema, and a TS envelope test for R4-C consumption.
Status: accepted
Files changed:
  new: tests/fixtures/parity/{claims,ranking,keywords,summary,view-model,
       stale-inputs}.json, tests/fixtures/parity/README.md,
       tests/fixtures/parity/parity-fixtures.schema.json,
       scripts/run_parity_fixtures.py, tests/test_parity_fixtures.py,
       tests/unit/fixtures/parity-envelope.test.ts
  mod: docs/product-rebuild/status.md
Migrations/data effects: none (no schema, product, or legacy code touched).
Verification performed and exact result:
  .venv/bin/python scripts/run_parity_fixtures.py --check → all 79 match,
  repeated under PYTHONHASHSEED=1/42/99 → stable;
  .venv/bin/pytest tests/test_parity_fixtures.py → 7 passed;
  npx vitest run → 411 passed / 14 skipped / 0 failed (1 failing file is
  the pre-existing browser-launch suite, proven on clean HEAD);
  npx tsc --noEmit → clean; npx eslint (new TS file) → clean.
  Legacy corroboration: tests/test_provenance.py 7 passed;
  tests/test_documents.py 2 passed, 1 failed on the known sandbox
  headless-browser segfault (status -11; pre-existing, browser-only).
Acceptance criteria not yet proven: human review of this handoff and of
  the recorded outputs' semantics (review notes below).
Decisions or deviations:
  - Fixture files are self-contained (shared profile duplicated, no
    includes) so R4-C parses with a plain JSON reader.
  - Recorded outputs keep oracle snake_case verbatim; key mapping is the
    port's job.
  - One documented normalization: `Allowed: {...}` enum lists in error
    strings are sorted (raw Python set order varies with hash seed).
  - Pipeline cases cover blocked paths only (success needs the browser
    renderer); no wording-variant or tailor-heuristic cases (deferred /
    out of scope) — see README scope cuts.
Safety/human checkpoint: fixtures are synthetic (`cand-parity-001`,
  example.com); harness is DB-free/browser-free, runs the oracle
  read-only, and writes only fixture files. Bash sandbox on.
```

## Case inventory (79)

- `claims.json` (26): requirement validity incl. matched+confirmed vs
  unconfirmed-semantic, unknown/empty/mismatched evidence, gap-evidence
  rejection, bad enums, duplicate ids, non-JD quotes, legacy
  `matched_fact_ids`/`status` aliases; verbatim draft checks (tampered
  metric/tech, multi-fact, misattributed employer, wrong dates,
  duplicate ids, unknown section, empty); derived-summary manifest
  binding; submission stale-id and empty-requirement rejection.
- `ranking.json` (8): required-before-preferred, duplicate-coverage
  suppression, per-role cap, max-total cap, alphabetical tie-break,
  uncoverable-degradation (metric/recency/alpha), empty facts,
  phrase-hit outranking alpha order.
- `keywords.json` (7): skill gating incl. the verified-flag decoy,
  include_exact vs omit_unsupported (incl. supported-but-unranked),
  coverage fractions (1/2, 1/3), empty-input zeros, legacy alias.
- `summary.json` (16): tenure union/overlap/cap/invalid (hand-checked
  month counts: 73/9/30/0), derived_template with target label,
  NO_EVIDENCE/NO_TITLE/THIN_TENURE/NO_DOMAINS fallbacks, target
  allow-list miss, manifest round-trip plus 5 tamper rejections.
- `view-model.json` (8): current-first ordering, professional/earlier
  split, empty-header dropping, contact omission, evidence-qualified
  skills, full plain-text golden, empty-draft header, chronological
  baseline draft.
- `stale-inputs.json` (14): EMPTY_JD, ANALYSIS_REQUIRED,
  new-JD-text (deterministic stub snapshot id), bound-JD mismatch,
  profile-hash drift, snapshot not-found/mismatch/bad-JSON/bad-shape,
  unapproved fact, malformed requirement (pydantic message pinned),
  missing job/profile ValueErrors, quote-mismatch with error list.

## Review performed (not blind record)

Every suite's recorded outputs were hand-checked against the oracle
source: validator error paths, ranker lexicographic keys round by
round, coverage fractions, tenure month arithmetic, formula slots and
the early-break cited-ids quirk, projection goldens, and blocker
codes. Review caught and fixed: hash-seed-unstable set reprs
(normalized in-harness), a weak phrase-hit case (redesigned to be
decisive), and an unverified-skill case that didn't exercise the flag
(decoy added).

## For R4-C

Consume `tests/fixtures/parity/*.json` with the envelope schema; map
`function` names to the ported modules. Float outputs use Python repr;
error prose (esp. the pydantic message) pins behavior, not wording to
clone. Run `--check` before porting to confirm the oracle baseline.
