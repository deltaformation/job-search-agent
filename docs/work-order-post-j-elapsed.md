# WO-POST-J-ELAPSED — Tailoring progress and actionable failures

**Status:** folded into WO-1.3-F (R-ADR-023, 2026-09-16); this document is the preserved problem record. New implementation follows [work-orders-v1.3.md](work-orders-v1.3.md) order F, [technical contracts](tailoring-contracts-v1.3.md) §6, and [acceptance F1–F10](acceptance-v1.3.md).
**Prior status:** planned; user-reported behavior supported by code inspection, browser reproduction pending.
**Placement:** post-J follow-up alongside [salary extraction](work-order-post-j-salary.md), not an added v1.2 closure gate. Expanded from a small clock correction to a medium worker/read-model/UI order. Inspect completed D and G before implementation. A provider-launch defect that prevents ordinary use should be triaged during G's setup checkpoint rather than deferred solely because the broader UX order is post-J.

**Outcome:** truthful stage-specific progress, stable elapsed time, and failures the user can understand and act on. Implement and verify in three slices: clock identity, worker stage reporting, failure classification/recovery. Keep one integrated handoff; do not redesign orchestration.

## Report and diagnosis

User sees **Tailoring in progress (17s elapsed)**, switches from Tailoring & Resumes to Notes & Timeline, and returns. The elapsed counter resets.

At planning time, `RunElapsedClock` in `components/board/CardDrawer.tsx` sets `startedAt` to `Date.now()` on mount. Its comment explicitly describes a client-observed mount clock. Remounting therefore measures time viewing the banner rather than time running the work. This explains the reported symptom but has not been reproduced in a browser during this documentation task.

Additional exact user reports:

> Tailoring in progress (74s elapsed)
> Calling the AI provider to extract verbatim requirements and Top 5 ATS keywords, then compiling the resume. This view updates automatically.

The user wants this description to change with the actual backend step and distinguish waiting from a stalled/blocked process.

> Tailoring failed (Provider unavailable)
> The AI provider did not return a usable proposal. Check the detail below, then retry.
> provider spawn failed: 'node'
> Retry tailoring

Code inspection found static progress copy in `CardDrawer.tsx`, generic failure copy in `components/board/tailoringCopy.ts`, and a spawn-error mapping in `src/tailoring/commandAdapter.ts`. The message indicates a local command failed to launch, not proof that the remote AI service rejected a request. The specific cause (missing executable, PATH, permissions, or another launch error) is unverified; do not diagnose missing Node from this string alone.

## Implementation contract

- Follow AGENTS.md and required context. Inspect D's final request/work/attempt model, queue transitions, `src/server/queries.ts`, and progress banner before editing. Preserve concurrent changes.
- Bind elapsed time to the current running attempt's stable server-recorded start and identity. Switching drawer tabs, closing/reopening the drawer, polling and page reload must not restart that clock. Do not use component mount, lease-renewal time, or an unrelated historical attempt as the start.
- Define the displayed number as elapsed time for the **current running attempt**, excluding queued waiting. A real new attempt/retry may reset to its own start; navigation may not. If existing UI uses different semantics, align its copy explicitly and record the decision.
- Reuse existing authoritative timestamps if available. If in-flight attempt timing is not exposed/persisted, add the smallest read-model/lifecycle metadata needed after inspecting D. Never mutate append-only completed attempt records or invent timing from an expiring lease. No new queue architecture.
- Update display from the stable timestamp, catching up after background throttling instead of counting interval ticks. Handle missing/invalid timestamps truthfully with “Tailoring in progress” without a numeric estimate; clamp negative display values. Clear timers on unmount and stop the running display when completion/failure arrives. Retain existing status polling and accessible announcements without announcing every second.
- Do not start, retry, cancel or otherwise mutate work in response to viewing the timer. No provider calls or persistent browser storage as the source of truth.

### Actual progress and liveness

