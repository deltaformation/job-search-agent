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
- Verification at v1.0: typecheck clean, eslint clean, unit suite 109 files
  / 802 tests green.

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
