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

---

## Record 4: Loading & Notification Behavior

**Work Order ID:** `WO-1.1-C`  
**Phase:** Phase 1.4  
**Commit:** `c55fa0f`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are completing Phase 1 of `docs/roadmap-v1.1.md`.

### Mandatory Context & Rules
1. Inspect existing notice implementations before modifying:
   - `components/board/Board.tsx` (`notice` state and `data-testid="board-notice"`)
   - `components/board/ResumeReview.tsx` (`notice` state)
   - `components/settings/SettingsModal.tsx` (`notice` state)
   - `components/AttemptView.tsx` (`notice` state)
   - `components/AppHeader.tsx` (`quickMessage` in quick-add dialog)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 1.4 Loading & Notification Behavior

#### Goal:
Replace routine, permanently sticky success banners with accessible, auto-dismissing notifications (3–4 second timer), while ensuring errors, version conflicts, and destructive warnings remain strictly persistent until resolved or manually dismissed.

---

### Specific Implementation Steps

#### 1. Notification Rules & Accessibility (Phase 1.4)
- **Auto-dismissing Successes**:
  - Success confirmations (e.g., *"Job moved to Interviewed"*, *"Settings saved"*, *"Job URL enqueued into batch"*, *"Approval confirmed"*) must automatically dismiss after **3.5 seconds**.
  - Must include an explicit manual dismiss (`[X]`) button so keyboard/mouse users can dismiss immediately if desired.
  - Automatically clear timers when a new notice is set or when the component unmounts to prevent memory leaks or updating unmounted components.
- **Persistent Errors & Conflicts**:
  - Errors (e.g., fetch failure, validation error), version conflicts, and approval requirements must **NEVER** auto-dismiss. They must stay on screen with an explicit dismiss button (`[X]`) until the user resolves them or closes the notification.
- **Accessibility & Motion Contracts**:
  - Success notices must use `role="status"` and `aria-live="polite"`.
  - Error notices must use `role="alert"` and `aria-live="assertive"`.
  - Transitions must respect `prefers-reduced-motion` (instant appearance/disappearance with zero animation if reduced motion is preferred).
  - The notification must never be the sole evidence of state change (the board columns, card statuses, and badge states must reflect reality independently).

#### 2. Component Integration
- In `components/board/Board.tsx`:
  - Retain `data-testid="board-notice"` and `role="status"` so existing E2E and unit tests pass.
  - Automatically clear `notice` after 3.5s on success; provide an `[X]` dismiss button.
- In `components/board/ResumeReview.tsx`:
  - Auto-dismiss success actions (e.g. *"Approval confirmed"*, *"Revision requested"*) after 3.5s with a manual dismiss option.
- In `components/settings/SettingsModal.tsx`:
  - Auto-dismiss success messages (e.g. *"Models saved"*, *"Backup generated"*) after 3.5s; keep error messages persistent until dismissed.
- In `components/AttemptView.tsx`:
  - Auto-dismiss retry-enqueued notices after 3.5s.

#### 3. Automated Verification & Tests
- Ensure all existing tests pass without regressions:
  - `npm test tests/unit/components/board/Board.test.tsx`
  - `npm test tests/unit/components/settings/SettingsModal.test.tsx`
  - `npm test tests/unit/components/board/ResumeReview.test.tsx`
  - Full non-browser vitest suite (`npx vitest run --exclude '**/browser/**'`)
- Add or update unit tests to verify:
  - Success notices clear automatically after the timeout.
  - Timer is cleared on unmount.
  - Error notices stay persistent and do not clear automatically.
  - Manual dismiss button clears the notice immediately.
- Static verification:
  - `npm run typecheck` (0 errors)
  - `npm run lint` (0 warnings)
  - `node scripts/check-project-context.mjs` (11/11 consistent)

---

### Expected Handoff Output
Provide the completed handoff block required by `AGENTS.md`:

Task: Phase 1.4 loading and notification behavior
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

### Official Handoff
```text
Task: Phase 1.4 loading and notification behavior
Outcome: New shared components/ui/notice.tsx (useNotice seq-keyed state + Notice banner: 3.5s success timer, focus-deferred dismissal, always-present [X], status/polite vs alert/assertive) integrated into all five surfaces. Board notices split by variant (move/reorder successes auto-dismiss; update failures and the TAILORED guardrail render persistent error variant, same board-notice testid); ResumeReview approvals/revisions auto-dismiss; settings/quick-add/retry/paste successes auto-dismiss while their errors persist; inline error boxes (board load, refresh-failed, action, settings load) gained [X].
Status: implemented
Files changed:
  - components/ui/notice.tsx (new)
  - components/board/Board.tsx
  - components/board/ResumeReview.tsx
  - components/settings/SettingsModal.tsx
  - components/AttemptView.tsx
  - components/AppHeader.tsx
  - tests/unit/components/ui/notice.test.tsx (new)
  - tests/unit/components/settings/SettingsModal.test.tsx
Migrations/data effects: none; client presentation only
Verification performed and exact result:
  - Focused files (Board, SettingsModal, ResumeReview, AttemptView, AppHeader, notice): 6 files / 35 tests pass.
  - Full non-browser suite: 111 files / 813 tests pass.
  - npm run typecheck: 0 errors.
  - npm run lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 consistent before and after.
  - New coverage: success auto-dismiss at exactly 3.5s, timer restart on identical re-show, no fire after unmount, error persistence past 10s, immediate [X] on both variants, focus-deferral with dismissal after blur, plus real-parent settings tests for success auto-dismiss and error persistence.
Acceptance criteria not yet proven:
  - e2e timing margin: board-notice success assertions (reorder) now race a 3.5s dismissal; Playwright polls immediately so it should catch them, but npm run test:e2e needs browsers unavailable in this sandbox. Reduced-motion behavior relies on the existing global prefers-reduced-motion guard (no new animation added).
Decisions or deviations:
  - pasteNotice included though unnamed (same component, same sticky-success defect; created/duplicate auto-dismiss, rejected/failed persist).
  - Content-gating error boxes (AttemptView/ResumeReview full-page load errors) intentionally got no [X] — dismissing the only signal with no content beneath and no retry path would strand the user; the ResumeReview one already offers Retry.
  - Guardrail classified as persistent error (rejected action ≈ validation error; also keeps the e2e assertion deterministic).
  - Focus-deferral added beyond the letter of the order to avoid dropping keyboard focus to <body> when a focused link/[X] is inside a dismissing banner.
  - Sort/search loading indicator untouched (fetch-gated, out of scope).
Safety/human checkpoint:
  - Notices remain supplementary — board columns, badges, and review states refresh from the server independently; no approval, application, conflict, or auth flow changed; error text and roles asserted by existing tests unchanged.
```

