# UI/UX Design & Frontend Polish Specification

> **Target Role**: UI/UX Design Specialist & Frontend Interaction Engineer
> **Execution Window**: R6-A, following functional completion of R4-G & R5-A
> **Mission**: Make the application feel precise, calm, and dense-but-breathable: strong scan paths, restrained type, deliberate whitespace, and minimal functional iconography — with sophisticated, restrained motion.
> **Scope**: Visual hierarchy, layout, typography usage, spacing, responsive behavior, and micro-interactions only. Preserve product behavior, routes, component APIs, and data flows.

---

## Working Rules

- Make reversible visual and layout improvements directly; do not stop at a plan.
- Preserve existing component APIs, routes, and behavior unless a visual fix requires a small presentational change.
- Use the existing design system and Tailwind/shadcn semantic tokens. Do not introduce arbitrary colors, one-off spacing, or a second icon library.
- Keep the result compact. Prefer a small number of high-confidence changes over a broad restyle.
- For each changed surface, state: **issue → change → intended effect**. Include exact classes/tokens for non-obvious decisions.

## Visual Direction

- **Type**: compact body copy, tight but not cramped headings, and visible jumps between hierarchy levels. Small text stays readable, never faded.
- **Spacing**: tight inside controls/cards; noticeably more space between unrelated sections. Consistent 4px-based increments.
- **Surfaces**: quiet neutrals, thin low-contrast borders, restrained shadow use. Content — not decoration — creates structure.
- **Hierarchy**: one primary action or data point per surface. Status color only where status is actionable; never several colored chips competing on one card.
- **Motion**: transform/opacity-only, fast, and interruptible. Motion confirms state changes; it never decorates idle surfaces.

---

## 1. Design System & Foundational Tokens

### Typography & Hierarchy

The application is a data-dense tool for experienced professionals. Typography must prioritize instant scannability on dense cards and comfortable reading on long job descriptions.

> Type tokens below are settled. This consolidation changes spacing, layout, and motion only — not families, scale, or color.

- **Primary Font Family**: Clean modern sans-serif (`font-sans`: Geist Sans, Inter, or system SF Pro).
- **Monospace Font Family**: (`font-mono`: Geist Mono, JetBrains Mono, or SF Mono) for:
  - Currency amounts (`$145,900 – $197,400 CAD`)
  - Timestamps, dates, and durations (`12s elapsed`, `2026-09-12`)
  - Content hashes, fact IDs (`[fact_aot_001]`), and file sizes
- **Scale & Leading**:
  - Page Titles: `text-2xl font-bold tracking-tight` — one per view; do not pair with oversized supporting copy.
  - Section Headings: `text-base font-semibold tracking-tight` — for clear content groups, not every card label.
  - Card Titles: `text-sm font-semibold leading-snug` — max two lines (`line-clamp-2`); the primary scannable label.
  - Body & Descriptions: `text-sm leading-relaxed` (avoid line lengths exceeding 75ch: `max-w-[75ch]`).
  - Metadata & Badges: `text-xs font-medium` and `text-[11px] font-medium tracking-wide` (compact labels only).
- **Numeric metadata**: add `tabular-nums` to every monospace figure (salary, time, dates, counts) so ticking timers and aligned columns never cause layout shift.
- **Contrast & Legibility**:
  - Enforce WCAG AA compliance (4.5:1 minimum contrast ratio).
  - Secondary text (`text-muted-foreground`) must remain crisp and readable in both dark and light modes — never faded to gray invisibility.
  - Never make important metadata depend on low opacity alone; prefer `text-muted-foreground` over `opacity-*`.
- Do not introduce new type sizes unless there is a documented hierarchy gap.

### Spacing & Composition

Use this rhythm before adding any custom values:

```tsx
// Tight: related text, icon + label, badge content
gap-1  // 4px

// Compact: rows inside a card, adjacent controls
gap-2  // 8px

// Default: card internals, form groups
gap-3  // 12px

// Section: separate information groups
gap-5  // 20px

// Viewport: major page regions
px-4 py-5 sm:px-6 lg:px-8
```

```tsx
// Quiet, compact card: use for repeated Kanban/job records
<Card className="rounded-xl border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md">
  <CardContent className="space-y-3 p-3.5">
    {/* company/meta → title → key facts → status */}
  </CardContent>
</Card>
```

Rules:

- Keep a card's internal padding tight (`p-3` to `p-4`); use `gap-5`/`gap-6` between independent page sections.
- Align headings, controls, and list edges to a shared parent grid. Do not offset elements merely to create visual interest.
- Prefer dividers (`border-border/40`) or spacing over nested cards. A nested card must convey a separate actionable unit.
- Avoid large empty regions in data-dense views; retain whitespace around major boundaries and primary actions.
- Between unrelated page regions, space must be visibly larger than any internal gap on the page — if section separation reads the same as card padding, increase it.

