# UI/UX Design & Frontend Polish Specification

> **Target Role**: UI/UX Design Specialist & Frontend Interaction Engineer  
> **Execution Window**: Immediately following functional completion of R4-G & R5-A  
> **Mission**: Overhaul visual hierarchy, typography clarity, viewport adaptation, and micro-interactions across all application surfaces, creating a polished, professional, dense-yet-breathable local desktop experience.

---

## 1. Design System & Foundational Tokens

### Typography & Hierarchy
The application is a data-dense tool for experienced professionals. Typography must prioritize instant scannability on dense cards and comfortable reading on long job descriptions.

- **Primary Font Family**: Clean modern sans-serif (`font-sans`: Geist Sans, Inter, or system SF Pro).
- **Monospace Font Family**: (`font-mono`: Geist Mono, JetBrains Mono, or SF Mono) for:
  - Currency amounts (`$145,900 – $197,400 CAD`)
  - Timestamps, dates, and durations (`12s elapsed`, `2026-09-12`)
  - Content hashes, fact IDs (`[fact_aot_001]`), and file sizes
- **Scale & Leading**:
  - Page Titles: `text-2xl font-bold tracking-tight`
  - Section Headings: `text-base font-semibold tracking-tight`
  - Card Titles: `text-sm font-semibold leading-snug`
  - Body & Descriptions: `text-sm leading-relaxed` (avoid line lengths exceeding 75ch)
  - Metadata & Badges: `text-xs font-medium` and `text-[11px] font-medium tracking-wide`
- **Contrast & Legibility**:
  - Enforce WCAG AA compliance (4.5:1 minimum contrast ratio).
  - Secondary text (`text-muted-foreground`) must remain crisp and readable in both dark and light modes—never faded to gray invisibility.

### Color Semantics (Light & Dark Mode)
Use Tailwind / shadcn semantic tokens exclusively:
- **Surface**: `bg-background`, `bg-card`, `bg-muted/40`
- **Borders**: `border-border/80`, `border-border/40` for inner dividers
- **Status Accents**:
  - **Success / Tailored / Evidenced**: Emerald tones (`text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800`)
  - **Warning / Review Required**: Amber tones (`text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800`)
  - **Info / In-Progress**: Blue/Sky tones (`text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-800`)
  - **Destructive / Gap**: Rose/Red tones (`text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800`)

---

## 2. Viewport & Canvas Optimization

### The Kanban Board (`/board`)
- **Full Viewport Mechanics**:
  - Use `h-[calc(100vh-theme(spacing.16))]` so the board fits within the browser window without outer body scrollbar jumping.
  - Column containers must scroll vertically with custom slim scrollbars (`overflow-y-auto`).
  - The Kanban board scrolls horizontally smoothly across columns with sticky column headers.
- **Laptop vs. Ultra-Wide Adaptation**:
  - **Laptop Screens (13"–16", 1280px–1536px)**: Columns scale to `w-[280px] shrink-0` to ensure at least 4 visible columns, with smooth horizontal scroll to reach remaining stages.
  - **Desktop / Ultra-Wide (1700px+)**: Columns expand up to `w-[320px]` with generous column gaps and comfortable reading padding.
  - **Stacked View Toggle**: Maintain the single-column stacked view toggle for focused sequential processing.

### The Full-Viewport Card Workspace Drawer (`CardDrawer.tsx`)
- **Three-Zone Fixed Architecture**:
  1. **Fixed Header & Action Toolbar**: Sticky at the top (`shrink-0`). Contains Back button, company/title breadcrumb, pipeline stage badge, and primary action buttons (Move, Correct, Close). Never scrolls away.
  2. **Scrollable Center Tabs Area**: (`flex-1 overflow-y-auto min-w-0 pr-4`). Contains the active tab content with smooth vertical scrolling.
  3. **Sticky Context Sidebar**: (`w-[300px] shrink-0 sticky top-4`). Displays Quick Facts, Application Tracker, and Requirement Matches without obstructing main content.
- **Narrow-Screen Fallback**:
  - Collapse context sidebar below main tabs on screens smaller than `1024px` (`lg:grid-cols-[1fr_300px]` $\rightarrow$ `grid-cols-1`).

---

## 3. Component Refinements & Micro-Interactions

### A. The Kanban Job Card (`components/board/JobCard.tsx`)
- **Density & Hierarchy**:
  - Top Line: Company name (`text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate`) + external link icon.
  - Title Line: Job title (`font-semibold text-sm line-clamp-2 text-foreground group-hover:text-primary transition-colors`).
  - Metadata Line:
    - **Prominent Salary Badge**: Highlighted with high-contrast background (e.g. `bg-primary/10 text-primary font-mono text-xs px-2 py-0.5 rounded-md font-semibold`).
    - Arrangement & Location chips (`Remote`, `Toronto, ON`).
  - Status Line:
    - In-Progress indicator: Animated pulse ring (`animate-pulse`) when AI tailoring is running.
    - Tailored / Review badge: High-visibility chip (`Resume v1 · Awaiting Review`).
