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