### Color Semantics (Light & Dark Mode)

Use Tailwind / shadcn semantic tokens exclusively:

- **Surface**: `bg-background`, `bg-card`, `bg-muted/40`
- **Borders**: `border-border/80`, `border-border/40` for inner dividers
- **Status Accents**:
  - **Success / Tailored / Evidenced**: Emerald tones (`text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800`)
  - **Warning / Review Required**: Amber tones (`text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800`)
  - **Info / In-Progress**: Blue/Sky tones (`text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40 border-sky-200 dark:border-sky-800`)
  - **Destructive / Gap**: Rose/Red tones (`text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800`)
- Primary action: brand `primary` only.
- On a Job Card, show at most one strong status color plus the primary compensation cue. Other facts stay neutral.

### Elevation

- Normal cards: `shadow-none` or `shadow-sm`.
- Hover affordance: `hover:shadow-md` (see Job Card below).
- Reserve `shadow-lg`/`shadow-xl` for overlays (modal, drawer, tooltip, drag ghost) and active drag states only.

---

## 2. Viewport & Canvas Optimization

### The Kanban Board (`/board`)

Fixed application frame; only columns manage their own vertical scroll.

```tsx
<div className="flex h-[calc(100dvh-theme(spacing.16))] min-h-0 gap-4 overflow-x-auto px-4 py-4 sm:px-6">
  <section className="flex w-[280px] shrink-0 flex-col rounded-xl border border-border/70 bg-muted/25 2xl:w-[320px]">
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border/50 bg-muted/25 px-3 py-2.5 backdrop-blur">
      {/* stage label + count */}
    </header>
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
      {/* job cards */}
    </div>
  </section>
</div>
```

- Use `100dvh` (not `100vh`) so the frame tracks the dynamic viewport without outer body scrollbar jumping.
- **Laptop (1280px–1536px)**: `w-[280px] shrink-0`; preserve horizontal scrolling rather than compressing cards.
- **Ultra-wide (1536px+)**: `2xl:w-[320px]`, never unlimited column growth; generous column gaps stay at `gap-4`. (`xl` fires at 1280px in Tailwind v4, so it must not gate the wide column.)
- Custom slim scrollbars on column containers (`overflow-y-auto`); sticky column headers.
- **Stacked View Toggle**: maintain the single-column stacked view for focused sequential processing.

### The Full-Viewport Card Workspace Drawer (`components/board/CardDrawer.tsx`)

```tsx
<div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
  <main className="min-w-0 overflow-y-auto pr-0 lg:pr-2">
    {/* tabs and active content */}
  </main>
  <aside className="self-start lg:sticky lg:top-4">
    {/* quick facts and tracker */}
  </aside>
</div>
```

- **Three-zone architecture**:
  1. **Fixed Page Header** (`shrink-0`): Back button, title + pipeline stage badge, company/location meta, and the section tab bar directly beneath. Never scrolls away, so tabs stay reachable on every viewport.
  2. **Scrollable Center Content Area**: tab panels scroll alone; sidebar and header stay fixed.
  3. **Sticky Context Sidebar** (300px on `lg+`): Status rows, Card actions (Move, Correct) with inline errors, Quick Facts, Requirement Matches, Application Tracker. Becomes a normal full-width section below main content under `1024px`.
- Keep tab panels at `min-h-[400px]` to prevent abrupt layout jumps on short content states.
- Sidebar uses `minmax(0,1fr)` on the main column so long unbroken strings (URLs, hashes) cannot blow out the grid.

---

## 3. Component Refinements & Micro-Interactions

### A. The Kanban Job Card (`components/board/JobCard.tsx`)

Desired scan order: **company → role title → compensation → location/arrangement → current status**.

```tsx
<article className="group rounded-xl border border-border/70 bg-card p-3.5 shadow-sm transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-px hover:border-border hover:shadow-md">
  <div className="flex items-center justify-between gap-2">
    <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      Company name
    </p>
    <a aria-label="Open job posting" className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  </div>

  <h3 className="mt-1.5 line-clamp-2 text-sm font-semibold leading-5 text-foreground transition-colors group-hover:text-primary">
    Senior Product Manager
  </h3>

  <div className="mt-3 flex flex-wrap items-center gap-1.5">
    <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-primary">
      $145,900–$197,400 CAD
    </span>
    <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Remote</span>
    <span className="text-[11px] text-muted-foreground">Toronto, ON</span>
  </div>

  <div className="mt-3 flex items-center gap-1.5 border-t border-border/40 pt-2.5 text-xs">
    <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
    <span className="font-medium text-amber-700 dark:text-amber-400">Resume v1 · Awaiting review</span>
  </div>
</article>
```

