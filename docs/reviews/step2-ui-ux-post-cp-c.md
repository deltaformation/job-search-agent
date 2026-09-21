# Post-S2-CP-C UI/UX Review — Step 2 Tailoring Experience

**Date:** 2026-09-18
**Scope:** Production Step 2 focus editor (`components/tailoring/Step2Focus.tsx` & related tailoring components)
**Context:** Release v1.3 Step 2 Post-Correction Checkpoint C

---

## Executive Summary

Following the completion of WO-1.3-S2-CP-C, Step 2 is fully wired to verified server contracts: server-derived provenance, eligible-only role targeting, one Generate resume exit, CAS autosave, and immutable generation inputs.

However, the user interface currently exhibits "developer debug console" characteristics: an undifferentiated vertical stack of 8 bordered boxes, heavy card nesting, implementation-oriented and defensive copy, visually indistinguishable provenance badges (all uniform gray), and hidden readiness reasons when Generate is disabled.

This review defines a focused, restrained UI/UX refinement to elevate Step 2 into a polished, executive SaaS workflow without altering backend contracts, schemas, or test seams.

---

## Prioritized Issues & Corrections

| ID | Category | Observed Issue | User Impact | Proposed Correction | Affected Component | Status |
|---|---|---|---|---|---|---|
| **UX-01** | Hierarchy | Top of page dominated by large administrative cards (`Captured profile` and `Preparation`), pushing actual tailoring decisions below the fold. | High visual clutter; forces immediate vertical scrolling. | Consolidate profile metadata and succeeded preparation status into a compact, elegant context strip / subheader bar at the top of the workspace. | `Step2Focus.tsx` | **Implemented** |
| **UX-02** | Hierarchy | Box-in-a-box fatigue: 8 stacked bordered sections with nested bordered items create competing visual weights and excessive vertical space. | Disorientation; difficult to perceive the guided flow. | Establish a clear 3-stage guided sequence: (1) Requirements & Phrases, (2) Summary & Positioning, (3) Experience Tailoring. Reduce borders and use subtle surface backgrounds (`bg-card`, `bg-muted/30`). | `Step2Focus.tsx` | **Implemented** |
| **UX-03** | Copy & Noise | Defensive, implementation-heavy copy (e.g. "Master content never changes here", "Actions unlock once...", "The server rejected this item"). | Decreases trust; makes user anxious about internal mechanics. | Replace defensive jargon with concise, reassuring, human-centered SaaS copy. Keep critical warnings actionable and clear. | `Step2Focus.tsx` | **Implemented** |
| **UX-04** | Provenance | `Verified source`, `AI suggestion · accepted`, and `User edit` badges all share identical gray `secondary` styling. | Hard to distinguish immutable master facts from user edits and accepted AI text at a glance. | Style each category with distinct, subtle semantic tints and recognizable icons (`ShieldCheck` for verified, `Sparkles` for AI accepted, `Edit2` for user edit). Add explanatory tooltips. | `Step2Focus.tsx` | **Implemented** |
| **UX-05** | Relationships | `Supported` and `Related experience` badges look identical (gray). Addressed JD phrases (`Addresses: “...”`) render as unformatted text. | Difficult to scan which job requirements are satisfied or addressed. | Provide distinct visual treatments for Supported (emerald tint), Related (sky tint), and Gap (amber tint). Format addressed phrases in clear, compact highlight chips. | `Step2Focus.tsx` | **Implemented** |
| **UX-06** | Experience | Cluttered action button rows on suggested bullets (`Use`, `Edit`, `Replace…`, `Skip`, plus role select and `Add` all inline). | Visual clutter; unclear distinction between default Use and alternative role targeting. | Structure suggestion actions with clear primary (`Use`) vs secondary (`Edit`, `Replace…`, `Skip`) affordances and clean dropdown grouping. | `Step2Focus.tsx` | **Implemented** |
| **UX-07** | Generation | When `Generate resume` is disabled, the reason is only provided in the HTML `title` attribute (hover-only). | Touch and keyboard users cannot tell why generation is blocked. | Render an actionable inline readiness notice adjacent to the Generate button when generation is blocked (e.g. budget exceeded, unsaved edits, conflict). | `Step2Focus.tsx` | **Implemented** |
| **UX-08** | Accessibility | High-density controls wrap inconsistently on narrow screens (<640px) or at 200% zoom, risking horizontal clipping. | Poor mobile and zoomed experience. | Apply responsive flex wrapping, ensure minimum 32px touch targets, and verify keyboard navigation focus rings. | `Step2Focus.tsx` | **Implemented** |
| **UX-09** | Progressive Disclosure | Evidence details (raw byte offsets, fact IDs) are unstyled or clutter default view. | Noise for casual review. | Clean up `<details>` summary styling with styled toggles while keeping evidence immediately accessible on demand. | `Step2Focus.tsx` | **Implemented** |
| **UX-10** | Interaction | Drag-and-drop animated reordering across role groups. | Nice-to-have visual polish. | Deferred to preserve verified native HTML5 + keyboard/select accessible paths without adding runtime animation dependencies. | `Step2Focus.tsx` | **Deferred** |
| **UX-11** | Rich Text | WYSIWYG rich text editor for summary. | Formatting flexibility. | Deferred; canonical plaintext and CAS hashing require exact string equality. | `Step2Focus.tsx` | **Deferred** |
| **UX-12** | Client AI | In-browser dynamic suggestions or keyword generation. | Additional suggestions. | Deferred; violates repository truthfulness rules and air-gapped provider boundary. | `Step2Focus.tsx` | **Deferred** |

---

## Design Plan

1. **Top Context Strip**:
   - Combine profile info (`Product Manager · v3`), `Preview`, `Edit profile`, and `Preparation Status` into a slim, professional header card.
   - If preparation succeeded, display a compact green status indicator (`● Ready`).
   - If preparation failed or pending, display prominent actionable retry/diagnostic controls.

2. **Sequence Flow**:
   - **Step 2A: Requirements & Important Phrases**: Show 3–5 featured JD phrases with distinct Supported / Related / Gap badges, scannable importance, and progressive disclosure for evidence.
   - **Step 2B: Positioning & Executive Summary**: Clear option cards for Keep Master vs AI Angles with addressed phrase tags, followed by the editable summary textarea with live character count and provenance badge.
   - **Step 2C: Experience Bullets & Suggestions**: Master employment groups with clear bullet items, distinct provenance badges (`Verified source`, `AI suggestion · accepted`, `User edit`), reversible exclusions, and clean suggestion cards with clear `Use` / `Replace` / `Skip` actions.
   - **Step 2D: Support, Budgets & Operations**: Compact collapsible audit panel for budgets, checking support, and reversible operations history.

3. **Generation Bar**:
   - Fixed or prominent bottom action bar with `Back` on left, clear readiness text when disabled, and the primary `Generate resume` button on the right.