- Inspect the handler/orchestrator/provider/render pipeline and existing heartbeat/events. Publish a small typed stage vocabulary at actual boundaries, for example: checking inputs, waiting for AI response, validating proposal, preparing documents, saving results, ready for review. Show format-specific rendering only if those separate steps are observable. Do not imply sequential phases if the implementation runs them together or in parallel.
- Use the stable request/attempt identity, stage start/update timestamp and server liveness evidence through existing polling. Protect publication with D's fencing; stale attempts cannot overwrite current progress. Keep transactions short and completed history immutable. Add bounded persisted progress metadata/events only where existing seams cannot express it; no new streaming service or periodic write per timer tick.
- Distinguish worker heartbeat from actual stage advancement. A fresh heartbeat during a slow provider call means the worker is still checking in, not that the provider is making progress. Say “Waiting for the AI response” honestly. Do not advance stages on a timer, invent percentage/ETA, or retain the hard-coded Top 5 promise when configured keyword behavior differs.
- Report last confirmed update and actionable delayed/connection-lost states using documented thresholds derived from actual lease/timeout behavior. A failed client poll is not proof the worker failed. A stale heartbeat is not a completed failure until authoritative state says so. Preserve the last known stage, label stale status, and reconcile on reconnect/reload. Terminal state wins over late progress events.

### Actionable failures

- Preserve structured, secret-safe failure categories across worker/API/UI: local runtime launch, provider configuration/authentication, rate limit, network/timeout, invalid response, validation and document generation. Use actual error codes rather than matching prose wherever possible. Unknown causes must remain unknown.
- Primary error text answers: what stopped, whether a usable new resume was created, and the next available action. Derive artifact/output claims from recorded state; partial output is not automatically a usable resume. Preserve user guidance and prior reviewed versions.
- For the reported spawn failure, an appropriate default is: **“The app couldn't start the AI connection process.”** Explain that retry may fail again until setup is repaired. Offer a verified in-app connection check/settings action and safe diagnostic details. Do not tell the user to install Node, change PATH, or restart as a confirmed fix without evidence. Inspect G and desktop/worker startup to determine whether a genuine launch defect needs a bounded correction or a separate blocker record.
- Prefer Settings/check connection for configuration errors, a truthful wait/retry action for rate limits, and safe retry for transient errors. Wire actions to real routes and preserve D's retry identity/deduplication; never retry automatically because the panel remounted. A settings connection test is not proof that the worker command can launch: verify the failing execution path too.
- Put technical detail behind an expandable section with a copyable diagnostic summary: safe failure code, stage, timestamp, request/attempt reference and actionable launch subcode if available. Redact secrets, command arguments, sensitive paths, profile/resume content and raw provider payloads. Use allowlisted diagnostic fields rather than copying unfiltered errors.

## Acceptance

| ID | Evidence required |
|---|---|
| TIME1 | With a known server start, 17 seconds elapsed → Notes & Timeline → return after 5 seconds displays approximately 22 seconds, not zero. |
| TIME2 | Drawer close/reopen, page reload and routine polling retain elapsed time for the same running attempt. |
| TIME3 | A distinct retry/new attempt uses its own start; queued time is not labeled running time; completion/failure removes the running timer. |
| TIME4 | Background/resume catches up from timestamps; missing/invalid/future timestamps never display NaN, negative seconds or fabricated historical duration. |
| TIME5 | Focused clock/read-model tests and an isolated browser walkthrough prove navigation behavior; no queue mutations or extra generation occur. Record browser blockers as unproven. |
| PROG1 | A deterministic provider/renderer seam pauses at real boundaries; the browser displays each observed stage and reload/navigation retains current stage and elapsed time. No invented stage advancement or hard-coded keyword count. |
| PROG2 | Slow provider response, worker heartbeat loss, failed client polling and reconnect produce distinct truthful messages; no false completion/failure. Record configured timing thresholds and verify them with controlled clocks. |
| PROG3 | New attempt, late events from a prior attempt, and terminal completion/failure cannot regress current progress or resurrect a running banner. |
| ERR1 | Inject the exact local spawn-failure scenario and preserve the structured cause. Primary copy explains local launch failure, supplies a relevant action, and does not assert remote-provider failure or missing Node without evidence. |
| ERR2 | Configuration/auth, rate-limit, timeout, invalid-proposal and render failures show appropriate explanations/actions; retry preserves guidance, deduplicates and leaves previous versions intact. |
| ERR3 | Expanded/copied diagnostics contain useful stage/request/attempt information but no seeded secrets, sensitive arguments, candidate content or raw payloads. |
| ERR4 | Isolated browser walkthrough demonstrates progress → failure → relevant setup/check action → explicit successful retry. Verify actual worker execution as well as any web settings test; no terminal use in the user flow. |

Run focused regression tests first and required repository checks appropriate to worker/API/UI changes. Use controlled timestamps and synthetic work; do not wait through live paid generation to test progress. Append the implementation prompt and AGENTS handoff to the active execution log (currently `execution-log-v1.2.md`); report TIME1–TIME5, PROG1–PROG3 and ERR1–ERR4 individually with exact verification and any data effects. Stop after this order.
