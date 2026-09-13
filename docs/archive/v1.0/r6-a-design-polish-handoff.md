# R6-A design polish audit and handoff

Work order: R6-A — UI/UX design polish pass.

Outcome: Reversible presentation changes across the six specified surfaces. Board and workspace scrolling are contained; card compensation is earlier in the scan order; settings are grouped into persistent tabs; review evidence can collapse; numeric metadata, icons, focus styling, and selected motion timings are standardized. Product labels, handlers, routes, component contracts, theme variables, and font tokens are preserved.

Status: needs-review

Files changed:
- `app/board/page.tsx`, `app/globals.css`
- `components/AppHeader.tsx`
- `components/board/Board.tsx`, `BoardColumn.tsx`, `JobCard.tsx`, `CardDrawer.tsx`, `ResumeReview.tsx`, `dialog.tsx`
- `components/settings/SettingsModal.tsx`
- `components/ui/button.tsx`, `dialog.tsx`, `tabs.tsx`
- `tests/unit/components/AppHeader.test.tsx`
- `tests/unit/components/settings/SettingsModal.test.tsx`
- `tests/unit/components/board/ResumeReview.test.tsx`
- This handoff.

Migrations/data effects: None. Tests used isolated fixtures/mocked component requests. No real reset, restore, model update, resume approval, or application action was performed. Pre-existing and concurrent changes in layout, theme declarations, extraction, URL handling, planning documents, and components.json were left intact.

## Pre-edit audit (reported in conversation before implementation)

Each row covers typography/spacing (§1), layout (§2), component presentation (§3), icons (§4), and motion (§5).

| Surface | Current state → requirement → gap |
|---|---|
| Board | Page-level vertical scrolling; every column 320px; content grows without a bound → fixed dynamic viewport, 280px/320px columns, independent scroll, sticky headers → scroll containment, responsive widths and numeric alignment missing. View toggles used broad transitions. |
| Job card | Company/title hierarchy exists; location precedes salary; multiple status chips; salary truncates; 12px icons → compensation-first scan order, compact card, fixed icon scale, hover/drag feedback → order, wrapping, padding and icon consistency need adjustment. Multiple saturated statuses conflict with locked colors. |
| Workspace | Full-page overlay but entire panel scrolls; proportional sidebar; descriptions use text-base without line limit; tabs slide and have no minimum height → fixed header, 300px context panel, scrollable center, 75ch body measure and opacity-only tabs → zoning, reading measure, metadata and motion gaps. RUNNING only exposes client-observed elapsed time, not three worker substages. |
| Review | Two-column review exists, all facts expanded, decision section in normal flow, badges use 10px labels → expandable facts, sticky decision context, standard compact labels, numeric metadata → disclosure, decision placement and icon/metadata gaps. Approval uses existing green styling and inline confirmation, conflicting with brand-primary/separate modal instructions. |
| Settings | Centered Radix modal with one long form; inline RESET gate; nested sections have equal separation → three tabs, persistent header, distinct destructive region → hierarchy, scroll, spacing and numeric alignment gaps. No exact next-download archive size exists in the snapshot. |
| Header | Sticky surface with centered nav, profile pill, right actions; Ready dot continuously pulses; no theme toggle → left nav, right action cluster, quiet idle state, fixed icon sizes → alignment and idle motion gaps. Theme toggle requires new behavior. |

## Changes: issue → change → intended effect

| Surface | Change and exact decisions | Intended effect |
|---|---|---|
| Board | `.board-page` uses `h-full min-h-0 flex flex-col gap-5 overflow-hidden px-4 py-5 sm:px-6 lg:px-8`. The board route scopes body to `height:100dvh; grid-template-rows:auto minmax(0,1fr)`. Canvas uses `min-h-0 flex-1 gap-4`; columns use `w-[280px] xl:w-[320px]`, sticky headers and `overflow-y-auto p-2.5`. Stacked view remains vertical, now one card per row. | Actual header height is accounted for, including wrapped navigation. Columns retain readable widths and independently scroll without growing the page. |
| Job card | Salary block moved before location; existing salary formatter retained. `p-3.5`, `rounded-xl`, `mt-3 pt-2.5` status separation; salary `font-mono tabular-nums` and wrapping replace truncation. Hover uses independent CSS `translate:0 -1px`; drag uses independent `rotate:1.5deg`, `opacity-90`, `shadow-xl`, preserving dnd-kit’s inline transform. | Stronger scan order and readable compensation; hover/drag feedback does not alter layout geometry or replace drag coordinates. |
| Workspace | Dialog becomes `flex h-dvh min-h-0 flex-col overflow-hidden`. Header is `shrink-0`; center uses `lg:grid-cols-[minmax(0,1fr)_300px]`; main scrolls at lg+, context stacks below it on smaller screens. Panels use `min-h-[400px]`, body uses `text-sm leading-relaxed max-w-[75ch]`. | Header/actions stay accessible; the main reading area gets available width; tab swaps reserve a baseline height. |
| Review | Existing `xl:grid-cols-2` retained. Source facts use native `<details open>` so all existing evidence starts visible. IDs use `font-mono tabular-nums`. Decision context uses `sticky bottom-0` with an opaque backing surface and bounded overflow. | Optional evidence compression without hiding it initially; decision controls remain reachable while the context is scrolled. |
| Settings | Existing Tabs primitive with Data & Backup / AI & Models / Candidate Profile. `forceMount` plus `data-[state=inactive]:hidden` retains form drafts. Scrollable center, `min-h-[400px]` panels; reset isolated by `border-t border-border/40 pt-6`; storage next to backup. | Easier scanning without resetting form state or changing actions. Existing exact RESET gate is preserved. |
| Header | Fluid `min-h-16` frame; brand/nav aligned left, action cluster uses `ml-auto`; profile becomes xl-visible to protect compact layouts. Idle ping removed. | Less competing movement, clearer navigation/action grouping, room for header wrapping. |
| Shared presentation | Icons normalized to `size-3.5`, `size-4`, `size-5`; descriptive icons marked `aria-hidden`. Button press uses transform-only 75ms and applies only to actual enabled buttons, not asChild links. Focus rings use existing primary token, 2px ring/offset. | Consistent interaction and icon scale with visible keyboard focus. |

