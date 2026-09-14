# Local Job Tracker — Release 1.1 Roadmap

Status: Complete  
Baseline: v1.0 release branch (`release/v1.0`)  
Release theme: Faster review, interactive multi-profile tailoring, and responsive daily workflow  
Completed: 2026-09-14 (package 1.1.0; execution log in [`work-orders-v1.1.md`](work-orders-v1.1.md))

## Release outcome

Version 1.1 improves the existing job-preparation and review workflow without expanding the application into job discovery, application automation, scheduling, or browser-based document editing.

The release succeeds when:

- The board loads with bounded database queries ($O(1)$), zero empty loading spinners, and snappy main-thread responsiveness (INP $\le 100$ ms on Apple Silicon).
- The Kanban view is more intuitive with larger, more readable cards; default viewport comfortably fits the core 3 buckets (`New`, `Tailored`, `Applied`), while dragging/scrolling smoothly reveals `Interviewed` and `Rejected`.
- Headers are optimized across 13"/14" laptop screens and 4K displays: `Home > Board` breadcrumbs removed, navigation buttons docked next to the logo on the left, and the active profile pill moved next to `Settings` on the right.
- The board header is simplified to a pure Kanban view (Kanban/Stacked toggle removed), prioritizing search, sorting, and active status.
- Users can interactively guide tailoring with clickable Top 10 ATS keywords extracted from the JD, 3 sample directive chips, and selectable career profiles.
- Settings supports multiple career profiles with complete work preferences, executive narrative, and master resume upload/preview/download while strictly preserving visual template styles.
- Resumes section in the job drawer provides a clean hierarchy: master resume preview at the top, version cards with direct new-tab previews (`[DOCX] [MD] [PDF]`), and deep inspection of requirements, selected keywords, and proposed changes upon clicking a version.
- Direct API key support is available for Google AI Studio, Meta Muse, and OpenRouter with user-configurable models and connection diagnostics.
- Cards in `Applied` display derived follow-up indicators after 7, 14, or 30 days of inactivity.
- Human resume approval and manual application remain strictly unavoidable.
- All performance and responsiveness claims are supported by reproducible measurements.

## Non-negotiable constraints

- Every resume claim must remain backed by approved immutable `fact_id` evidence or an allowlisted deterministic derivation.
- User guidance may change emphasis, ordering, and wording, but may not introduce candidate facts.
- Unsupported requirements remain visible gaps and never become resume claims or keywords.
- Resume revisions create new immutable versions.
- Only an explicit human action may approve a resume and move a job to `Tailored`.
- Application submission and application-status recording remain manual.
- The board retains exactly five workflow columns: `New`, `Tailored`, `Applied`, `Interviewed`, and `Rejected`.
- Provider output remains a schema-validated proposal and cannot choose approval state, trusted paths, hashes, templates, or coverage scores.
- Optional cloud providers must never become a required dependency.
- Preview features open via safe artifact IDs in a new tab; no embedded rich document editor.

---

## Phase 0 — Baseline & Architecture Decisions

### Objective
Measure current performance and resolve schema/trust-boundary designs before changing persistence or contracts.

### Work

1. **Repeatable Baseline Measurements**:
   - **Interaction to Next Paint (INP) & Main-Thread Blocking**: Profile button click responsiveness, long tasks ($>50$ ms), and DOM render durations on Apple Silicon with 50+ cards (benchmarking against the recorded 2,448 ms INP issue).
   - **Board Query Count & Latency**: Record exact SQLite query count and execution time for `getBoardView` across representative board sizes (0, 10, 50, 100 cards).
   - **First Render & Hydration Timing**: Measure time from navigation to interactive board paint.
   - **Tailoring Provider Latency**: Measure round-trip proposal generation and schema validation times.