---

## Record 5: UI Ergonomics & Pure Kanban Layout

**Work Order ID:** `WO-1.1-D`  
**Phase:** Phase 3.2 & 3.3  
**Commit:** `17f9fd4`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are implementing Phase 3.2 and Phase 3.3 of `docs/roadmap-v1.1.md`.

### Mandatory Context & Rules
1. Inspect before modifying:
   - `components/AppHeader.tsx` (navigation buttons, profile pill, logo placement)
   - `app/board/page.tsx` (breadcrumbs removal)
   - `components/board/Board.tsx` (view mode toggle removal, column layout and scroll container)
   - `components/board/JobCard.tsx` (card sizing, typography, metadata hierarchy)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Do not break board drag-and-drop or column semantics. Retain the exact 5 columns (`New`, `Tailored`, `Applied`, `Interviewed`, `Rejected`).
4. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 3.2 & 3.3 UI Ergonomics & Pure Kanban Layout

#### 1. Header Optimization (Phase 3.3)
- In `app/board/page.tsx`: Remove the `Home > Board` breadcrumb trail to recover vertical space.
- In `components/AppHeader.tsx`:
  - **Left Group**: Dock primary navigation links (`Board`, `Intake`) directly adjacent to the brand logo (`Job Tracker`).
  - **Right Group**: Move the `Mouad Atfi / Profile Active` pill to the right, sitting directly next to `Settings` and `Add Job`.
  - Ensure header scales gracefully from 13"/14" laptop viewports to 4K displays with clean flex spacing and zero overlapping.

#### 2. Pure Kanban View & Larger Cards (Phase 3.2)
- In `components/board/Board.tsx`:
  - Permanently remove the Kanban / Stacked view switcher (lock board to pure Kanban). Remove obsolete `viewMode` state and toggle UI.
  - Set column widths and horizontal scroll container so the default viewport naturally displays the core 3 application buckets (`New`, `Tailored`, `Applied`), while `Interviewed` and `Rejected` are revealed smoothly by horizontal drag, scroll, or keyboard navigation.
- In `components/board/JobCard.tsx`:
  - Enlarge cards (`min-w-[340px]`, `w-full` inside column) with comfortable internal padding (`p-4`), clear typography, tabular salary/compensation display, and prominent status pills.

#### 3. Verification & Handoff
- Run existing tests: `npm test`
- Static verification:
  - `npm run typecheck` (0 errors)
  - `npm run lint` (0 warnings)
  - `node scripts/check-project-context.mjs` (11/11 consistent)
- Provide the official `AGENTS.md` handoff block so it can be appended to `docs/work-orders-v1.1.md`.
```

### Official Handoff
```text
Task: Phase 3.2 pure Kanban & larger cards + Phase 3.3 header optimization
Outcome: Board page breadcrumb removed (tighter pb-4 header); AppHeader restructured into left group (logo + Board/Intake nav + Ready dot) and right group (profile pill + Settings + Add Job) with wrapping flex for narrow screens. Kanban/Stacked switcher, viewMode state, and dead .board-stacked CSS removed; columns widened to w-[360px] min-w-[340px] 2xl:w-[400px] so 13"/14" viewports frame New/Tailored/Applied with Interviewed/Rejected one scroll away; cards filled to w-full with p-4; drag overlay widened to match.
Status: implemented
Files changed:
  - app/board/page.tsx
  - components/AppHeader.tsx
  - components/board/Board.tsx
  - components/board/BoardColumn.tsx
  - components/board/JobCard.tsx
  - app/globals.css
Migrations/data effects: none; markup/CSS only
Verification performed and exact result:
  - npm test: 813 passed, 0 failed (111 files pass; only the 2 known environmental browser-file failures — Playwright cannot launch Chromium in this sandbox, proven pre-existing and untouched by this change).
  - npm run typecheck: 0 errors.
  - npm run lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 before and after.
  - Repo-wide search confirms zero remaining viewMode/stacked references; no test referenced the toggle or board breadcrumb.
Acceptance criteria not yet proven:
  - visual framing on physical 13"/14" and 4K viewports (no browser available in this sandbox — confirm 3-bucket framing and header non-overlap on hardware).
Decisions or deviations:
  - used 2xl:w-[400px] instead of the roadmap's example xl:w-[400px] so exactly-1280px viewports still fit all three core buckets (1296px need at 400px would clip); 400px columns apply at ≥1536px where 3×400 fits with room.
  - Card type scale and pill sizes kept (already hierarchical with tabular numerals) — the width + padding change carries the readability gain.
  - Profile pill keeps its xl:flex visibility breakpoint.
Safety/human checkpoint:
  - exact 5 columns and all DnD/keyboard mechanics untouched (only widths and the view toggle changed); all nav links, aria labels, and button behaviors preserved; no approval, application, or data flow touched.