The header/profile, progress, artifact metadata, and card statuses retain their existing wording and data. No imported primitives were reinstalled or replaced. Documentation consulted: [shadcn Tabs](https://ui.shadcn.com/docs/components/radix/tabs), [Dialog](https://ui.shadcn.com/docs/components/radix/dialog), [Button](https://ui.shadcn.com/docs/components/radix/button), [Card](https://ui.shadcn.com/docs/components/radix/card), [Badge](https://ui.shadcn.com/docs/components/radix/badge), and installed Next layout guidance.

## Verification performed and exact result

- Baseline: `npm run typecheck` passed; existing board component tests: **8 files / 42 tests passed**.
- Updated board/settings service tests plus new settings component tests: **10 files / 53 tests passed**.
- New header component test: **1 file / 1 test passed**.
- Full non-browser suite: `npx vitest run --exclude '**/browser/**'`: **107 files / 791 tests passed**.
- Final `npm run typecheck`: passed, 0 errors. Final `npm run lint`: passed, 0 reported warnings/errors.
- PostCSS + installed Tailwind compiled `app/globals.css`: **78,657 bytes; 0 warnings** on the final stylesheet.
- All CSS custom-property name/value declarations compared to a session-start copy: **identical**. This includes both theme palettes, font families, type/spacing and shadow tokens.
- TypeScript AST interface/type declaration comparison across **11 changed component files**: identical. Inline component props and action handlers were also inspected; no API/data-flow changes made.
- `git diff --check`: passed.
- One existing evidence-text assertion needed a DOM-aware matcher because the fact ID now has its own monospace span; it still checks the full exact fact text. No assertion was removed.
- New settings tests prove model drafts survive tab switches, partial RESET text survives interruption without enabling submission, Cancel works, Escape requests close, and tab navigation causes no mutation request.
- Existing workspace-dialog tests exercise nested Escape, focus restoration and body-scroll locking.
- Vite’s pre-existing config-loader advisory remains.
- **No browser tests, browser inspection, screenshots, or real workflow actions were run**, per the user’s standing instruction.

## §6 checklist: evidence versus remaining acceptance

| Checklist item | Exact evidence/result | Acceptance |
|---|---|---|
| Aligned grids / scan paths | Source and compiled CSS inspected: shared gutters, bounded columns, 300px sidebar, grouped settings | Visual alignment unproven |
| Compact cards / controlled whitespace | p-3.5 cards, wrapping salary, 280px/320px columns, 75ch prose | Browser density check required |
| One dominant action/data cue | Salary placed before location; existing controls preserved | Multiple existing saturated statuses and green approval styling remain; locked colors prevent full convergence |
| Consistent spacing rhythm | Existing Tailwind scale used for gaps/padding; explicit spec dimensions/timings used | Visual rhythm unproven; spec itself includes half-step p-3.5/py-2.5 exceptions |
| Type ramp / numeric metadata | 10px labels raised to existing 11px compact ramp; salary, elapsed, dates, IDs, file sizes/storage figures use mono/tabular figures | Not a proof of every numeric string or zero digit-count growth |
| Icon scale / accessibility | Six-surface source scan: Lucide only, 14/16/20px icon classes; explicit icon labels retained, decorative SVGs hidden | Visual sizing/focus audit required |
| Light theme | Static opaque token-pair contrast calculation: foreground/background 10.98:1; muted/background 4.92:1; muted/card 4.71:1; primary-foreground/primary **3.90:1** | **Known existing AA failure for small primary-button text**; full rendered theme audit not performed |
| Dark theme | Same calculation: foreground/background 13.40:1; muted/background 7.36:1; muted/card 6.79:1; primary-foreground/primary 5.90:1 | Selected opaque pairs pass; all opacity composites/status badges unproven |
| 1280×800 | Bounded dynamic frame and overflow rules compile; source has horizontal scrolling and responsive widths | Not run; manual browser check required |
| 3840×2160 | Column max width remains 320px; prose capped at 75ch | Not run; manual browser check required |
| Keyboard navigation | Existing drag/menu/focus tests pass; new settings/header tests pass; CSS rings compiled | Real Tab/arrow/focus visibility and scrolling require browser verification |
| No layout shifts | min-h-400px tab panels, stable scrollbar gutters, tabular figures and transform-only layout motion | **Not proven**. Minimum heights do not guarantee zero CLS; loading/notices, long content and timer digit growth can still change geometry |
| Reduced motion | Existing global animation/transition disabling retained; new hover translate, drag rotate and button scale explicitly disabled | Static inspection only; OS/browser preference test required |
| Timing / interruption | Workspace enter 200ms; tab opacity 120ms; Radix modal fade/scale 150ms; drag settle 180ms; lift 100ms; hover 150ms; active spinner 2s; press 75ms. Focus/escape and interrupted settings draft tests pass | Browser timing/performance unproven; custom drawer close remains immediate; tooltip/list/skeleton/notice lifecycle requirements not introduced |

Contrast method: existing OKLCH tokens converted to linear sRGB, channels clamped to [0,1], relative luminance weights 0.2126/0.7152/0.0722, contrast `(Llighter + .05)/(Ldarker + .05)`. These are approximate static checks for opaque token pairs, not rendered WCAG certification.

Acceptance criteria not yet proven: All browser/visual checks listed above; full R5-C human checklist; zero layout shift; complete AA compliance; full timing-table coverage. Code completion does not satisfy these gates.

Decisions or deviations:
- User explicitly chose **“Hold those items for separate design decisions”** for theme toggle, separate reset/approval dialogs, automatic notice dismissal and three-stage progress. These remain untouched and unresolved, not approved omissions.
- Preserve the existing color values, including the light-mode primary contrast issue and current status/approval colors. No palette or font change was made to claim conformance.
- Followed the spec’s explicit `xl:w-[320px]` class, although its prose also mentions 1700px+; the repository’s standard xl breakpoint applies.
- Used the actual header grid row instead of subtracting a hardcoded 64px, preserving access when navigation wraps.
- Header overflow and context-sidebar overflow are allowed as accessibility fallbacks when contents exceed the available height. The header is bounded to half its parent and the review decision context to half the dynamic viewport; these are documented proportional safety bounds, not new spacing tokens. This qualifies the spec’s strict “only center scrolls” wording.
- The custom workspace unmounts immediately on close; delayed exit would require a lifecycle change. No delayed state, notice auto-dismiss, staged progress inference, drop-target data change or new skeleton lifecycle was added.
- Facts start expanded to preserve current evidence visibility. Settings panels stay mounted so visual navigation cannot erase unsaved inputs.
- Exact backup-download size is unavailable before generation; existing storage metrics are shown without relabeling them as archive size.

Safety/human checkpoint: All workflow confirmations remain explicit and unchanged. Held design decisions need user resolution; browser acceptance belongs to the user. Do not approve, reset, restore or record an application on real data merely to inspect this styling.

## Manual verification for the user

1. At **1280×800**, check horizontal Kanban scrolling, independent vertical column scrolling and sticky headings. Search/sort/toggle and reload; verify no card or control becomes unreachable.
2. At **3840×2160**, confirm columns remain 320px and descriptions remain comfortable to read; compare Kanban and Stacked views.
3. Open a long job. Scroll the description/review while checking the Back/Move/Correct toolbar and context panel. Below 1024px, check that the sidebar appears after content and can be reached.
4. Switch short/long tabs rapidly; load/change resume versions; inspect for jumps and stale or clipped content. Test the sticky decision area on a small viewport.
5. Use only Tab/Shift-Tab/arrows/Space/Escape. Check focus rings, card drag/menu alternatives, nested dialog dismissal and return focus.
6. In settings, edit a model value without saving, change tabs and return. Arm reset with partial text only, change tabs and return, then Cancel. Drafts must persist and no operation should run.
7. Enable reduced motion; repeat hover, drag cancel, tab switches and open/close. Essential text must remain while movement stops.
8. Inspect both themes without changing stored colors. Record the known light primary-button contrast issue separately; also inspect translucent surfaces/status badges.
9. On disposable test data, follow the existing R5-C acceptance checklist verbatim. Keep real approvals/applications deliberate.
