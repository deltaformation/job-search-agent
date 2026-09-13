# Release 1.1 Work Orders & Execution Log

Status: Active execution log  
Branch: `release/v1.0`  
Roadmap: [`docs/roadmap-v1.1.md`](roadmap-v1.1.md)  

This document maintains an auditable, permanent record of coding-agent prompts, implementation details, benchmarks, and mandatory `AGENTS.md` handoffs for the v1.1 release line.

---

## Record 1: macOS Desktop Application Launcher

**Work Order ID:** `TOOL-DESKTOP-APP`  
**Phase:** Operational Tooling  
**Commits:** `d010fc0` (feat: builder + launcher), `951cfb3` (fix: statSync import)  

### Prompt Given to Agent
```markdown
Build a native macOS application bundle (`Job Tracker.app`) on the user's Desktop with a custom application icon. When double-clicked, it starts the web app server silently in the background (no Terminal window), waits for `/api/health`, then opens the tracker in a dedicated Google Chrome App Mode window using an isolated Chrome profile. The server lifecycle is bound to the Chrome window: quitting Chrome stops Next.js and the worker cleanly.

Requirements:
- Dedicated Chrome profile at `~/Library/Application Support/Job Tracker/ChromeProfile`.
- Check if server already runs; reuse and leave running if so.
- Auto-mode server command: `npm run start` if `.next/BUILD_ID` exists, else fallback to `npm run dev`.
- High-resolution `.icns` generated from checked-in 1024px PNG (`assets/desktop-icon-1024.png`) using `sips` + `iconutil`.
- Single-instance lockfile to prevent duplicate launches.
- Gatekeeper ad-hoc signing (`codesign -s -`) and quarantine clearance (`xattr -cr`).
- CLI script: `scripts/create-desktop-app.mjs` with npm script `npm run desktop:app`.
```

### Official Handoff
```text
Task: Build and install native macOS Desktop App launcher (Job Tracker.app)
Outcome: Job Tracker.app built and installed to ~/Desktop. Launcher operates with window-bound lifecycle: double-click launches silent background supervisor (logs to ~/Library/Logs/Job Tracker/server.log), polls /api/health with 60s timeout, launches Chrome in App Mode with dedicated user profile. Quitting Chrome or pressing Cmd+Q cleanly SIGTERMs the background server. Reuses pre-existing Terminal servers. High-res icon generated via sips/iconutil and ad-hoc signed. Missing statSync import in scripts/create-desktop-app.mjs resolved and verified.
Status: implemented
Files changed:
  - scripts/create-desktop-app.mjs (new, +fix)
  - tests/unit/scripts/create-desktop-app.test.ts (new)
  - assets/desktop-icon-1024.png (new)
  - package.json (+desktop:app script)
  - .gitignore (+dist/)
Migrations/data effects: None.
Verification performed and exact result:
  - npm run desktop:app -- --dry-run: passed, verified bundle output in dist/desktop/Job Tracker.app
  - plutil -lint Info.plist: OK
  - bash -n launcher: OK (clean syntax)
  - file AppIcon.icns: Mac OS X icon, 47800 bytes, "icp4" type
  - codesign -vvv --deep --strict: valid on disk, satisfies designated requirement
  - npx vitest run tests/unit/scripts/create-desktop-app.test.ts: 5/5 tests passed
  - node ./scripts/check-project-context.mjs: 11/11 files consistent, 0 errors
  - npm run desktop:app: installed cleanly to /Users/mouadatfi/Desktop/Job Tracker.app
Acceptance criteria not yet proven:
  - Manual double-click and Cmd+Q lifecycle verification in desktop session.
Decisions or deviations:
  - Dedicated Chrome profile used to prevent profile lock collisions and ensure Cmd+Q only closes Job Tracker without quitting the user's primary browser.
Safety/human checkpoint:
  - Loopback-only (127.0.0.1:3000) binding preserved. No external network endpoints opened.
```

---

## Record 2: Bounded Board Queries ($O(1)$ Optimization)

**Work Order ID:** `WO-1.1-A`  
**Phase:** Phase 0 Baseline + Phase 1.1 Bounded Board Queries  
**Commit:** `b2fc150`  

### Prompt Given to Agent
```markdown
Eliminate the N+1 query bottleneck in `src/server/board.ts` where `getBoardView` queries `resumeVersions` and `jobNotes` inside a per-card loop, reducing SQLite queries from 100+ down to a constant bounded count (~5 queries), supported by reproducible baseline measurements.

Steps:
1. Create an isolated benchmark test in `tests/unit/server/board-perf.test.ts` seeding 0, 10, 50, and 100 cards with notes and active resumes.
2. Refactor `getBoardView` in `src/server/board.ts`:
   - Replace per-card `resumeVersions` and `jobNotes` lookups with a consolidated `LEFT JOIN` and correlated note-count subquery.
   - Replace 5 column count queries with 1 grouped totals query.
   - Preserve exact BoardView return types, pagination limits, sorting, search filter, and safe URLs.
3. Verify queries remain constant O(1) and all tests pass.
```