- **Drag-and-Drop Physics (`@dnd-kit`)**:
  - Dedicated grip handle with hover elevation (`hover:bg-muted/60`).
  - When dragging: subtle 1.5° tilt, elevated drop-shadow (`shadow-xl ring-2 ring-primary ring-offset-2 opacity-90`).
  - Drop transition: smooth cubic-bezier easing into the new slot without instant snap.

### B. The Card Workspace Drawer (`components/board/CardDrawer.tsx`)
- **Tab Switching**:
  - Zero layout shift: Tabs use `min-h-[400px]` with fade-in transition (`animate-in fade-in-50 duration-150`).
  - Active Tab indicator: Clear high-contrast underline or pill with smooth transition.
- **Live Progress Card**:
  - Shows when `tailoringState === 'RUNNING'`:
    - Spinning AI sparkles icon.
    - Live elapsed timer (`14s elapsed`).
    - Step tracker: `1. Scrape` $\rightarrow$ `2. AI Facts & Keywords` $\rightarrow$ `3. PDF Render`.
- **Compensation & Facts Panel**:
  - Grid layout with bordered metric tiles.
  - Salary Min/Max prominently highlighted.
  - Compensation Highlights rendered as distinct pill tags (e.g. `[Equity]`, `[RRSP Match]`, `[Wellness Stipend]`).
  - Top 5 ATS Keywords displayed in an organized chip cluster with category tags.

### C. Resume Review & Side-by-Side Audit (`components/board/ResumeReview.tsx`)
- **Layout Structure**:
  - Equal 2-column comparison on large screens (`xl:grid-cols-2`), clean stacked layout on smaller screens.
  - **Left**: Proposed Resume Changes & Evidenced Claims with expandable source facts.
  - **Right**: Job Requirements & Top 5 ATS Keywords Audit.
- **ATS Keyword Match Cards**:
  - Evidenced keywords: Green pill with checkmark + placement tag (`Summary`, `Skills`, `Experience`).
  - Gap keywords: Red/rose pill with honest gap icon (`Not on resume`).
- **Sticky Human Approval Bar**:
  - Sticky at bottom of the review tab:
    - `Approve Resume` (primary brand button, high contrast).
    - `Request Revision` (secondary outline button).
    - Confirmation modal with clear explanation that approval moves the job to `TAILORED`.

### D. Settings & Data Management Modal (`components/settings/SettingsModal.tsx`)
- **Visual Design**:
  - Centered Radix Dialog with backdrop blur (`backdrop-blur-sm bg-background/80`).
  - Clear tabbed layout: `Data & Backup`, `AI & Models`, `Candidate Profile`.
  - Backup Export: Prominent download card with file size indicator.
  - Board Reset: Destructive section visually isolated with warning border and required type-to-confirm dialog.

### E. App Header & Global Navigation (`components/AppHeader.tsx`)
- **Styling**:
  - Subtle sticky frosted-glass header (`sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60`).
  - Left: Clean wordmark (`Antigravity Tracker`) + pipeline stage tabs (`Board`, `Intake`).
  - Right: Clean cluster:
    - Global `+ Add Job` button.
    - `Settings (⚙️)` trigger.
    - Theme toggle (Dark / Light mode).

---

## 4. Motion & Micro-Interactions Standards

| Action | Target Transition | Timing / Easing |
| :--- | :--- | :--- |
| **Modal Open/Close** | Opacity fade + subtle zoom (`scale-95` to `scale-100`) | `150ms ease-out` |
| **Drawer Open/Close** | Slide-in from right or expand with backdrop fade | `200ms cubic-bezier(0.16, 1, 0.3, 1)` |
| **Tab Change** | Instant swap with fast fade (`opacity 0 -> 1`) | `120ms ease-in-out` (Zero layout jump) |
| **Card Drag Lift** | Shadow elevation (`shadow-md` to `shadow-xl`) + 1.5° tilt | `100ms ease` |
| **Live AI Spinner** | Smooth 360° rotation + subtle color pulse | `2s infinite linear` |
| **Button Click** | Active scale-down (`active:scale-[0.98]`) | `75ms ease` |

---

## 5. Design Verification Checklist

When performing the design pass, verify every item:
- [ ] **Light Mode**: All text has strong contrast; borders are clean; no washed-out grays.
- [ ] **Dark Mode**: Deep card backgrounds (`#09090b` / `#18181b`); borders are subtle; badges remain vibrant.
- [ ] **13" MacBook Screen (1280x800)**: Board scrolls horizontally; cards don't truncate awkwardly; drawer fits comfortably.
- [ ] **27" 4K Monitor (3840x2160)**: Columns have bounded maximum widths; lines of text don't stretch into unreadable horizontal strips.
- [ ] **Keyboard Navigation**: Pressing `Tab` renders a distinct, accessible focus ring (`ring-2 ring-primary ring-offset-2`) around every button, input, and card.
- [ ] **No Layout Shifts**: Opening drawers, switching tabs, or loading async data never causes parent containers to jerk or resize abruptly.
