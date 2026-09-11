# R4-B Parity Fixtures

Runtime-neutral JSON cases pinning the legacy Python oracle's deterministic
behavior for the TypeScript port (R4-C). Each suite file is self-contained
(no cross-file references) so any language can parse it with a plain JSON
reader.

## Layout

| File | Oracle surface | Cases |
|---|---|---|
| `claims.json` | `ClaimValidator`: requirement analysis, draft, submission | requirement validity, evidence binding, tamper rejection, stale ids |
| `ranking.json` | `CoverageFirstFactRanker.rank` | priority order, caps, suppression, tie-breaks |
| `keywords.json` | `evidence_qualified_skills`, `KeywordPlanner.plan` | skill gating, include/omit decisions, coverage math |
| `summary.json` | `unioned_career_months`, `compose_summary`, `verify_derivation` | tenure union, formula slots, fallbacks, manifest checks |
| `view-model.json` | `build_view_model`, `render_plain_text`, `build_canonical_baseline_draft` | ordering, splits, projections, baseline |
| `stale-inputs.json` | `generate_documents` preconditions (stub repo) | blocked paths for stale/invalid inputs |

`parity-fixtures.schema.json` is the envelope schema. The shared synthetic
profile/JD (`cand-parity-001`) is duplicated into every file on purpose.

## Envelope

```json
{
  "version": "parity-fixtures/v1",
  "suite": "<stem>",
  "cases": [
    {"id": "<unique>", "description": "<why>", "function": "<runner>",
     "input": {...}, "expected": {...}}
  ]
}
```

`function` names the oracle entry point; the harness maps it in `RUNNERS`.
Recorded outputs keep the oracle's `snake_case` vocabulary verbatim — key
mapping to TypeScript conventions is the port's job, not the fixture's.

## Runner

```bash
.venv/bin/python scripts/run_parity_fixtures.py --check [--suite NAME]
.venv/bin/python scripts/run_parity_fixtures.py --record [--suite NAME]
```

`--record` executes the oracle and stores outputs as `expected`; `--check`
fails on any drift. The harness is DB-free and browser-free. Float outputs
are recorded with Python `repr` (shortest round-trip); the port must match
or document its formatting. One normalization is applied for
cross-machine determinism: `Allowed: {...}` enum lists in validator error
strings are sorted (raw Python set order varies with hash seed).

## Deliberate scope cuts

- Pipeline cases cover **blocked paths only**. The success path needs the
  browser renderer; R4-C/D own it with new code.
- No wording-variant success cases (deferred per `reuse-map.md`).
- No `ResumeTailor` draft-heuristic cases (prompt assembly, not a ported
  algorithm).
- The `stale-invalid-requirement` message pins the installed pydantic
  version's wording; the port targets the rejection, not the prose.

## Lifecycle

The JSON fixtures persist for R4-C. The harness
(`scripts/run_parity_fixtures.py`) and its pytest (`tests/test_parity_fixtures.py`)
are temporary and leave with the oracle at R5-D.
