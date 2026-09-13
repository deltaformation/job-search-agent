# v1.0 Status

Last updated: 2026-09-13. Branch: `release/v1.0`. Package version: 1.0.0.

## Current position

- Product runtime: **standalone Node.js/Next.js/SQLite** — intake and
  scraping (URL paste, 1-click clipper, Playwright extraction), a
  five-column persistent Kanban, truthful resume tailoring with immutable
  artifacts and human approval, settings with backup/restore/reset, and a
  macOS desktop launcher (`npm run desktop:app`).
- Rebuild milestones R0–R6 accepted and committed; legacy Python/PostgreSQL
  removed. Frozen work record: [`archive/v1.0/`](archive/v1.0/).
- Active v1.1 progression underway: roadmap in [`roadmap-v1.1.md`](roadmap-v1.1.md)
  and execution log in [`work-orders-v1.1.md`](work-orders-v1.1.md).
  Completed: `WO-1.1-A` (bounded O(1) queries in `b2fc150`), `WO-1.1-B` (frame-1
  initial render + INP de-janking in `1d24ac0`), `WO-1.1-C` (accessible auto-dismissing
  notices in `c55fa0f`), `WO-1.1-D` (pure Kanban, larger cards, optimized header in `17f9fd4`),
  `WO-1.1-E` (multi-profile candidate schema and repository in `3ee857e`).
- Verification at current HEAD: typecheck clean, eslint clean, unit suite 112 files
  / 821 tests green.

## Known items

- `tests/unit/server/queries.test.ts` batch-ordering case is timing-flaky:
  on `createdAt` ties the `id DESC` tiebreak compares random UUIDs, so the
  newest-first assertion can fail and pass on re-run. No product impact; do
  not narrow or skip it — make the tiebreak deterministic if it becomes a
  blocker.
- Browser/visual acceptance (R6-A §6 checklist: viewports, keyboard-only,
  reduced motion, contrast audit) and the R5-C manual walkthrough are
  user-verified by nature; see
  [`archive/v1.0/r6-a-design-polish-handoff.md`](archive/v1.0/r6-a-design-polish-handoff.md)
  §6 and
  [`archive/v1.0/r5-c-user-acceptance-checklist.md`](archive/v1.0/r5-c-user-acceptance-checklist.md).
- Desktop launcher install (`~/Desktop`) and the first-run Gatekeeper step
  are manual; see the `desktop:app` build output.
- This environment runs Node 26 while `engines` pins Node 24.x; the desktop
  launcher embeds the generating Node major. Revisit the engines baseline
  deliberately, not by drift.
