# Rebuild Status

Last updated: 2026-09-11

## Current position

- Current milestone: **R4 — Truthful tailoring and resume artifacts** (R1, R2, and R3 completed and accepted)
- Product runtime: **legacy Python/PostgreSQL remains operational source code**
- Target runtime: **Milestones 1, 2, & 3 complete on `rebuild/r1-platform` (supervisor, Next.js, worker, SQLite, security layer, URL intake, Playwright fetcher, extraction adapters, queue dispatcher, attempt visibility UI, workflow state machine, board projections, and Kanban UI)**
- Next implementation work: **R4-F — Resume review and approval
  UI/service** (R4-A through R4-E accepted; R4-F ready to implement).

Do not report target commands, Kanban, or DOCX generation as
available yet. SQLite migrations exist and execute automatically on startup.

## Work-order status

| Work order | Status | Evidence / remaining gate |
|---|---|---|
| R0-A Preserve current baseline | needs review | `legacy-baseline.md`; runtime files retained; full-suite rerun environment-blocked |
| R0-B Remove Nimbalyst | needs review | Deletions verified; checker passes; agent-guide wording fixed; diff review done with one noted deviation (see R0 completion note) |
| R1-A Node/Next scaffold | accepted | typecheck/lint/unit/webpack-build pass on Node 24; user confirmed `npm run dev` serves the page on Node 24 (covers Turbopack compile + serve smoke) |
| R1-B SQLite schema + repositories | accepted | `r1b-handoff.md`; 24-table baseline, trigger guards, runner, 40 DB tests green on Node 24; review NULL-guard fix included |
| R1-C Domain contracts | accepted | `r1c-handoff.md`; pure Zod machines, mirror-tested against DDL, 50 domain tests green on Node 24 |
| R1-D Supervisor + security | accepted | `r1d-handoff.md`; dev/start supervisor, worker stub, security layer, 39 tests green; user confirmed `npm run dev` serves page + `/api/health` 200 OK |
| R2-A URL policy & intake service | accepted | `r2a-handoff.md`; URL policy, SSRF preflight, intake service, 30 new tests green on Node 24 |
| R2-B Queue leasing & worker dispatch | accepted | `r2b-handoff.md`; leases, dispatcher, worker drain, 32 new tests green on Node 24 |
| R2-C Playwright fetcher & network guard | accepted | `r2c-handoff.md`; fetch pipeline, guards, SCRAPE handler, 234/234 green incl. browser run, 5 review fixes approved |
| R2-D Extraction adapters & normalization | accepted | `r2d-handoff.md`; adapters, JSON-LD, generic, oracle parity, handler integration, 23 new tests green on Node 24 |
| R2-E Intake routes & attempt visibility | accepted | `r2e-handoff.md`; intake routes/pages, batch/attempt views, retry, evidence, 35 new tests green on Node 24; webpack build green |
| R2-F 1-Click Browser Clipper | accepted | `r2f-handoff.md`; bearer-authed clip route + token, MV3 extension, bookmarklet, paste fallback, 30 new tests green on Node 24; webpack build green |
| R3-A Workflow command service | accepted | `r3a-handoff.md`; move/correct/reorder/Applied/Tailored-gate/notes commands, CAS + audit events, 20 new tests green on Node 24 |
| R3-B Board queries & card detail API | accepted | `r3b-handoff.md`; board projection with search/sort/pagination, safe card detail, 14 new tests green on Node 24; webpack build green |
| R3-C Kanban & card detail UI | accepted | `r3c-handoff.md`; /board DnD, drawer, Applied/correct/reject dialogs, mutation routes, 7/7 E2E green on user machine, 381 vitest tests green, Ashby CAPTCHA fix |
| R4-A Candidate import and snapshots | accepted | `r4a-handoff.md`; import schema/command, repository, activation, snapshot service, CLI, 37 new tests green, 0002 dedupe |
| R4-B Shared parity fixtures | accepted | `r4b-handoff.md`; 79 JSON cases recorded from the oracle, harness, pytest, envelope schema + TS test |
| R4-C TypeScript truthfulness core | accepted | `r4c-handoff.md`; 10 pure modules, 71 parity + 31 adversarial tests green, tsc/eslint clean on Node 24 |
| R4-D Canonical view model and renderers | accepted | `r4d-handoff.md`; 8 view-model parity + 49 renderer/parity/golden/browser-PDF tests green, tsc/eslint clean on Node 24 |
| R4-E Local agent adapter and orchestration | accepted | `r4e-handoff.md`; provider contract + command/test adapters, deterministic orchestration, fenced TAILOR handler, 0003 migration, 59 new tests green, tsc/eslint clean on Node 24 |
| R4-F through R5-D | ready / blocked by dependency | R4-F builds review/approval on R4-E content + audit; R5 follows in sequence |

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