2. **Architecture Decision Records (ADRs)**:
   - **R-ADR-012 — Multi-Profile Schema Migration**: Relax the single-row `candidate_profiles` constraint (`id = 'local'`) to support multiple named career profiles (`id`, `name`, `display_name`, `work_preferences`, `executive_narrative`) while preserving snapshot immutability.
   - **R-ADR-013 — Interactive Tailoring Envelope**: Versioned schema incorporating user-selected ATS keywords, optional guidance notes, and target career profile ID into the immutable input hash.
   - **R-ADR-014 — Provider Abstraction for Google AI Studio & Meta Muse**: Standardized provider adapter mapping Google Studio (`generateContent`) and Meta Muse (`https://api.meta.ai/v1/responses`) into the unified `ResumeProposalV1` contract with local secret handling (`.env.local`).

3. **Performance Benchmark Fixture**:
   - Create an automated, synthetic test fixture with 50 populated jobs, notes, and resume versions to benchmark queries and INP without touching live user databases.

---

## Phase 1 — Board Performance, Instant First-Render & INP Reduction

Release Target: Eliminate main-thread jank; reduce INP from 2,448 ms to $\le 100$ ms on Apple Silicon; eliminate $N+1$ queries.

### 1.1 Bounded Board Queries (Backend $O(1)$)
- Replace per-card note-count and active-resume lookups in `src/server/board.ts` with bounded bulk joins or subquery projections.
- Reduce SQLite queries per board request from $100+$ to a constant $\approx 5$ queries regardless of card count.
- Preserve per-column totals, pagination limits, sort order, and deterministic tie-breaking.

### 1.2 Request-Time Initial Board Data (Zero-Spinner First Render)
- Fetch initial board state on the server in `app/board/page.tsx` and pass `initialData` directly to `<Board />`.
- Eliminates the initial blank screen, loading spinner, and client-side `fetch` waterfall on navigation.

### 1.3 Main-Thread De-Janking & INP Optimization (Target: INP $\le 100$ ms)
- **Concurrent Transitions (`startTransition`)**: Wrap heavy UI state changes (opening card drawer, switching tabs, applying filters) in React 19 `startTransition`. Clicks and button presses react **instantly** ($< 16$ ms) with visible active feedback while complex drawer rendering proceeds non-blockingly.
- **Card Render Isolation (`React.memo`)**: Memoize `JobCard` so that polling ticks (every 3s), search typing, and drawer openings re-render only affected cards rather than re-rendering all 50+ cards simultaneously.
- **CSS Layout & Compositing Containment**:
  - Apply `content-visibility: auto` and `contain: layout style paint` to offscreen cards and columns so the browser skips layout computation for elements outside the viewport.
  - Audit and hardware-optimize heavy `backdrop-blur` filters across sticky headers and modal overlays to prevent macOS Chromium compositing stalls.
- **`dnd-kit` Sensor Tuning**: Tune `PointerSensor` activation constraints and event delegation to eliminate input delay on button clicks.
- **Deferred Modal Content**: Lazy-mount non-visible tabs in `CardDrawer` and `SettingsModal` rather than mounting all tab trees into the DOM upfront.

### 1.4 Loading & Notification Behavior
- Accessible, non-blocking auto-dismissing toast notifications for successes (3s timer).
- Persistent alerts only for errors, conflicts, and approval requirements.

---

## Phase 2 — Controllable, Multi-Profile Tailoring & Direct Cloud Providers

### 2.1 Interactive Tailoring in Job Workspace
- **Location**: Resides directly in the **Tailoring & Resume** section of the card drawer.
- **Career Profile Selector**: Dropdown allowing the user to select which career profile to tailor from (e.g. `[ Senior Full Stack Lead ▾ ]`).
- **Interactive Top 10 ATS Keywords**:
  - Automatically extracts and displays the **Top 10 ATS Keywords** from the scraped job description as clickable toggle chips (e.g. `[Kubernetes ✓]`, `[Distributed Systems ✓]`).
  - Selected keywords are passed into the tailoring input envelope to prioritize matching approved facts for those terms.