```

---

## Record 6: Multi-Profile Schema and Repository

**Work Order ID:** `WO-1.1-E`  
**Phase:** Phase 2.1  
**Commit:** `3ee857e`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are implementing Phase 2.1 of `docs/roadmap-v1.1.md` (R-ADR-012 Multi-Profile Schema & Repository).

### Mandatory Context & Rules
1. Inspect before modifying:
   - `src/db/schema/candidates.ts` (current `candidateProfiles` and constraints)
   - `drizzle/0000_freezing_wild_pack.sql` & `drizzle/0001_trigger_guards.sql` (inspect constraints and triggers on `candidate_profiles`)
   - `src/db/candidates.ts` (`LOCAL_PROFILE_ID`, `ensureLocalProfile`, `insertProfileVersion`, `listProfileVersions`)
   - `src/domain/candidate.ts` (Zod schemas for candidate profile payload and import)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Keep transactions synchronous and short; do not break immutable fact citations or snapshot foreign keys.
4. Existing tests must remain green; add focused tests for multi-profile repository operations.
5. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 2.1 Multi-Profile Schema & Repository

#### 1. Ordered Migration (`drizzle/0005_multi_candidate_profiles.sql`)
- Remove the single-row check constraint (`id = 'local'`) on `candidate_profiles`.
- Add structured profile fields:
  - `name`: TEXT (unique slug identifier, e.g. 'staff-engineer', 'lead-architect')
  - `display_name`: TEXT NOT NULL
  - `is_default`: INTEGER NOT NULL DEFAULT 0 (with partial unique index on `is_default = 1` or trigger ensuring exactly one default profile)
  - `work_preferences_json`: TEXT (JSON object for work authorization, work mode, visa sponsorship, relocation, YOE, salary expectations, target titles/locations)
  - `executive_narrative`: TEXT
  - `updated_at`: TEXT
- Backfill existing `'local'` profile row with default name `'default'`, display name `'Primary Profile'`, and `is_default = 1`.
- Update triggers in `drizzle/` if necessary to permit updating profile metadata (`display_name`, `work_preferences_json`, `executive_narrative`) while strictly preserving `candidate_profile_versions` and `candidate_facts` immutability.

#### 2. Schema & Domain Definitions
- In `src/db/schema/candidates.ts`:
  - Update `candidateProfiles` Drizzle schema matching the migration.
  - Export typed interfaces.
- In `src/domain/candidate.ts`:
  - Define `WorkPreferencesV1` Zod schema:
    - `workAuthorization`: string array or enum
    - `workMode`: array of 'REMOTE' | 'HYBRID' | 'ONSITE'
    - `sponsorshipRequired`: boolean
    - `willingToRelocate`: boolean
    - `yearsOfExperience`: number
    - `salaryExpectation`: object with optional `min`, `target`, `currency`
    - `targetTitles`: string array
    - `targetLocations`: string array
  - Define `CareerProfileV1` schema incorporating `id`, `name`, `displayName`, `isDefault`, `workPreferences`, `executiveNarrative`.

#### 3. Repository Layer
- In `src/db/candidates.ts`:
  - Add `listProfiles(handle)`, `getProfile(handle, idOrName)`, `getDefaultProfile(handle)`.
  - Add `createProfile(handle, input)`, `updateProfile(handle, id, input)`, `setDefaultProfile(handle, id)`.
  - Ensure all version, snapshot, and fact queries support passing a target `profileId`, defaulting to the active default profile for backwards compatibility.

#### 4. Automated Verification & Tests
- Add unit tests in `tests/unit/db/multi-profile.test.ts`:
  - Migration runs cleanly on fresh and existing databases.
  - Creation of multiple distinct profiles.
  - Default profile switching and single-default invariant enforcement.
  - Profile versioning and fact snapshots linked to specific profile IDs.
  - Immutability of versions and approved facts preserved across profiles.
- Run full non-browser test suite: `npx vitest run --exclude '**/browser/**'`
- Run `npm run typecheck`, `npm run lint`, and `node scripts/check-project-context.mjs`.

---

### Expected Handoff Output
Provide the completed handoff block required by `AGENTS.md`:

Task: Phase 2.1 multi-profile schema and repository
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

### Official Handoff
```text
Task: Phase 2.1 multi-profile schema and repository
Outcome: Migration 0005 rebuilds candidate_profiles (drops the id='local' CHECK; adds name unique, display_name, is_default, work_preferences_json, executive_narrative, updated_at; backfills local→default/Primary Profile/default=1; replaces the no-update trigger with a metadata-only guard; partial unique index for one default). Drizzle schema, WorkPreferencesV1/CareerProfileV1/input Zod schemas, and repository CRUD (list/get/getDefault/create/update/setDefault) plus optional-profileId threading through all version helpers (default-resolving, activation scoped to the target's profile) added. Service callers unchanged via backwards-compatible defaults.
Status: implemented
Files changed:
  - drizzle/0005_multi_candidate_profiles.sql (new)
  - src/db/schema/candidates.ts
  - src/domain/candidate.ts
  - src/db/candidates.ts
  - src/db/migrate.ts
  - tests/unit/db/multi-profile.test.ts (new)
  - tests/unit/db/helpers.ts
  - tests/unit/db/migrate.test.ts
  - tests/unit/db/startup.test.ts
  - tests/unit/db/constraints-enums.test.ts
  - tests/unit/server/board.test.ts
  - tests/unit/server/board-perf.test.ts
  - tests/unit/server/workflow.test.ts
  - tests/unit/server/review.test.ts
  - tests/unit/server/backup.test.ts
  - tests/unit/routes/resume-review.test.ts
  - tests/e2e/global-setup.ts
Migrations/data effects: 0005 rebuilds candidate_profiles with backfill (no version/fact/snapshot row changes); runner now disables FK enforcement around each file's transaction with a pre-commit foreign_key_check (SQLite's documented procedure — proven necessary: parent DROP fails even with deferred FKs). Existing DBs upgrade with lineage intact (proven by test).
Verification performed and exact result:
  - New suite 8/8 (legacy-upgrade with populated DB, multi-create, default switching + DB-level uniqueness, per-profile versioning/activation, fact/snapshot binding, identity freeze vs metadata updates, input validation, legacy ensure).
  - Full non-browser suite: 112 files / 821 tests pass.
  - npm run typecheck: 0 errors.
  - npm run lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 before and after.
  - The one queries.test.ts batch-ordering failure seen mid-run is the documented timing flake — passes in isolation, untouched code path.
