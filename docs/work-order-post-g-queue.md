# WO-POST-G-QUEUE — Missing `/queue` route linked from `/health`

**Status:** planned; observability gap recorded during WO-1.3-G, not a G gate.
**Placement:** independent follow-up after WO-1.3-G; explicitly NOT absorbed into G and NOT a G blocker. No release number assigned yet.
**Outcome:** the `/health` Queue link resolves to a real route, or the link is removed/changed so no production UI points at a missing page.

## Report and expected result

Report (WO-1.3-G session, 2026-09-18): `app/health/page.tsx` renders a top-right `Queue` button linking to `/queue`, but neither `app/queue/` nor `app/api/queue/` exists, so the link 404s. Verified by inspection during G; no behavior change made (out of G scope).

Expected result: either implement a bounded read-only queue-observability surface behind that link (leased work items, attempts, stale-lease state — reads only, no new queue semantics), or remove/retarget the link. Do not invent queue-dashboard scope beyond what the owner orders.

## Read and inspect

Follow AGENTS.md and required repository context; inspect the current tree and preserve unrelated work. Relevant entrypoints verified during planning:

- `app/health/page.tsx` (the `Link href="/queue"` button) and `tests/unit/pages/health.test.tsx`.
- `src/queue/leases.ts`, `src/queue/dispatch.ts`, `src/db/schema/queue.ts`: leasing, retry, attempt history.
- `src/server/progress.ts`, generation progress routes: existing per-request progress reads.

**Excluded:** new queue semantics, scheduling, notifications, worker control actions, and any change to WO-1.3-G/H/I scope. If the owner chooses removal over implementation, the fix is the link plus its test, nothing more.