### Official Handoff
```text
Task: Phase 0 baseline + Phase 1.1 bounded board queries
Outcome: getBoardView refactored from per-card resume/note lookups to one grouped totals query plus one paginated row query per column with a LEFT JOIN on active resumeVersions and a correlated note-count subquery. Card mapping is now pure projection. A committed benchmark test seeds isolated temp databases (0/10/50/100 cards, varied notes, active resumes on alternating cards) and counts exact statements via a sqlite.prepare wrapper.
Status: implemented
Files changed:
  - src/server/board.ts (getBoardView only; getJobDetail untouched)
  - tests/unit/server/board-perf.test.ts (new)
Migrations/data effects: None; read-only query restructure, no schema or persistence changes.
Verification performed and exact result (including query count before vs. after):
  - Benchmark Before:
    - 0 cards: 10 queries / 1.78ms
    - 10 cards: 25 queries / 1.38ms
    - 50 cards: 85 queries / 2.31ms
    - 100 cards: 160 queries / 3.31ms
  - Benchmark After:
    - 0 cards: 6 queries / 1.75ms
    - 10 cards: 6 queries / 1.16ms
    - 50 cards: 6 queries / 1.07ms
    - 100 cards: 6 queries / 1.24ms (constant O(1), ~3x faster execution at 100 cards)
  - Unit suites: tests/unit/server/board.test.ts + tests/unit/routes/board.test.ts: 14/14 pass.
  - Full non-browser suite: 110 files / 804 tests pass.
  - Typecheck: 0 errors. Lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 consistent.
Acceptance criteria not yet proven:
  - Apple Silicon INP/browser-side claims are out of scope for this work order (addressed in WO-1.1-B).
Decisions or deviations:
  - 6 queries instead of approximate 5: per-column LIMIT/OFFSET pagination requires one row query per column (a single UNION/window query would risk changing pagination semantics), and totals consolidated from 5 counts into 1 GROUP BY.
  - Benchmark delivered as a committed vitest file (board-perf.test.ts) rather than a standalone script so TS transforms work out of the box.
Safety/human checkpoint:
  - No approval, application, or auth boundary touched; board remains read-only projection with identical shapes, search/sort/pagination, and loopback serving unchanged.
```

---

## Record 3: Request-Time Initial Data & Client INP Optimization

**Work Order ID:** `WO-1.1-B`  
**Phase:** Phase 1.2 Request-Time Initial Data + Phase 1.3 Client INP Optimization  
**Commit:** `1d24ac0`  

### Prompt Given to Agent
```markdown
Goals:
1. Eliminate the empty loading state on `/board` navigation by loading initial board data during the server request (Phase 1.2).
2. Fix the 2,448 ms INP on Apple Silicon by eliminating main-thread long tasks and unnecessary re-renders (Phase 1.3).

Steps:
1. In `app/board/page.tsx`, fetch initial board data directly on the server via `getBoardView` with `openRequestDatabase`, passing `initialData` to `<Board />`.
2. In `components/board/Board.tsx`, initialize state with `initialData` (loading=false) so initial paint has cards on frame 1 without a loading skeleton.
3. Memoize `JobCard` with `React.memo` to prevent 3s polling ticks and search keystrokes from re-rendering all 50+ cards.
4. Wrap drawer open/close, view mode toggles, and tab switches in React 19 `startTransition`.
5. Defer mounting of hidden tabs in `CardDrawer` and `SettingsModal` (mount-on-select).
6. Apply `content-visibility: auto` and `contain-intrinsic-size` to board columns and cards in CSS.
7. Remove full-viewport backdrop-blur on modal overlays to eliminate macOS Chromium GPU compositing stalls.
```

### Official Handoff
```text
Task: Phase 1.2 request-time initial board data + Phase 1.3 client INP optimization
Outcome: /board is now force-dynamic and reads getBoardView with safe defaults during the request via the established openRequestDatabase pattern, passing initialData to Board (state initializes to data with loading=false; background refresh/polling/search retained). JobCard is reference-equality memoized; drawer open/close, view-mode toggle, and drawer tab switches run in startTransition behind stable callbacks; drawer builds only the active tab tree and SettingsModal mounts tabs on selection; full-viewport drawer-overlay blur and sticky-bar blur removed; content-visibility: auto + contain-intrinsic-size added to columns and cards. PointerSensor distance: 4 was already in place — verified, no change.
Status: implemented
Files changed:
  - app/board/page.tsx
  - components/board/Board.tsx
  - components/board/JobCard.tsx
  - components/board/CardDrawer.tsx
  - components/board/dialog.tsx
  - components/board/ResumeReview.tsx
  - components/settings/SettingsModal.tsx
  - app/globals.css
  - tests/unit/components/board/Board.test.tsx
  - tests/unit/components/settings/SettingsModal.test.tsx
Migrations/data effects: None; read-path only, no schema or persistence changes.
Verification performed and exact result:
  - npx next build --webpack: succeeds, /board listed as dynamic (server-rendered on demand, no build-time DB open).
  - Non-browser test suite: 110 files / 805 tests pass (includes new frame-1 sync card paint test, no "Loading board…", background revalidation still fires once).
  - Typecheck: 0 errors. Lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 consistent before and after.
  - Settings draft-preservation tests pass unchanged in assertions (adapted to mount-on-select).
Acceptance criteria not yet proven:
  - Measured INP ≤ 100 ms on Apple Silicon in a live browser (to be profiled on hardware).
Decisions or deviations:
  - Sort/search commits deliberately left urgent (they gate fetches + loading indicator; deferring would delay fetch without deferring any heavy sync render).
  - Approval/reject/correct modals left urgent (small trees, must appear promptly).
  - Content-visibility uses auto remembered sizes so drag measurements stay exact after first paint; keyboard DnD unaffected.
Safety/human checkpoint:
  - No approval, application, conflict-retry, or auth mechanics touched; row-version mutation paths byte-identical; drawer/dialog focus-trap, Escape, overlay-click, and aria contracts unchanged; server page falls back to client fetch (never 500s) if the DB is unavailable.
```