Acceptance criteria not yet proven:
  - production-DB upgrade run (only exercised on synthetic legacy DBs); end-to-end Settings multi-profile UI (Phase 2.2 consumer, not in scope).
Decisions or deviations:
  - at-most-one default via partial unique index, exactly-one maintained by repo (first/explicit default) — a trigger forbidding zero-default states deadlocks the swap (proven in analysis), so no zero-default trigger.
  - activateProfileVersion deactivation re-scoped from hardcoded local to the target's profile (required for per-profile activation; behavior-identical when single-profile).
  - listProfiles orders by unique name (same-millisecond createdAt ties made creation order nondeterministic).
  - duplicate paste-style outcomes n/a here.
  - Preferences stored canonical-JSON, stamped work-preferences/v1, validated on every write; reads parse strictly (fail loud on corruption, writes are validated).
Safety/human checkpoint:
  - version/fact/snapshot immutability triggers and snapshot FK guards untouched and re-proven post-rebuild; profile identity (id, name, created_at) frozen by new guard trigger, deletes still forbidden; preferences are steering metadata only — never resume-claim sources, never auto-answers (domain boundary comment updated to restate this); no approval/application flow touched.
```

---

## Record 7: Direct Cloud Providers (Google AI Studio & Meta Muse)

**Work Order ID:** `WO-1.1-F`  
**Phase:** Phase 2.2  
**Commit:** `edc1172`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are implementing Phase 2.2 of `docs/roadmap-v1.1.md` (Direct Cloud Providers: Google AI Studio & Meta Muse).

### Mandatory Context & Rules
1. Inspect before modifying:
   - `scripts/openrouter-client.mjs` (existing provider implementation pattern, timeout, failover)
   - `src/server/settings.ts` (`getSettingsSnapshot`, `switchModels`, `pingOpenRouter`)
   - `components/settings/SettingsModal.tsx` (Models tab, ping button, model input)
   - `src/tailoring/orchestrate.ts` and `src/tailoring/provider.ts` (how tailoring invokes the model)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Never persist API keys in SQLite or Git; store only in `.env.local`. Never return raw API keys in client snapshots (use fingerprints or configured booleans only).
4. Output schema contract must remain `ResumeProposalV1` (provider-agnostic schema validation).
5. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 2.2 Direct Cloud Providers

#### 1. Provider Clients (`src/providers/` or `scripts/`)
- Implement Google AI Studio client:
  - Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
  - Supports `GEMINI_API_KEY`. Structured JSON output mode (`responseMimeType: "application/json"`).
  - Default primary: `gemini-2.5-pro`; fallback: `gemini-2.5-flash`.
- Implement Meta Muse client:
  - Endpoint: `https://api.meta.ai/v1/responses`
  - Supports `META_API_KEY` (Bearer auth). Structured JSON output mode (`response_format: { type: "json_object" }`).
  - Default model: `meta-muse` (user configurable).
- Normalize client responses into the standard `{ model: string, content: string }` envelope.

#### 2. Settings Backend (`src/server/settings.ts`)
- Update `SettingsSnapshot`:
  - `activeProvider`: `'openrouter' | 'google' | 'meta'`
  - Status/fingerprint for each provider (`configured: boolean, fingerprint: string | null`)
  - Provider-specific model chains.
- Update `switchModels` / add provider configuration switcher:
  - Supports switching active provider and editing model IDs in `.env.local` (`ACTIVE_AI_PROVIDER`, `GEMINI_MODEL`, `META_MODEL`, etc.).
- Add unified diagnostic ping:
  - `pingProvider(provider, env)` testing authentication, latency, and valid JSON response for the selected provider.

#### 3. Settings UI (`components/settings/SettingsModal.tsx`)
- In Models tab:
  - Provider selection tabs or radio cards: `OpenRouter`, `Google AI Studio`, `Meta Muse`.
  - Configured status pill per provider (`Connected` vs `Key Missing in .env.local`).
  - Editable model input fields with clear placeholder examples.
  - "Test Connection" button testing the active provider and displaying latency (e.g. `✓ Connected (342 ms, gemini-2.5-pro)` or actionable error).

#### 4. Automated Verification & Tests
- Add unit tests for Google AI Studio & Meta Muse adapters with mocked HTTP responses:
  - Successful JSON completion parsing.
  - Authentication failure (401/403) handling.
  - Timeout and network error handling.
  - Ping diagnostic tests for each provider.
- Test Settings backend model/provider switcher.
- Run full non-browser vitest suite (`npx vitest run --exclude '**/browser/**'`).
- Run `npm run typecheck`, `npm run lint`, and `node scripts/check-project-context.mjs`.

---

### Expected Handoff Output
Provide the completed handoff block required by `AGENTS.md`:

Task: Phase 2.2 direct cloud providers (Google AI Studio & Meta Muse)
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

