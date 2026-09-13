# R3-A Handoff — Workflow Command Service

```text
Work order: R3-A (Workflow command service)
Outcome: transactional board commands (move, correction/reopen,
  reorder, Applied recording, Tailored gate, notes) with optimistic
  concurrency, one audit event per transition, and QUEUED-work
  cancellation on reject
Status: accepted
Files changed:
  new: src/domain/workflow.ts (event reason + versioned metadata
    contract, fail-closed reader)
  new: src/db/workflow.ts (board CAS, event/note/application
    repositories, cancel-by-job)
  new: src/server/workflow.ts (moveJob, correctJob, reorderJob,
    recordApplication, approveTailored, addNote)
  new tests: tests/unit/server/workflow.test.ts (20 integration
    cases on migrated temp databases)
  edited: src/domain/index.ts (barrel export, one line)
Migrations/data effects: none (uses the R1-B jobs/workflow_events/
  job_notes/applications/work_items/scrape_attempts/resume tables
  as-is; first writer of workflow_events/job_notes/applications rows)
Verification performed and exact result:
  npx tsc --noEmit clean; npx eslint . clean; context check
  consistent; npx vitest run --exclude '**/browser/**' 52 files /
  298 tests green (+1 file / +20 R3-A); browser file untouched by
  R3-A and still user-verified green from R2-C
Acceptance criteria not yet proven: human review; R3-B route-level
  proof that the Tailored gate and Applied confirmation cannot be
  bypassed via direct route calls (service layer enforces both;
  routes land in R3-B)
Decisions or deviations:
  - Event `reason` is the machine cause (move/correction/reorder/
    approval); all human text lives in versioned metadataJson.
  - Events store the NEW row_version and rank (the state created).
  - Ordinary REJECTED moves require a reason; corrections rely on
    their mandatory note instead.
  - Correction notes mirror into job_notes (audit + notes view).
  - Unranked moves append at end of column; approval keeps rank.
  - Same-rank reorder is a version-checked no-op (no event).
  - APPLIED entries upsert one applications row; leaving APPLIED
    keeps it as history.
  - Reject cancels QUEUED items (job-linked + intake-linked via
    scrape_attempts); RUNNING leases are never yanked.
  - addNote only: note edit/delete left out of R3 scope.
  - No legacy port: the R1-C state machine is the spec and the new
    five-state board deliberately differs from legacy statuses.
Safety/human checkpoint: every command pins actor to human at the
  schema level; approval/note/confirmation values are human inputs,
  never agent outputs; no ATS interaction anywhere.
```

## What was built

`src/domain/workflow.ts` — pure audit contract: `WorkflowEventReason`
(move/correction/reorder/approval), strict
`WorkflowEventMetadataV1` behind the envelope convention
(`schemaVersion: workflow-event-metadata-v1`), and
`parseWorkflowEventMetadata` which fails closed on malformed or
unknown-version payloads. No storage or framework imports.

`src/db/workflow.ts` — transaction-agnostic repositories:
`getJobBoardRow`, `casUpdateJobBoard` (conditional update + re-read,
null on conflict), `maxRankInColumn`, `appendWorkflowEvent`
(validates metadata through the Zod schema before storing),
`insertJobNote`, `getApplication`/`upsertApplication`, and
`cancelQueuedWorkForJob` (single UPDATE … RETURNING over
job-linked plus intake-linked QUEUED items).

`src/server/workflow.ts` — commands. Each parses strict Zod input
(violations throw), rules the move through R1-C `planBoardMove`, and
commits status + rank + event + version bump in one `withTransaction`
CAS — or returns a typed failure (`unknown-job`, the five planner
errors, `reason-required`, `tailored-binding`) with `currentRowVersion`
on conflicts. `recordApplication` is the Applied modal contract
(TAILORED → APPLIED only, timestamp required, blank confirmations
normalize to null). `approveTailored` is the Tailored gate: NEW-only,
active-pointer match, version APPROVED, human APPROVED review binding
the version's content hash. Nest-safe transactions let R4-F call the
gate inside its larger approval transaction (proven by test).

## Bugs found by the new tests

- None in R3-A code. Three test-seed mistakes (correction into
  TAILORED is correctly approval-only; single-row profile and unique
  profile-version seeds; RUNNING rows need lease fields at insert)
  were fixed in the tests, and the suite pins each behavior.

## For R3-B (routes) / R3-C (UI)

- Route-facing contracts are the exported `*Input` schemas plus
  `*Result` unions; every failure carries a machine `error` code and
  `currentRowVersion` on conflicts for refresh-and-retry.
- No path to APPLIED exists without `appliedAt` (ordinary and
  correction planners both require it; reorder cannot change status),
  and no path to TAILORED exists except `approveTailored` — R3-B
  routes must preserve both by passing human input straight through.
- Known gap for R4-E: RUNNING work for a rejected job still completes
  (its lease is valid); completion-side fencing against the bumped
  `row_version`/pointers is recorded as the R4-E follow-up and is the
  only piece of architecture §5 cancel/fence left open.

## For R4-F (approval)

- Call `approveTailored(handle, {jobId, resumeVersionId,
  observedRowVersion, actor: "human"})` inside the approval
  transaction after writing the APPROVED review; the gate sees the
  uncommitted review rows through the nest-safe transaction and
  performs the NEW → TAILORED move with the binding event.
- The gate checks pointer/version/review/content-hash binding only —
  artifact re-hashing before the call stays R4-F's job.

## Suite-flake note (pre-existing, not R3-A)

- Two full-suite runs each dropped one timing-sensitive test
  (`IntakeForm` focus once, `processes` SIGTERM-shutdown once); both
  pass in isolation and a stashed-base full run failed the same
  `processes` test. Final observed run: 52 files / 298 tests green.
