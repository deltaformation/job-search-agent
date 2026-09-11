# R2-B Handoff — Queue Leasing and Worker Dispatch

```text
Work order: R2-B (Queue leasing and worker dispatch)
Outcome: durable-queue lease primitives, dispatcher loop, worker wiring
Status: accepted 2026-09-11.
Files changed:
  new: src/queue/backoff.ts, src/queue/dispatch.ts, src/queue/leases.ts,
    src/queue/index.ts
  new: tests/unit/queue/backoff.test.ts, tests/unit/queue/leases.test.ts,
    tests/unit/queue/dispatch.test.ts
  edited: src/worker/main.ts (dispatch loop + drain), src/worker/config.ts
    (WORKER_LEASE_MS / WORKER_POLL_MS)
  edited: tests/unit/worker/config.test.ts (+3 knob tests),
    tests/unit/scripts/processes.test.ts (readiness pattern + drain assert)
Migrations/data effects: none (uses R1-B work_items/work_attempts as-is)
Verification performed and exact result:
  npx tsc --noEmit clean; npx vitest run 33 files / 192 tests green
  (+32 new: 4 backoff, 17 leases, 8 dispatch, 3 worker config);
  npx eslint . exit 0; node scripts/check-project-context.mjs consistent
Acceptance criteria not yet proven: human review of lease/completion
  semantics and of the processes.test.ts expectation change below
Decisions or deviations:
  - BLOCKED attempts finish the item as FAILED; the attempt row keeps
    BLOCKED + reason so the block stays explicit until human requeue.
  - Human requeue (FAILED -> QUEUED) restarts the attempt budget at 0;
    attempt rows are never rewritten.
  - Last-lease columns (leased_at/expires) are retained after completion
    for forensics; only lease_token/worker_id clear (CHECK-safe).
  - Empty handler registry idles safely; R2-C registers SCRAPE, R4 TAILOR.
  - Loader-path files use file imports, not directory barrels (see bug).
  - processes.test.ts readiness pattern updated: the old "ready, waiting
    for dispatch work (R2-B)" line marked R2-B as pending; the work order
    replaces that idle wait. Strengthened with a "dispatcher drained"
    assertion rather than weakened.
Safety/human checkpoint: no fetching, no resume content, no approvals;
  worker loop only claims kinds with registered handlers (currently none).
```

## What was built

`src/queue/leases.ts` — one short synchronous transaction per operation,
all state changes conditional on `(id, state, lease_token)`:

- `claimNextWorkItem`: single-statement UPDATE over the oldest runnable
  QUEUED row (`next_run_at` null/due, FIFO by creation). Racing workers
  serialize in SQLite; a double claim returns null, never a shared lease.
  Increments `attempt_count` inside the same statement.
- `renewLease`: heartbeat that extends `lease_expires_at` only for the
  live lease holder; anything else is a typed `lease-lost`.
- `completeWorkItem`: writes the state change and its exactly-one
  `work_attempts` row atomically. SUCCEEDED finishes; FAILED requeues
  with `computeBackoffMs` backoff while `attempt_count < max_attempts`
  and finishes once exhausted; BLOCKED finishes as FAILED (queue rows
  have no BLOCKED state) with the BLOCKED attempt preserved. Duplicate
  completion returns `lease-lost` and writes nothing.
- `recoverStaleLeases`: reclaims RUNNING rows past expiry, appending the
  FAILED attempt (`LEASE_EXPIRED`) the dead worker never wrote, then
  requeues immediately or fails when exhausted. Bounded by `limit`
  (default 100) to stay a short transaction.
- `requeueWorkItem`: human retry, FAILED -> QUEUED only. SUCCEEDED rows
  are never rewritten; RUNNING leases are never yanked.

`src/queue/backoff.ts` — pure `base * 2^(n-1)` capped backoff
(30s base, 5min cap) plus shared lease/recovery constants.

`src/queue/dispatch.ts` — `runDispatcher` poll loop: reclaim stale,
claim one item for a registered-handler kind, `await` the handler
outside any transaction, complete the attempt. Handler throws and
invalid outcomes become `HANDLER_ERROR` failures (requeued while budget
remains). Shutdown is graceful: `shouldStop` stops new claims, the
in-flight handler drains, then the summary returns.

`src/worker/main.ts` + `config.ts` — the worker now runs the dispatcher
with an empty registry (safe idle + stale reclamation) and new
`WORKER_LEASE_MS` / `WORKER_POLL_MS` knobs. SIGTERM/SIGINT drains the
loop and logs the summary; a dispatcher fault exits fast for supervisor
restart instead of idling dead.

## Import-path bug found and fixed

The first full-suite run failed both worker-lifecycle spawn tests with
`ERR_UNSUPPORTED_DIR_IMPORT` for `../queue`: the repo TS loader retries
only extensionless *file* imports as `.ts`, while vitest/Next resolve
directory barrels. Unit tests were green because vitest masked the
crash; the real worker process caught it. Fixed by using file imports
in the three loader-path files (`main.ts`, `leases.ts`, `dispatch.ts`).
Note for later milestones: `src/server/intake.ts` still imports the
`../db` barrel, which is fine under Next/vitest but would crash if ever
loaded through the Node TS loader.

## For R2-C (SCRAPE handler)

- Register under `handlers.SCRAPE`; parse `item.payloadJson` with the
  R2-A `ScrapePayloadV1` schema (payloads are untrusted input).
- Call `context.heartbeat()` during long fetches; a false return means
  stop — completion will be dropped as `lease-lost`.
- Return BLOCKED (not FAILED) with the R2-A reason code for
  login/CAPTCHA/access outcomes; at-least-once execution means evidence
  writes must dedupe on the intake idempotency key.
- Lease default is 5 minutes; `WORKER_LEASE_MS` tunes it per deployment.
