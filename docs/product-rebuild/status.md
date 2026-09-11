# Rebuild Status

Last updated: 2026-09-11

## Current position

- Current milestone: **R0 — Preservation and Nimbalyst exit**
- Product runtime: **legacy Python/PostgreSQL remains operational source code**
- Target runtime: **planned; Node/Next.js/SQLite implementation has not started**
- Next implementation work: **R1-A — Node/Next application scaffold** after the
  R0 verification below is accepted.

Do not report target commands, SQLite migrations, URL intake, Kanban, or DOCX
generation as available yet.

## Work-order status

| Work order | Status | Evidence / remaining gate |
|---|---|---|
| R0-A Preserve current baseline | needs review | `legacy-baseline.md`; runtime files retained; full-suite rerun environment-blocked |
| R0-B Remove Nimbalyst | needs review | Deletions verified; checker passes; agent-guide wording fixed; diff review done with one noted deviation (see R0 completion note) |
| R1-A through R1-D | ready after R0 | See work-order dependencies |
| R2-A through R5-D | blocked by dependency | Do not start ahead of milestone gates |

Allowed status values are `ready`, `in progress`, `needs review`, `blocked by
dependency`, and `accepted`. Avoid percentages: evidence and remaining gates are
more informative.

## Baseline facts

- Current HEAD at preservation: `9ce1a93` on `main`.
- Uncommitted Milestone 7/8 implementation was present before this rebuild and
  is preserved in place.
- Legacy project-control files claimed 210 passing tests on 2026-09-10.
- The cleanup rerun could not access local PostgreSQL or the headless browser
  under the sandbox; elevated rerun permission was declined. See
  `legacy-baseline.md` for the exact outcome.
- Human visual acceptance of the existing standard resume remained outstanding
  and is intentionally folded into R4 acceptance.

## R0 completion checklist

- [x] Rebuild product, architecture, reuse, milestone, and work-order contracts
      exist.
- [x] Unique uncommitted Milestone 7/8 decisions and implementation inventory
      are preserved outside the old control plane.
- [x] `.nimbalyst/` and `nimbalyst-local/` are absent.
- [x] The old population script and Nimbalyst-only test are absent.
- [x] Root agent entrypoints and active documentation contain no links to the
      deleted harness.
- [x] Legacy runtime documentation is isolated under `docs/legacy/`.
- [x] The context checker passes.
- [x] Git diff review confirms no candidate data, generated resume artifacts,
      or unrelated runtime changes were removed.

R0 completion note (2026-09-11 verification): all 12 legacy docs plus
`errors.md` and the old `.env.example` are byte-identical under `docs/legacy/`;
preservation-archive SHA-256 values rechecked and match `legacy-baseline.md`;
the only active-tree `nimbalyst` mentions are retirement notices and the
checker's own guard path list. Deviation: `bin/job` (legacy CLI wrapper) and
`skills/morning-briefing/SKILL.md` were deleted ahead of the R5-D gate. Both
are recoverable from HEAD (`9df247dd…`, `1aa52c6f…`), the wrapped Python
scripts and `services/briefing/` remain intact, and no runtime capability was
removed. Focused rerun: 11/11 DB-free tests pass; DB/PDF tests remain
environment-blocked (sandbox denies port 5432 and the headless browser
segfaults), matching the recorded baseline.

## Known human gates

- Re-running the complete legacy suite with local PostgreSQL/browser access is
  optional for R0 but remains unverified in this cleanup environment.
- Resume layout approval is not inherited from the legacy milestone; R4 requires
  a new exact-artifact human review.
- Final application submission always remains manual.