- Company is quiet metadata; role is the dominant textual element. Compensation is the one strong data cue — do not turn location, arrangement, and status into equally saturated chips.
- Status line: single dot + label over a `border-t border-border/40` divider, not a competing chip row.
- In-progress indicator: animated pulse ring when AI tailoring is running (see §5 for the exact motion).
- **Drag-and-drop physics (`@dnd-kit`)**:
  - Real draggable grip with hover elevation (`hover:bg-muted/60`); the whole card is not an ambiguous drag surface.
  - When dragging: `rotate-[1.5deg] shadow-xl ring-2 ring-primary ring-offset-2 opacity-90`, applied within `100ms ease`.
  - Drop: smooth spring easing into the new slot — never an instant snap. Prefer a drop-indicator line in the target gap over reflowing siblings mid-drag.
  - Keyboard alternative is mandatory: every drag operation must have an equivalent keyboard/menu path (move actions), with the same outcome and confirmation.

### B. The Card Workspace Drawer (`components/board/CardDrawer.tsx`)

- **Tab switching**: zero layout shift — `min-h-[400px]` panels with opacity fade only (`120ms ease-in-out`). No slide, no height animation.
- **Active tab indicator**: clear high-contrast underline or restrained pill with a short transition; focus follows selection for keyboard users.
- **Live progress card** (only while `tailoringState === 'RUNNING'`):
  - Spinning AI sparkles icon + live elapsed timer in `font-mono tabular-nums` (no tick jitter).
  - Three-stage tracker: `1. Scrape` → `2. AI Facts & Keywords` → `3. PDF Render`, with completed/current/upcoming states distinguishable by icon + text, not color alone.
  - The card unmounts on completion — no permanent visual noise, no skeleton left behind.
- **Compensation & facts panel**:
  - Simple metric grid with bordered tiles; Salary Min/Max prominently highlighted.
  - Compensation highlights as a neutral chip cluster (`[Equity]`, `[RRSP Match]`, …); Top 5 ATS keywords in an organized chip cluster with category tags. Chips stay neutral until hovered/selected.

### C. Resume Review & Side-by-Side Audit (`components/board/ResumeReview.tsx`)

- **Layout**: `xl:grid-cols-2` on large screens, clean stacked layout below.
  - **Left**: proposed evidence-backed changes with expandable source facts.
  - **Right**: job requirements & keyword audit.
- **ATS keyword match cards**:
  - Evidenced: green pill with checkmark + placement tag (`Summary`, `Skills`, `Experience`).
  - Gap: rose pill with honest gap icon (`Not on resume`).
  - Green only for evidenced matches, rose only for real gaps — nothing else on this surface earns saturation.
- **Sticky human approval bar** (bottom of the review context):
  - One visually dominant approval action (`Approve Resume`, primary brand button) and one secondary revision action (`Request Revision`, outline).
  - Confirmation modal states plainly that approval moves the job to `Tailored`.

### D. Settings & Data Management Modal (`components/settings/SettingsModal.tsx`)

- Centered Radix Dialog with backdrop blur (`backdrop-blur-sm bg-background/80`).
- Tabbed layout: `Data & Backup`, `AI & Models`, `Candidate Profile`.
- Backup export: prominent download card with file-size indicator.
- Board reset: destructive section visually isolated with warning border and required type-to-confirm dialog — separated from normal configuration by distance, divider, and tone.

### E. App Header & Global Navigation (`components/AppHeader.tsx`)

- Compact sticky surface: `sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60`.
- Left: clean wordmark + pipeline stage tabs (`Board`, `Intake`).
- Right: global action/settings/theme cluster — `+ Add Job` button, Settings trigger, theme toggle (icon-only buttons carry `aria-label`s).

---

## 4. Iconography

Use one icon family throughout the app (prefer the library already installed; otherwise Lucide).

```tsx
import { ExternalLink, GripVertical, Sparkles, Check, AlertCircle } from "lucide-react";

// Metadata / inline: 14px
<ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />

// Button / control: 16px
<GripVertical className="size-4" aria-hidden="true" />

// Prominent status / nav: 20px
<Sparkles className="size-5 text-sky-600 dark:text-sky-400" aria-hidden="true" />
```

- Fixed size scale: `size-3.5` (inline), `size-4` (controls), `size-5` (prominent status/nav). No arbitrary icon dimensions.
- Icons communicate an action or a state. Remove decorative icons that add no meaning.
- Icon-only buttons require an accessible label (`aria-label`) and a tooltip where the action is not universally obvious.
- Icons inherit semantic color from the surrounding state; never add an icon-only accent color.
- Every status icon pairs with a text label — important state is never color- or icon-alone.

---

## 5. Motion & Micro-Interactions Standards

### Core principles

