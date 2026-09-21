# v1.1 Status

Last updated: 2026-09-14. Branch: `release/v1.0`. Package version: 1.1.0.

## Release 1.3 (in progress — integrated closure partial)

- Tailor-route release (board → `/jobs/[id]/tailor` → Review Data →
  Tailor Resume → Generate → Review & Approve): see the
  [v1.3 builder work orders](work-orders-v1.3.md),
  [acceptance ledger](acceptance-v1.3.md), and
  [technical contracts](tailoring-contracts-v1.3.md).
- A–H recorded PASS with evidence (2026-09-16/18); e2e board suite
  21/21 green on a browser Mac 2026-09-18 (H1/H7/C/G browser legs).
- WO-1.3-I machine legs proven 2026-09-19 on isolated data through
  real routes and supervised worker legs: new `i-closure`,
  `i-lifecycle`, `i-hardening`, `i-a11y` suites 10/10; I2/I3/I4/I6/I7
  and U1–U17/U19/U20 PASS. WO-1.3-I8 browser legs proven 2026-09-19
  on an unsandboxed browser Mac: `npx playwright test` 24/24 (21 +
  3 new tailor-I8 legs) on isolated `.e2e-data` through the real
  supervisor, real Chromium PDF render + screenshot + extracted-text
  agreement on the exact approved artifact, browser unit suites
  17/17. I8 and I5 PASS; I1/I9 and U18 PARTIAL (narrowed: v2
  editor with a prepared plan in-browser stays open, jsdom-proven).
  `/mockup` disposition: RETAIN as the interaction reference.
- Release stays open: G7 one-PDF human eyeball-check, pre-existing
  `tailor-retry` 409 unit failure (WO-1.2-D owner), v1.2 F1–F10
  gates, worker-fetcher scraper flags, U18 v2-editor browser leg
  (future e2e harness).

## Release 1.2 (in progress — acceptance open)

- Workflow-alignment release restoring the user-led career-profile →
  tailoring → resume-review loop: see the
  [v1.1 alignment audit](alignment-audit-v1.1.md), the
  [v1.2 builder work orders](work-orders-v1.2.md),
  [acceptance ledger](acceptance-v1.2.md), and the
  [v1.2 lifecycle contracts](lifecycle-contracts-v1.2.md).
- Active execution log is now
  [`execution-log-v1.2.md`](execution-log-v1.2.md);
  [`work-orders-v1.1.md`](work-orders-v1.1.md) is preserved history.
- A, its correction and B have recorded handoffs; C is next. B reports
  26/26 focused tests passing, with two full-suite browser launch failures.
  The documentation reorganization has not independently verified B's
  implementation or its environmental diagnosis. Read its execution record
  and validate dependency outputs before resuming; browser acceptance stays open.
- Package version stays 1.1.0 until `WO-1.2-J`; no v1.2 behavior is
  claimed before its ledger evidence exists.

## Current position

- Release 1.1 **cut over**: bounded O(1) board queries, frame-1 initial
  render with de-janked interactions, accessible auto-dismissing notices,
  pure-Kanban larger-card board, multi-profile candidate persistence with
  settings management, direct Google AI Studio / Meta Muse / OpenRouter
  providers, interactive drawer tailoring guidance, resumes hierarchy with
  master preview, and derived applied-card follow-up badges. Roadmap
  ([`roadmap-v1.1.md`](roadmap-v1.1.md)) marked Complete; records 1–10 in
  [`work-orders-v1.1.md`](work-orders-v1.1.md); new decisions R-ADR-012
  (multi-profile persistence), R-ADR-013 (interactive tailoring envelope),
  R-ADR-014 (direct cloud providers).
- Product runtime: **standalone Node.js/Next.js/SQLite** — intake and
  scraping (URL paste, 1-click clipper, Playwright extraction), a
  five-column persistent Kanban, truthful resume tailoring with immutable
  artifacts and human approval, settings with backup/restore/reset, and a
  macOS desktop launcher (`npm run desktop:app`).
- Rebuild milestones R0–R6 accepted and committed; legacy Python/PostgreSQL
  removed. Frozen work record: [`archive/v1.0/`](archive/v1.0/).
- v1.1 work orders completed on `release/v1.0`: `WO-1.1-A` (bounded O(1)
  queries in `b2fc150`), `WO-1.1-B` (frame-1 initial render + INP de-janking
  in `1d24ac0`), `WO-1.1-C` (accessible auto-dismissing notices in `c55fa0f`),
  `WO-1.1-D` (pure Kanban, larger cards, optimized header in `17f9fd4`),
  `WO-1.1-E` (multi-profile candidate schema and repository in `3ee857e`),
  `WO-1.1-F` (direct cloud providers Google AI Studio & Meta Muse in `edc1172`),
  `WO-1.1-G` (settings career profiles and master resume management in `29ac8cf`),
  `WO-1.1-H` (interactive tailoring in job workspace in `ab1b98f`),
  `WO-1.1-I` (resumes section hierarchy and derived follow-up badges in `3de1956`).
  Per-order handoffs: [`work-orders-v1.1.md`](work-orders-v1.1.md).
- Verification at cutover: typecheck clean, eslint clean, unit suite 120 files
  / 945 tests green; project context 11/11 consistent.

## Known items

- Provider settings user blocker: OpenRouter selection appears to revert to
  Google after Save, key editing is missing, and test reports HTTP 502.
  [G regression record](feedback-g-provider-settings.md) distinguishes saved
  versus active state, inaccurate Connected labeling and tests ignoring model
  drafts. G owns correction; actual tailoring failure cause remains unverified.

- Additional tailoring feedback: progress description stays static; local
  `provider spawn failed: 'node'` surfaces as generic provider failure with
  unhelpful retry guidance. [WO-POST-J-ELAPSED](work-order-post-j-elapsed.md)
  now includes real stages, liveness distinctions and actionable errors.
  Launch cause is unverified; if it blocks use, triage during G's setup
  checkpoint instead of waiting for the post-J UX pass.

- Tailoring elapsed time resets on drawer-tab navigation (user report;
  current banner initializes its start on mount). Planned correction:
  [WO-POST-J-ELAPSED](work-order-post-j-elapsed.md), using stable running-attempt
  timing. Product fix and browser verification pending.

- User-reported clipping defect: Quo Senior Product Manager JD explicitly states
  CAD 166,000–196,000 annual base salary, but Facts shows Unknown. Fix is planned
  after J in [WO-POST-J-SALARY](work-order-post-j-salary.md); not implemented or
  reproduced against the original retained page yet. Includes recovery for
  already-clipped jobs and salary display independent of resume generation.

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