### Official Handoff
```text
Task: Phase 2.2 direct cloud providers (Google AI Studio & Meta Muse)
Outcome: New scripts/google-client.mjs (generateContent + ?key=, JSON mode, gemini-2.5-pro/flash chain) and scripts/meta-client.mjs (Responses API, Bearer, meta-muse default, tolerant output parsing), both normalizing to {model, content} with OpenRouter-identical failover semantics; new scripts/ai-provider.mjs selector (ACTIVE_AI_PROVIDER) consumed by tailor-provider, salary-facts, and settings ping. Settings backend gained activeProvider + per-provider snapshot (chain, configured, fingerprint), provider/model switching in .env.local, and unified pingProvider (legacy pingOpenRouter kept as wrapper). AI tab rebuilt with provider radio cards, status pills, per-provider model inputs with example placeholders, and Test Connection with ✓ Connected (ms, model) output.
Status: implemented
Files changed:
  - scripts/google-client.mjs (new)
  - scripts/meta-client.mjs (new)
  - scripts/ai-provider.mjs (new)
  - scripts/tailor-provider.mjs
  - scripts/extract-salary-facts.mjs
  - src/server/settings.ts
  - app/api/settings/ai-test/route.ts
  - components/settings/SettingsModal.tsx
  - tests/unit/scripts/google-client.test.ts (new)
  - tests/unit/scripts/meta-client.test.ts (new)
  - tests/unit/scripts/ai-provider.test.ts (new)
  - tests/unit/server/settings.test.ts
  - tests/unit/server/data-routes.test.ts
  - tests/unit/components/settings/SettingsModal.test.tsx
Migrations/data effects: none; env-file keys only (ACTIVE_AI_PROVIDER, GEMINI_MODEL, GEMINI_FALLBACK_MODEL, META_MODEL, META_FALLBACK_MODEL)
Verification performed and exact result:
  - Provider client suites 48/48 (chain, failover matrix, body/endpoint shapes, 401 fast-fail, timeout/network, blocked-prompt, tolerant parsing).
  - Settings focused files 35/35 (snapshot per-provider, switch incl. provider + clears, ping per provider incl. auth/payload failures, route body validation).
  - Full non-browser suite: 115 files / 881 tests pass.
  - npm run typecheck: 0 errors.
  - npm run lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 before and after.
  - CLI smoke: google/meta no-key paths exit 0 with correct key names and valid resume-proposal/v1 / salary-facts/v1 envelopes.
Acceptance criteria not yet proven:
  - Live calls to Google/Meta endpoints (all HTTP mocked; needs real keys + network).
  - Meta response-shape tolerance beyond the three coded shapes (documented in client header).
Decisions or deviations:
  - Clients live in scripts/*.mjs (not src/providers/) so the plain-node CLIs import them without a TS loader, matching the established pattern; TS consumes them as the existing untyped precedent does.
  - Salary-facts wired to the selector too (worker-driven — leaving it OpenRouter-only would silently split provider behavior).
  - Meta has no default fallback (single-model chain unless META_FALLBACK_MODEL set).
  - Provider errors branch on {kind,status} shape, not instanceof, keeping one exit-code contract.
  - switchModels response gained activeProvider (one exact-equality test updated).
  - Snapshot keeps legacy models (active chain) + openRouter fields untouched.
Safety/human checkpoint:
  - Keys stay in .env.local/process env only — never written by the switcher, never in snapshots (fingerprints/booleans; asserted key-absent in JSON), never in diagnostics; ResumeProposalV1 contract, exit codes, validation, and deterministic fallback unchanged; provider switch applies on restart like model switches.
```




---

## Record 8: Settings Career Profiles & Master Resume Management

**Work Order ID:** `WO-1.1-G`  
**Phase:** Phase 2.3  
**Commit:** `29ac8cf`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are implementing Phase 2.3 of `docs/roadmap-v1.1.md` (Settings UI for Career Profiles & Master Resume).

### Mandatory Context & Rules
1. Inspect before modifying:
   - `src/db/candidates.ts` (Phase 2.1 CRUD: `listProfiles`, `createProfile`, `updateProfile`, `setDefaultProfile`, `getDefaultProfile`)
   - `src/domain/candidate.ts` (`WorkPreferencesV1`, `CareerProfileV1`, `CandidateProfilePayloadV1`)
   - `src/server/settings.ts` (`getSettingsSnapshot`, `resyncMasterResume`)
   - `components/settings/SettingsModal.tsx` (Candidate Profile tab)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Non-negotiable truth boundary: Profile metadata and preferences are steering metadata only; they never invent candidate facts or bypass fact citations.
4. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 2.3 Settings Career Profiles & Master Resume

#### 1. API Endpoints (`app/api/settings/profiles/`)
- Add profile management routes:
  - `GET /api/settings/profiles`: List all career profiles with versions/facts count and default flag.
  - `POST /api/settings/profiles`: Create a new named career profile (`name`, `displayName`, `workPreferences`, `executiveNarrative`).
  - `PATCH /api/settings/profiles/[id]`: Update profile metadata (`displayName`, `workPreferences`, `executiveNarrative`).
  - `POST /api/settings/profiles/[id]/set-default`: Switch the system default profile.
- Add Master Resume download route or payload handler:
  - `GET /api/settings/master-resume`: Download current master-resume JSON.
  - `POST /api/settings/master-resume`: Upload/save master-resume content and re-sync.

#### 2. Settings Backend Integration (`src/server/settings.ts`)
- Include the list of profiles (`CareerProfileV1[]`) in `SettingsSnapshot` or the dedicated profiles route.
- Allow `resyncMasterResume` to target a specific `profileId` (defaulting to the default profile).

#### 3. Settings Modal UI (`components/settings/SettingsModal.tsx`)
- Rebuild the **Candidate Profile** tab into two clean subsections:
  1. **Career Profiles**:
     - Card list of configured profiles showing display name, slug, active version, approved facts count, and a `Default` badge.
     - "Set Default" button on non-default profiles.
     - "New Career Profile" modal or inline form with fields:
       - Name (slug), Display Name.
       - Work Preferences: Work Mode (Remote/Hybrid/Onsite), Authorization, Sponsorship Required (Yes/No), Relocate (Yes/No), Years of Experience, Salary Range (Min / Target).
       - Executive Narrative textarea.
     - "Edit" button to adjust preferences and executive narrative on existing profiles.
  2. **Master Resume Document**:
     - Display current active resume version, last synced timestamp, and verified skills count.
     - One-click **Download JSON** button.
     - **Upload / Replace Master Resume** file input (`.json`) with validation error reporting and immediate re-sync.

#### 4. Automated Verification & Tests
- Add unit tests for profile API routes (`tests/unit/routes/profiles.test.ts`):
  - Profile listing, creation, editing, and default switching.
  - Validation of work preferences and unique name slug.
- Update `SettingsModal.test.tsx` to verify profile tab interactions and rendering.
- Run full non-browser vitest suite (`npx vitest run --exclude '**/browser/**'`).
- Run `npm run typecheck`, `npm run lint`, and `node scripts/check-project-context.mjs`.

---

### Expected Handoff Output
Provide the completed handoff block required by `AGENTS.md`:

Task: Phase 2.3 settings career profiles and master resume management
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