- **Transform/opacity only.** Position, size, and shadow transitions are allowed only when they cannot trigger layout (use `transform` and `opacity`; never animate `width`, `height`, `top`, or `margin`). This keeps every interaction at 60fps on a 13" laptop.
- **Fast and interruptible.** Every timed motion completes quickly (see table) and must tolerate interruption — rapid tab switches, drag cancels, and modal dismissals never leave a stuck mid-state.
- **Motion confirms state.** Spinner/progress appears only while work runs; success confirmations fade on their own; idle surfaces stay still.
- **Reduced motion is a first-class state.** Under `prefers-reduced-motion`, disable tilt, slide, scale, stagger, and shimmer; keep instant opacity fades (or no motion) and full state-change text.

### Timing table

| Action | Target Transition | Timing / Easing |
| :--- | :--- | :--- |
| **Modal Open/Close** | Opacity fade + subtle zoom (`scale-95` → `scale-100`) | `150ms ease-out` |
| **Drawer Open/Close** | Slide-in from right + backdrop fade | `200ms cubic-bezier(0.16, 1, 0.3, 1)` |
| **Tab Change** | Instant swap with fast opacity fade (`0` → `1`) | `120ms ease-in-out`, zero layout jump |
| **Card Drag Lift** | Shadow elevation (`shadow-md` → `shadow-xl`) + `rotate-[1.5deg]` | `100ms ease` |
| **Card Drop Settle** | Spring settle into slot + drop-indicator fade | `180ms cubic-bezier(0.16, 1, 0.3, 1)` |
| **Card Hover** | `translate-y-px` lift + border/shadow shift | `150ms ease` |
| **Live AI Spinner** | Smooth 360° rotation + subtle color pulse | `2s infinite linear` |
| **Progress Step Advance** | Check draw-in + label emphasis on the newly completed step | `200ms ease-out` |
| **List Entrance** | Opacity + `translate-y-1` stagger, 5 max, 30ms apart | `160ms ease-out` per item |
| **Async Skeleton** | Subtle shimmer sweep on placeholder blocks (never a spinner farm) | `1.2s infinite ease-in-out` |
| **Toast / Confirmation** | Slide + fade in, auto-fade out | `180ms ease-out` in, `150ms ease-in` out |
| **Tooltip / Popover** | Opacity fade with 150ms hover-intent delay | `120ms ease-out` |
| **Button Click** | Active scale-down (`active:scale-[0.98]`) | `75ms ease` |

### Interaction details

- **Focus visibility**: every keyboard-focusable control needs `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`. Focus rings are never removed for aesthetics.
- **Focus management**: drawer/modal open moves focus inside; close returns focus to the trigger. Tab panels keep focus stable across tab switches.
- **Live-region announcements**: async completions (scrape done, tailoring done, move confirmed) announce via a polite live region — motion plus text, never motion alone.
- **Elapsed timers & counts**: always `font-mono tabular-nums` so updates never shift surrounding layout.
- **Skeleton discipline**: skeletons mirror the final layout's geometry (same heights/gaps) so content swap causes zero shift; one shimmer pattern app-wide.
- **Hover intent**: tooltips and preview popovers wait ~150ms before appearing; they never appear for touch or keyboard focus alone without a dismiss path.
- **Press honesty**: `active:scale-[0.98]` applies to buttons only — never to cards, rows, or navigation, where scale reads as instability.

---

## 6. Design Verification Checklist

When performing the design pass, verify every item:

**Composition & density**

- [ ] Aligned grids and a clear scan path on board, drawer, and modal surfaces.
- [ ] Compact cards without cramped text or uncontrolled empty space.
- [ ] One dominant action/data cue per surface; status colors do not compete.
- [ ] Consistent 4px rhythm: tight internals, generous section separation.

**Typography & iconography**

- [ ] Every text style uses the §1 type ramp; numeric/metadata figures use `tabular-nums`.
- [ ] One icon library, fixed size scale, functional use only, accessible icon-only controls.

**Themes & responsive**

- [ ] **Light Mode**: all text has strong contrast; borders are clean; no washed-out grays.
- [ ] **Dark Mode**: deep card backgrounds; borders subtle; badges remain vibrant.
- [ ] **13" MacBook (1280×800)**: board scrolls horizontally; cards don't truncate awkwardly; drawer fits comfortably.
- [ ] **27" 4K (3840×2160)**: columns have bounded maximum widths; text lines don't stretch into unreadable strips.

**Motion & stability**

- [ ] **Keyboard navigation**: `Tab` renders a distinct focus ring on every button, input, and card; all drag operations have a keyboard path.
- [ ] **No layout shifts**: drawers, tabs, timers, and async content never jerk or resize parents.
- [ ] **Reduced motion**: with `prefers-reduced-motion`, all nonessential movement is off and every state change is still communicated in text.
- [ ] Every timed interaction matches the §5 table and survives interruption (rapid tab switch, drag cancel, modal dismiss).
