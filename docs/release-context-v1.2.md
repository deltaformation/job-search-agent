# Release 1.2 — Intent and Decision Background

Background only. Builders use [work-orders-v1.2.md](work-orders-v1.2.md) for assigned scope, [acceptance-v1.2.md](acceptance-v1.2.md) for gates and [lifecycle contracts](lifecycle-contracts-v1.2.md) for design. This file preserves source context and rationale formerly loaded into every implementation session; it is not a competing plan.

## Original planning context


Sources: the original user quotes reproduced in the audit conversation (Steps 231, 235, 241, 251 and 265), the [v1.1 alignment audit](alignment-audit-v1.1.md), the [v1.1 roadmap](roadmap-v1.1.md), and the [v1.1 work orders](work-orders-v1.1.md). The user's new instruction is: “Build a comprehensive new work order v.1.2 which will fix these gaps, you can add recommended improvements on top that don't have extensive build requirements.”

This is a plan for implementation, not evidence that its behavior already exists. It deliberately replaces several v1.1 design assumptions; A records their formal architectural disposition before dependent code changes. Original quotes take precedence over narrower v1.1 implementation prompts. No omitted assistant reply is reconstructed as user consent.

The release succeeds when a user can:

1. Create complete Product Manager and Senior Product Manager career profiles, each with its own reviewed master content and preferences.
2. Clip a JD and open its Tailoring & Resumes workspace before any resume generation starts.
3. Preview the chosen master, select relevant source-backed keywords, add editable coaching notes, and explicitly start generation.
4. Review v1 alongside its exact inputs, requirements, gaps, changes and document previews.
5. Decline v1 without generating anything, or request another version using a different profile and coaching.
6. Produce v2 without changing v1's contents, source snapshots, files or recorded decisions.
7. Approve an exact version explicitly, apply manually, and record the outcome manually.

The current theme, truthful evidence model, SQLite runtime, local worker, five board columns and manual application boundary remain the foundation.

## Original small-improvement rationale


| Included improvement | Why it helps | Owner / limit |
|---|---|---|
| Profile readiness with a direct setup action | Prevents selecting an empty profile and failing later | C; derived from existing data |
| Create from existing profile | Makes a secondary career track useful without re-entering shared history | B/C; existing membership design, independent draft and explicit activation |
| JSON example and precise validation messages | Makes supported import format usable | C; static sample and existing validation |
| Selection count, Clear and source excerpts | Makes keyword choice inspectable | E; existing guidance controls |
| Use these settings again | Makes v2/v3 preparation fast and consistent | F; copy immutable inputs into the form, no auto-run |
| Plain “Used / Gap / Not assessed” coaching outcomes | Explains why requested emphasis did or did not appear | E/F; no extra mandatory AI call |
| Invalidate old connection result on edits | Prevents a misleading green badge | G; local state change |
| Previous/Next column navigation | Improves discovery and keyboard access | H; native scrolling, no new drag engine |
| Date refresh for existing follow-up badges | Keeps existing indicators accurate | H; client clock only |

Not included: discovery, fit scoring, cover letters, email/calendar, reminders, application automation, cloud sync, rich resume editing, arbitrary DOCX/PDF import, new theme/template families, local LLM setup, a second database, or a new provider/agent orchestration platform. If an included improvement grows into a new service, complex dependency or unrelated persistence subsystem, stop expanding it and record a smaller implementation; do not silently trade away the core workflow to fit it.

## PR feedback disposition — 2026-09-14


Reviewed the user's supplied “Feedback on the Coding Agent's Gap Analysis.” Its three main concerns—re-tailoring 409, secondary profile usability and missing key-entry UI—were already covered by D, B/C and G respectively. Added explicit source-profile copying, pre-enqueue readiness/worker-continuity tests, early browser/worker checkpoints, and evidence-level reporting to make those requirements harder to satisfy only on paper.

Code-check qualifications: `src/server/candidates.ts` returns a controlled blocked `PROFILE_REQUIRED` result when an active profile version is missing; this alone does not demonstrate a worker crash. The master upload backend accepts an explicit `profileId`, while the current settings uploader omits it and targets the default. Secondary profiles are therefore not inherently unusable in all circumstances; the normal UI fails to provide independent profile-targeted onboarding without changing defaults. The new plan fixes that actual journey.

The submitted 85%/45% assessments have no supplied measurement method and are not adopted. Removing the route's 409 guard alone is insufficient: D still owns the complete workflow transitions, snapshots, immutable versions and review/application associations. The extra-template recommendation remains explicitly deferred under §2.2, not accidentally omitted; it adds renderer/visual acceptance work without repairing the three core blockers. Board usability remains subject to H/I evidence rather than the feedback's unsupported 90% estimate.

## Former section map

Historical numeric references remain inside unchanged execution records. Current documents use named links.

| Former work-order section | Current destination |
|---|---|
| §1 intent and source material | This document |
| §2 binding scope | [Builder release contract](work-orders-v1.2.md#2-release-contract) |
| §3 dependencies/checkpoints | [Builder dependencies](work-orders-v1.2.md#3-dependencies-and-checkpoints) and [early checkpoints](acceptance-v1.2.md#early-checkpoints) |
| §4 shared prompt/handoff | [Read and execute](work-orders-v1.2.md#1-read-and-execute) and [log format](execution-log-v1.2.md#handoff-format) |
| §5 A–J implementation orders | [Work orders](work-orders-v1.2.md#4-work-orders) |
| §6 U1–U16 journey | [Acceptance journey](acceptance-v1.2.md#user-journey) |
| §7 audit evidence ledger | [Evidence ledger](acceptance-v1.2.md#evidence-ledger) |
| §8 recommendations/limits | Rationale here; binding limits remain in builder §2 |
| §9 prompts, handoffs and independent reviews | [Execution log](execution-log-v1.2.md) |
| §10 PR comments | This document |

## Editorial clarifications — 2026-09-14

The reorganization preserves all prior criterion and journey IDs and the entire A/A-review/A-correction records. It separates implementation dependencies from integration dependencies: D needs C for its browser checkpoint; G can build configuration after A but needs D to close its checkpoint. This repairs the earlier table without changing the required journeys.

D9 names existing integrity obligations more explicitly: opening/cancelling Revise is inert; new versions from terminal parents preserve those decisions; old binaries require an enforceable exclusion mechanism; new analysis linkage cannot evade guards by leaving both nullable references empty; attempt publication must preserve append-only history. It is a proof requirement, not an assertion that a proposed mechanism already works.

The observed tree contains B-related source/migration changes without a completed B handoff in the records inspected. The plan therefore no longer claims product implementation has not started. This is not acceptance of B's changes.