### Official Handoff
```text
Task: Phase 2.3 settings career profiles and master resume management
Outcome: Settings modal Candidate Profile tab rebuilt into Career Profiles (card list with Default badge, set-default, inline create/edit form for slug/display/preferences/narrative) and Master Resume Document (active version, last-synced timestamp, verified skills, JSON download, validated upload with immediate re-sync) sections, backed by profile + master-resume API routes and targeted re-sync.
Status: implemented
Files changed:
  - src/domain/candidate.ts (ProfileId schema: UUIDs plus "local" legacy root)
  - src/server/candidates.ts (importCandidate accepts optional profileId; new profile-not-found result; per-profile version numbering)
  - src/server/settings.ts (ProfileSummary + listProfileSummaries; resyncMasterResume targets explicit profileId or the default profile; latest-version lookup scoped per profile; parseMasterResumeDocument shared by re-sync and upload; snapshot profile gains activeVersionAt)
  - app/api/settings/profiles/route.ts (new: GET list, POST create w/ 409)
  - app/api/settings/profiles/[id]/route.ts (new: PATCH metadata, 404)
  - app/api/settings/profiles/[id]/set-default/route.ts (new: POST, 404)
  - app/api/settings/master-resume/route.ts (new: GET download, POST validate-then-write-then-resync with 2MB cap and atomic rename)
  - components/api.ts (apiPatch client)
  - components/settings/SettingsModal.tsx (two subsections, ProfileForm, upload/download/set-default wiring, malformed-list hardening)
  - tests/unit/routes/profiles.test.ts (new)
  - tests/unit/components/settings/SettingsModal.test.tsx
Migrations/data effects: none (uses Phase 2.1 multi-profile schema as-is)
Verification performed and exact result:
  - New route suite 13/13 (list/create/409/slug+pref validation, patch/clear/404, set-default flip/404, download 404, upload roundtrip, invalid-upload writes nothing, explicit-profile targeting, unknown profile 404).
  - Modal suite 13/13 (7 existing incl. 2 fetch-count updates for the new profiles fetch, 6 new: list render, set-default, create body, edit prefill+patch body, non-JSON upload error, upload re-sync).
  - Full non-browser suite: 116 files / 900 tests pass (2 consecutive green runs; a third-party flake in tests/unit/server/queries.test.ts batch ordering fails ~1 in 3 runs and was proven pre-existing: flakes standalone 2/6 with both files untouched by this task).
  - npm run typecheck: 0 errors.
  - npm run lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 before and after.
Acceptance criteria not yet proven:
  - Visual layout of the rebuilt tab at 13in/4K viewports (no browser in sandbox; markup follows existing modal conventions).
  - End-to-end upload roundtrip through a real browser (covered at route + component level only).
Decisions or deviations:
  - resyncMasterResume/importCandidate resolve the real default profile instead of the legacy "local" id (required once a non-local default exists; fresh DBs still bootstrap "local").
  - Profiles served from a dedicated GET route, not bloating SettingsSnapshot; snapshot gains only activeVersionAt.
  - Edit form merges over preserved preferences (target titles/locations survive) and sends null to clear the narrative.
  - Two existing fetch-count assertions updated 1->2 (new profiles fetch on open is intended behavior, not a regression).
Safety/human checkpoint:
  - Profiles stay steering metadata only (no claim/fact path touched); upload validates before writing and re-syncs through the human-actor import path; no keys, paths, or secrets serialized; mutations stay behind the Host/Origin gate; no ATS/application behavior changed.
```

---

## Record 9: Interactive Tailoring in Job Workspace

**Work Order ID:** `WO-1.1-H`  
**Phase:** Phase 2.4  
**Commit:** `ab1b98f`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are implementing Phase 2.4 of `docs/roadmap-v1.1.md` (Interactive Tailoring in Job Workspace: Profile Selector, ATS Keywords & Directives).

### Mandatory Context & Rules
1. Inspect before modifying:
   - `components/board/CardDrawer.tsx` (Tailoring & Resumes tab)
   - `src/server/tailoring.ts` and `src/tailoring/enqueue.ts` (`TailorPayloadV1`, `requestTailoring`)
   - `src/tailoring/orchestrate.ts` and `src/tailoring/provider.ts` (`TailorInputV1`, prompt construction, and `input_hash` calculation)
   - `src/db/schema/analysis.ts` and `src/db/candidates.ts` (retrieving profile version & candidate snapshot for selected `profileId`)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Non-negotiable truth boundary: Selected keywords and directives steer ranking and wording, but MUST NOT invent unapproved candidate facts. All claims must cite approved `fact_id`s. Unsupported requirements must remain explicit gaps.
4. Lineage & Auditability: Selected `profileId`, `selectedKeywords`, and `directives` must be recorded in the tailoring input and hashed into `input_hash`.
5. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 2.4 Interactive Tailoring in Job Workspace

#### 1. ATS Keywords Extraction Helper
- Implement deterministic ATS keywords extractor from the job description text/extraction:
  - Extracts frequency/significance-ranked technical keywords, frameworks, and domain concepts (Top 10).
  - Expose via API or lightweight client utility for the drawer.

#### 2. Tailoring Queue & Envelope Updates (`R-ADR-013`)
- In `src/tailoring/enqueue.ts`:
  - Extend `TailorPayloadV1` to include:
    - `profileId`: optional `ProfileId` (defaults to active default profile)
    - `selectedKeywords`: optional array of strings (max 20)
    - `directives`: optional string (max 1000 chars)
  - Ensure idempotency key remains distinct when user requests re-tailoring with new directives/profile.
- In `src/tailoring/orchestrate.ts` & `provider.ts`:
  - Incorporate `selectedKeywords` and `directives` into the prompt construction for the AI provider.
  - Bind candidate facts from the chosen `profileId`'s active version.
  - Include `profileId`, `selectedKeywords`, and `directives` in the canonical JSON hashed into `job_analyses.input_hash`.

#### 3. Tailoring Route Updates (`app/api/jobs/[id]/tailor/` or `tailor-retry`)
- Allow passing `{ profileId, selectedKeywords, directives }` in the POST body to trigger tailoring or re-tailoring.