- **Tailoring Directives & Sample Chips**:
  - Directive notes textarea with 3 one-click starter pills:
    1. 🏷️ *"Emphasize profile skills"*
    2. 🏷️ *"Prioritize B2B SaaS experience"*
    3. 🏷️ *"Highlight quantifiable KPI results and metrics"*
  - Clicking a pill appends the guidance into the text box for user editing.
- **Strict Truth Boundary**: Guidance and keywords steer ranking and narrative, but *cannot introduce unapproved facts*. Every resulting claim must still cite an approved `fact_id`.
- **Lineage & Auditability**: Selected profile, keywords, and guidance are hashed into the immutable tailoring input and recorded in the provider attempt history.

### 2.2 Multiple Career Profiles & Master Resume Management in Settings
- **Multiple Career Profiles**:
  - In Settings > Candidate Profile, configure and switch between multiple distinct career tracks (e.g. "Staff Engineer", "Engineering Manager", "Solutions Architect").
  - Structured fields per profile:
    - **Personal Info**: Full name, contact details, links.
    - **Work Preferences**: Work Authorization, Work Mode (Remote/Hybrid/Onsite), Visa Sponsorship Needed (Yes/No), Willing to Relocate (Yes/No), Years of Experience, Salary Expectation (Min/Target), Target Job Titles, Target Locations.
    - **Executive Narrative**: Core career pitch and positioning.
    - **Categorized Skills, Keywords, Languages, and Custom Notes**.
- **Master Resume Upload, Preview & Download**:
  - Clear schema documentation showing recommended structure (JSON, YAML, Markdown).
  - Upload or paste master resume content to generate a new verified version.
  - Live in-app preview of parsed candidate facts and one-click JSON/text download.
  - **Preservation of Visual Look**: HTML/CSS (`src/resumes/template.ts`) and DOCX (`templates/mouad_standard_v1.docx`) templates strictly govern typography, margins, `#213c6b` accent bars, and 1-page geometry. Profile content updates populate the exact same polished styling.
- **Re-Tailoring**: Switching career profiles on an existing job and re-tailoring creates a clean, immutable new version (e.g. `Resume v2`) bound to the chosen profile.

### 2.3 Direct Cloud Providers (Google AI Studio & Meta Muse)
- **Provider Selector in Settings**:
  - **Google AI Studio** (`gemini-2.5-pro`, `gemini-2.5-flash`, etc.) via API key.
  - **Meta Muse** (`https://api.meta.ai/v1/responses`) via Bearer token API key.
  - **OpenRouter** (existing default).
- **Configuration & Diagnostics**:
  - User-editable model input field with recommended defaults.
  - One-click **"Test Connection"** diagnostic button validating auth, latency, and model availability before saving.
  - API keys stored securely in `.env.local` (never committed, never in SQLite, never in backups).
- **Local Models**: De-scoped from v1.1 per explicit user directive.

### 2.4 Trusted Resume Template Registry
- Initial allowlisted template identifiers:
  1. **Standard 1-Page** (v1.0 default).
  2. **Compact Technical** (dense, skills-forward layout for senior ICs).
  3. **Executive Narrative** (expanded summary and leadership scope).
- All templates consume the canonical resume view model (`R-ADR-009`) ensuring zero text/claim drift between Markdown, DOCX, and PDF.
- Selected template identifier is recorded in the resume version's immutable lineage.

---

## Phase 3 — Review and Board Workflow Improvements

### 3.1 Streamlined Resumes Hierarchy in Card Workspace
- **Master Resume at the Top**:
  - Clean card showing initial Master Resume with a single `[Preview]` button to view in a new browser tab (`target="_blank"`).
- **Empty State**:
  - If no tailored resumes exist yet: *"No tailored resumes generated yet. Scroll down to choose your profile and keywords to start tailoring."*
