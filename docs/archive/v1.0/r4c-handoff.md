# R4-C Handoff — TypeScript truthfulness core

```text
Work order: R4-C (TypeScript truthfulness core)
Outcome: implemented — pure TS port of the oracle's requirement/claim
         validation, coverage-first ranking, keyword planning, summary
         derivation, and stale-input gate under src/tailoring/**, matching
         all 71 applicable R4-B parity cases plus 31 adversarial tests.
Status: accepted
Files changed:
  new: src/tailoring/{text,hash,primitives,schemas,validator,ranking,
       keywords,summary,staleness,index}.ts,
       tests/unit/parity/{_loader,claims,ranking-keywords,summary,
       stale}.test.ts, tests/unit/tailoring/adversarial.test.ts
  mod: tests/unit/domain/purity.test.ts (tailoring purity guard)
Migrations/data effects: none (no schema, product, or legacy code touched).
Verification performed and exact result:
  npx vitest run tests/unit/parity → 71 passed (all R4-B suites except
  view-model, which belongs to R4-D);
  npx vitest run tests/unit/tailoring → 31 passed (adversarial);
  npx vitest run → 516 passed / 14 skipped / 0 failed;
  npx tsc --noEmit → clean; npx eslint . → clean.
Acceptance criteria not yet proven: human review of this handoff and of
  the four documented parity carve-outs (below).
Decisions or deviations:
  - Two stale-input cases need mapping, not byte equality: new-JD-text
    returns new_jd_snapshot_hash for R4-E to persist (test maps hash to
    the harness stub id), and the malformed-requirement message keeps
    the shared "Invalid requirement in analysis: " prefix with
    deterministic validator-style detail instead of pydantic prose.
  - Sorted Allowed:{...} enum lists follow the R4-B harness
    normalization (raw Python set order is hash-seed unstable).
  - Agent-supplied mistyped values yield structured rule errors; only
    a corrupt candidate profile (own snapshot data) throws ZodError.
  - JD hashing reuses the R4-A canonical text form (byte-identical on
    plain-ASCII descriptions).
Safety/human checkpoint: no agent/provider calls, no filesystem or DB
  access from src/tailoring/** (purity test enforced); no approval or
  Tailored-transition logic touched — human gates unchanged.
```

## Module map

- `text.ts` — casefold/term normalization, word-boundary check,
  code-point ordering (Python `str` semantics).
- `hash.ts` — SHA-256 over UTF-8 (`node:crypto` only).
- `primitives.ts` — `pyString`/`pyTruthy`/`isRecord` truthiness bridges.
- `schemas.ts` — candidate profile read-model (snake_case keys, oracle
  defaults; wrong-typed present values throw `ZodError`).
- `validator.ts` — `validateRequirements` / `validateClaim` /
  `validateDraft` / `validateSubmission` (ClaimValidator port,
  oracle-identical rule messages and `status`/`matched_fact_ids`
  aliases).
- `ranking.ts` — `rankFacts` (CoverageFirstFactRanker port: greedy
  set-cover, lexicographic keys, fact_id tie-break, per-role caps).
- `keywords.ts` — `evidenceQualifiedSkills` / `planKeywords`
  (gap/unsupported terms reported with `omit_unsupported`, never
  rendered).
- `summary.ts` — `unionedCareerMonths` / `composeSummary` /
  `verifyDerivation` / `buildDerivedText` (single source of truth for
  composer and verifier; byte-for-byte `final_text` reconstruction).
- `staleness.ts` — `checkGenerationInputs`
  (generate_documents preconditions 1–4 over caller-resolved inputs;
  R4-E supplies rows, hashes, and candidate id).
- `index.ts` — barrel export.

## Adversarial coverage (31 tests)

Smuggled evidence/quotes on unsupported/gap requirements, unapproved
fact citations, reworded verbatim text, invented metrics/technologies,
misattributed employers/roles, stretched dates, derived_template
outside the summary, unapproved/tampered/cross-candidate wording
variants, unknown sections, empty/duplicate drafts, stale snapshot
submissions, unapproved-fact ranking exclusion, zero-cap configs,
skill gating by cited evidence, overlapping/future/malformed
employment intervals, inflated-tenure and invented-domain
derivations, and every stale-gate blocker (missing job/profile,
changed JD with new hash, profile drift, cross-candidate snapshot,
unapproved cited fact).

## For R4-E

Call the gate with database-resolved inputs (`GateInputs`), then
`rankFacts` → `planKeywords` → `composeSummary`, and validate every
proposal with `validateDraft`/`validateSubmission`. The port never
chooses approval state, paths, hashes, or scores — orchestration
owns persistence and provider I/O.