#### 4. Job Workspace UI in Card Drawer (`components/board/CardDrawer.tsx`)
- In the **Tailoring & Resumes** tab, add the **Tailoring Guidance** panel:
  - **Career Profile Selector**: Dropdown showing all profiles with their display name and default badge.
  - **Top 10 ATS Keywords**: Extracted from the job description, displayed as clickable toggle chips (`[Kubernetes ✓]`, `[PostgreSQL]`).
  - **Directive Notes**: Textarea for custom instructions with 3 one-click starter pills above:
    1. 🏷️ *"Emphasize profile skills"*
    2. 🏷️ *"Prioritize B2B SaaS experience"*
    3. 🏷️ *"Highlight quantifiable KPI results and metrics"*
    - Clicking a pill appends that text into the textarea.
  - **Tailor / Re-Tailor Button**: Dispatches the tailoring run with the chosen profile, keywords, and directives. Displays inline progress/status.

#### 5. Automated Verification & Tests
- Unit tests for ATS keyword extraction.
- Unit tests for queue payload validation, idempotency, and envelope hashing with directives/keywords.
- Test tailoring route with profile selection and directives payload.
- Update `CardDrawer.test.tsx` to verify interactive tailoring controls.
- Run full non-browser vitest suite (`npx vitest run --exclude '**/browser/**'`).
- Run `npm run typecheck`, `npm run lint`, and `node scripts/check-project-context.mjs`.

---

### Expected Handoff Output
Provide the completed handoff block required by `AGENTS.md`:

Task: Phase 2.4 interactive tailoring in job workspace
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

### Official Handoff
```text
Task: Phase 2.4 interactive tailoring in job workspace
Outcome: Tailoring Guidance panel in the drawer (profile selector, Top-10 ATS keyword chips, directive starters + notes, Tailor/Re-tailor button) backed by guidance-scoped queue payloads, envelope hashing, targeted candidate binding, provider prompt steering, and a guided retry route.
Status: implemented
Files changed:
  - src/domain/atsKeywords.ts (new)
  - src/tailoring/enqueue.ts
  - src/tailoring/contract.ts
  - src/tailoring/orchestrate.ts
  - src/tailoring/handler.ts
  - src/tailoring/persist.ts
  - src/server/candidates.ts
  - src/server/tailoring.ts
  - app/api/jobs/[id]/tailor/retry/route.ts
  - src/db/tailoring.ts
  - scripts/tailor-provider.mjs
  - components/board/CardDrawer.tsx
  - tests/unit/domain/atsKeywords.test.ts (new)
  - tests/unit/tailoring/enqueue.test.ts (new)
  - tests/unit/scripts/tailor-provider.test.ts (new)
  - tests/unit/components/board/CardDrawer.test.tsx
  - tests/unit/routes/tailor-retry.test.ts
  - tests/unit/server/candidates.test.ts
  - tests/unit/tailoring/orchestrate.test.ts
Migrations/data effects: none (input_hash column already stores the envelope hash; guidance rides existing payload/snapshot machinery)
Verification performed and exact result:
  - Extractor 6/6, enqueue 8/8, provider script 6/6, orchestrate 9/9 (incl. guidance hash fork + determinism), retry route 9/9, drawer 16/16, candidates server 15/15.
  - Full non-browser suite: 119 files / 931 tests pass, twice consecutively.
  - npm run typecheck: 0 errors.
  - npm run lint: 0 warnings.
  - node scripts/check-project-context.mjs: 11/11 before and after.
  - CLI smoke: guided envelope through tailor-provider.mjs exits 0 with a valid resume-proposal/v1 on both the live path (repo .env.local key) and the no-key fallback path.
Acceptance criteria not yet proven:
  - Guidance-panel layout at 13in/4K viewports (no browser in sandbox).
  - Live guided run end-to-end through the worker (covered at enqueue/orchestrate/route/component levels only).
Decisions or deviations:
  - Work-order names corrected to the code (TailoringInputV1 in contract.ts; no src/tailoring/provider.ts — the prompt lives in scripts/tailor-provider.mjs).
  - Guided re-tailoring on AWAITING_REVIEW/APPROVED jobs is a 409 directing to the revision flow; no fake review transitions.
  - Legacy unguided path byte-identical (same key, same payload shape); old queued payloads still parse (tested).
  - No-key fallback prioritizes keyword-bearing lines (stable, deterministic) so guidance is effective offline; directives there are record-only.
  - Retry body now validated (was ignored); all callers already post JSON.
Safety/human checkpoint:
  - Guidance steers ranking/wording only: prompt section subordinated to evidence rules, quotes stay verbatim, gaps stay gaps, claims still require approved fact_ids; profileId/keywords/directives hashed into input_hash for lineage; no ATS/application behavior changed.
```

---

## Record 10: Resumes Section Hierarchy & Derived Follow-Up Indicators

**Work Order ID:** `WO-1.1-I`  
**Phase:** Phase 3.1 & 3.4  
**Commit:** `3de1956`  