- **Version List**:
  - Compact, scannable version cards:
    - `Version 1 · Declined · Profile "Product Manager" · Preview [DOCX] [MARKDOWN] [PDF]`
    - `Version 2 · Awaiting review · Profile "Senior Product Manager" · Preview [DOCX] [MARKDOWN] [PDF]`
  - Clicking `[DOCX]`, `[MARKDOWN]`, or `[PDF]` opens the file preview directly in a new tab. Download buttons removed to eliminate visual clutter.
- **Version Detail Drill-Down**:
  - Clicking a version card selects it and reveals the detailed audit below:
    - **Requirements & Match Status** (Matched, Partial, Gap)
    - **Selected ATS Keywords & Evidence Citations**
    - **Proposed Changes & Summary Narrative**
    - **Action Bar**: Approve / Revise controls.

### 3.2 Intuitive Kanban Viewport & Card Sizing
- **Larger, More Readable Cards**:
  - Increase card and column width (e.g. `min-w-[340px]`, `w-[360px]`, `xl:w-[400px]`) with comfortable internal padding, tabular compensation numbers, and prominent metadata.
- **3-Bucket Focus Viewport (`New`, `Tailored`, `Applied`)**:
  - Default viewport naturally frames the core 3 active stages of an application: `New`, `Tailored`, and `Applied`.
  - The remaining 2 downstream buckets (`Interviewed` and `Rejected`) are revealed smoothly by horizontal dragging, scrolling, or column navigation.
  - Scales gracefully from compact 13"/14" laptop displays up to large 4K monitors.
- **Remove Kanban / Stacked View Switcher**:
  - Permanently lock the board into the pure Kanban view, removing the view toggle to simplify the header and avoid diverging view states.

### 3.3 Clean Header & Navigation Ergonomics
- **Eliminate Breadcrumbs**:
  - Remove redundant `Home > Board` breadcrumbs on `/board/page.tsx` to recover vertical viewing height.
- **Header Layout Restructuring**:
  - **Left**: Brand logo (`Job Tracker`) immediately adjacent to primary navigation buttons (`Board`, `Intake`) for natural eye-flow.
  - **Right**: Move `Mouad Atfi / Profile Active` pill directly next to `Settings` and `Add Job`, grouping profile and settings actions together.
- Ensures the board header remains compact, functional, and responsive on both small laptops and 4K displays.

### 3.4 Derived Follow-Up Indicators
- Cards in the `Applied` column gain a subtle, clean badge if 7, 14, or 30 days have elapsed since application without recorded status change (*"Follow-up recommended"*).
- Derived purely on the client from the human-recorded application timestamp. No background jobs, calendar syncs, or automated emails.

### 3.5 De-Scoped Items (per user directive)
- Embedded in-app document viewer: de-scoped (new-tab preview via artifact ID is approved).
- 3-way theme toggle: de-scoped (current theme is approved).
- Job archiving: de-scoped (5-column board preserved as-is).

---

## Phase 4 — Hardening & Release Gate

- **Verification Suite**:
  - Focused unit tests for multi-profile repository, interactive tailoring envelope, and Google Studio / Meta Muse adapters.
  - Vitest suite (800+ tests) remains 100% green.
  - Strict TypeScript typechecking and ESLint validation (0 errors, 0 warnings).
  - Browser performance & INP verification on Apple Silicon ($\le 100$ ms).
- **Database Migrations**:
  - Checked-in, ordered Drizzle migration for multi-profile candidate schema.
  - Verified against fresh, upgraded, and reset database states.
- **Documentation & Context Check**:
  - Update `docs/status.md`, `docs/operations.md`, and active ADRs.
  - `node scripts/check-project-context.mjs` passes 100%.
- **Release 1.1 Cutover**:
  - Bump package version to `1.1.0`.

---

## Deferred for v1.2+
- Companion cover letters and outreach messages.
- Optimistic workflow mutations.
- Automated reminders, calendar, or email integration.
- Local LLM integrations (Ollama / LM Studio).