### Prompt Given to Agent
```markdown
You are working on the Local Job Tracker repository on branch `release/v1.0`.
We are implementing Phase 3.1 and Phase 3.4 of `docs/roadmap-v1.1.md` (Resumes Section Hierarchy & Derived Follow-Up Indicators).

### Mandatory Context & Rules
1. Inspect before modifying:
   - `components/board/CardDrawer.tsx` (`renderResumes` section)
   - `components/board/ResumeReview.tsx` (version review layout, artifacts links, approve/revise action bar)
   - `components/board/JobCard.tsx` (card rendering, applied status, badge placement)
   - `src/domain/board.ts` (card view model, `appliedAt` field)
2. Follow `AGENTS.md` and `PROJECT.md`.
3. Non-negotiable truth boundary: All document preview links open generated artifacts via safe artifact IDs in new browser tabs (`target="_blank"`). Manual human approval and manual application remain strictly required.
4. Run `node scripts/check-project-context.mjs` before and after.

---

### Work Order Scope: Phase 3.1 & 3.4

#### 1. Master Resume Preview & Empty State (Phase 3.1)
- In `components/board/CardDrawer.tsx`:
  - Add a **Master Resume** card at the top of the Resumes tab showing the active master profile name, version, and a direct `[Preview]` button opening the master resume preview in a new tab.
  - If `v.resumes.length === 0`: Display a helpful empty state guiding the user: *"No tailored resumes generated yet. Choose your profile and keywords below to tailor a resume for this role."*

#### 2. Scannable Resume Version List & Drill-Down (Phase 3.1)
- Replace the legacy `<select>` dropdown with a list of version cards:
  - Each version card displays:
    - Version label (e.g. `Version 2`)
    - Review status badge (`Awaiting review`, `Approved`, `Revision requested`)
    - Associated profile name (e.g. `Profile "Primary Profile"`)
    - Direct preview buttons: `[DOCX]`, `[MARKDOWN]`, `[PDF]` that open the artifact directly in a new tab (download buttons removed to eliminate visual clutter).
  - Clicking a version card selects it as the active version for deep audit drill-down:
    - Displays Requirements Match Status (Matched, Partial, Gap).
    - Displays Selected ATS Keywords and cited facts.
    - Displays Proposed Changes & Summary.
    - Action bar with Approve / Revise controls.

#### 3. Derived Follow-Up Badges on Applied Cards (Phase 3.4)
- In `components/board/JobCard.tsx`:
  - For cards in the `APPLIED` column:
    - Calculate elapsed days since `card.appliedAt`.
    - If $\ge 7$ days: display a clean, subtle badge:
      - $\ge 30$ days: `Follow-up suggested (30d+)`
      - $\ge 14$ days: `Follow-up suggested (14d)`
      - $\ge 7$ days: `Follow-up suggested (7d)`
    - Omit badge if applied within the last 6 days or if `appliedAt` is absent.
  - Derived purely on the client with zero database mutations or background jobs.

#### 4. Automated Verification & Tests
- Add/update unit tests in `tests/unit/components/board/JobCard.test.tsx` (or `mutate.test.ts` / new test file) verifying:
  - Follow-up badge renders correctly at 7d, 14d, 30d thresholds.
  - Follow-up badge does not render on recent applications (< 7d) or non-Applied columns.
- Update `CardDrawer.test.tsx` and `ResumeReview.test.tsx` verifying:
  - Master resume preview card renders with new tab link.
  - Version cards render with preview links `[DOCX]`, `[MARKDOWN]`, `[PDF]`.
  - Selecting a version card updates drill-down audit and review controls.
- Run full non-browser vitest suite (`npx vitest run --exclude '**/browser/**'`).
- Run `npm run typecheck`, `npm run lint`, and `node scripts/check-project-context.mjs`.

---

### Expected Handoff Output
Provide the completed handoff block required by `AGENTS.md`:

Task: Phase 3.1 resumes section hierarchy and Phase 3.4 derived follow-up indicators
Outcome:
Status: implemented | needs-review | blocked
Files changed:
Migrations/data effects:
Verification performed and exact result:
Acceptance criteria not yet proven:
Decisions or deviations:
Safety/human checkpoint:
```

### Official Handoff
```text
Task: Phase 3.1 resumes section hierarchy and Phase 3.4 derived follow-up indicators
Outcome: Resumes tab rebuilt with a Master Resume card (profile, version, new-tab preview page), scannable version cards with status/profile and [DOCX]/[MARKDOWN]/[PDF] new-tab previews plus click-to-select audit drill-down, guided empty state, and client-derived follow-up badges on stale Applied cards.
Status: implemented
Files changed:
  - app/master-resume/page.tsx (new: server-rendered, React-escaped master resume preview of the default profile's active version)
  - src/server/board.ts (BoardCardView.appliedAt via LEFT JOIN, same query count; ResumeVersionView profileName/profileDisplayName via one batched version->analysis->snapshot->profile lineage query)
  - components/board/CardDrawer.tsx (master card, version cards replacing the select, new empty state, guidance panel moved below versions)
  - components/board/JobCard.tsx (follow-up badge at 7d/14d/30d+)
  - tests: unit/components/board/JobCard.test.tsx (new), CardDrawer hierarchy suite, board server appliedAt/lineage assertions, fixture updates for the new view fields
Migrations/data effects: none (read-model joins only)
Verification performed and exact result:
  - JobCard 9/9 (thresholds, recency, non-applied, absent/future/invalid).
  - CardDrawer 20/20 (master card + Preview target, empty-state copy, version cards + preview hrefs/targets, selection swaps drill-down).
  - Board server incl. lineage/appliedAt assertions green; ResumeReview suite green unchanged; board-perf query budget green.
  - Full non-browser suite: 120 files / 945 tests pass, three consecutive runs (known queries.test.ts flake absent this round).
  - npm run typecheck: 0 errors.
  - npm run lint: clean, exit 0.
  - node scripts/check-project-context.mjs: 11/11 before and after.
Acceptance criteria not yet proven:
  - Visual hierarchy at 13in/4K viewports (no browser in sandbox).
  - Preview page render against a real database (covered by code review; no page-level test harness exists).
Decisions or deviations:
  - New /master-resume page instead of reusing the JSON download: the work order requires a preview, and a server page auto-escapes.
  - Guidance panel moved below the versions list so the empty-state "below" copy is literally true.
  - Download removal scoped to version cards only; ResumeReview keeps Preview+Download (review evidence + approval flow need files).
  - ResumeReview.tsx untouched (no changes needed); selection coverage lives in CardDrawer.test.tsx.
  - Follow-up clock read once per mount (render purity rule); midnight staleness refreshes on remount/reload.
  - Lint fixes: inlined version-select handler (rule traces named helpers to ref reads), useState clock init, dropped dead disable directive.
Safety/human checkpoint:
  - All previews open by artifact id / fixed route in new tabs with rel="noreferrer"; no paths serialized; approval and application stay manual; badge is a read-only client derivation (zero mutations).
```

