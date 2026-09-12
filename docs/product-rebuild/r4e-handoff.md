# R4-E Handoff — Local agent adapter and tailoring orchestration

```text
Work order: R4-E (Local agent adapter and tailoring orchestration)
Outcome: implemented — provider-neutral contract, argv command adapter
         with time/output limits, deterministic test provider, snapshot
         adapter, deterministic draft/audit builders, orchestration
         pipeline, idempotent TAILOR queue handler with fencing, worker
         registration, and extraction-triggered enqueue.
Status: accepted
Files changed:
  new: src/tailoring/{contract,adapt,testProvider,commandAdapter,
       draft,audit,orchestrate,enqueue,publish,persist,handler}.ts,
       src/db/tailoring.ts, drizzle/0003_analysis_attempt.sql (+ meta),
       tests/unit/tailoring/{contract,adapt,command,draft,
       orchestrate,handler}.test.ts + support.ts
  mod: src/db/{index,schema/analysis}.ts, src/domain/enums.ts
       (RENDER_FAILED), src/resumes/{checks,config}.ts,
       src/scraping/evidence.ts (enqueue), src/tailoring/index.ts,
       src/worker/{config,main}.ts, purity/enums/migrate/startup/
       evidence/worker-config tests, status.md
Migrations/data effects: 0003 adds nullable job_analyses.attempt_json;
  applies cleanly on fresh DBs (verified 0000-0003 order). No data
  backfill; no legacy code touched.
Verification performed and exact result:
  new/affected suites → 106 passed (tailoring, worker, evidence, purity);
  npx vitest run → 612 passed / 17 skipped / 0 test failures; the only
  failing files are the 2 pre-existing environment-blocked browser
  suites (fetch + PDF, headless-shell SIGSEGV, unchanged);
  npx tsc --noEmit → clean; npx eslint . → clean;
  worker ts-loader smoke (handler/enqueue/adapter/evidence/config/
  docx imports + provider default + template load) → LOADER_OK.
Acceptance criteria not yet proven: human review of this handoff; live
  Chromium PDF run through the worker (browser-blocked here); review
  UX consumption of contentJson.audit (R4-F).
Decisions or deviations:
  - Rejected proposals persist no analysis row; attempts survive via
    work_attempts input/output hashes + reason detail. Full attempt
    envelopes persist only for validated proposals.
  - Superseding runs while a review is pending report BLOCKED: the
    R1-C machine has no review-yanking edge, so the human resolves
    the pending review (or requests revision) before regeneration.
  - RENDER_FAILED added to ReasonCode (widening only) for page-budget
    / minimum-text / containment / renderer faults.
  - Tenure "as of" is the later bound-snapshot date, so identical
    snapshots regenerate identically across reruns.
  - Change summary is a deterministic structured bullet
    added/removed diff (no unified-diff dependency); R4-B pins no
    diff format.
Safety/human checkpoint: strict schemas reject smuggled approval/
  path/hash/coverage fields; provider stderr is counted and dropped
  (never persisted/logged, no chain-of-thought); subprocess via
  argv array, shell:false; all persistence fenced on row version,
  status, extraction pointer, and RUNNING state; membership trigger
  backstops citations; approval and Tailored transitions untouched.
```

## Module map

- `contract.ts` — versioned TailoringInputV1 / ResumeProposalV1 /
  ProviderAttemptV1 / AuditSummaryV1 / ResumeContentV1, the
  `TailoringProvider` interface, and reason-coded `ProviderError`.
- `adapt.ts` — R4-A snapshot rows → R4-C read model (single boundary).
- `testProvider.ts` — scripted deterministic provider (strict-validated
  fixtures, records inputs).
- `commandAdapter.ts` — argv subprocess provider: stdin envelope,
  stdout proposal, timeout kill, output cap kill, exit mapping,
  path-only schema diagnostics.
- `draft.ts` — deterministic draft (rank → compose summary → verbatim
  employment-grouped claims → education, renumbered).
- `audit.ts` — deterministic baseline-vs-tailored change summary.
- `orchestrate.ts` — envelope → provider → binding/rule validation →
  stale-input gate → rank/plan/compose → draft validation → one view
  model → MD/DOCX/HTML/PDF → budget/text/containment checks → content
  hash, diff, audit. Accepted proposals survive downstream failures.
- `enqueue.ts` — TailorPayloadV1 + idempotent `requestTailoring`.
- `publish.ts` — temp-file + fsync + atomic rename artifact publish
  with collision detection and identical-byte reuse.
- `persist.ts` — fenced transactions: begin (RUNNING), analysis,
  version attach (dedupe + lineage + claims/citations/artifacts),
  terminal state writes. Writers bump `row_version` like board moves.
- `handler.ts` — TAILOR `WorkHandler` wiring it all together with
  lease checks and structured logging (ids only, no content).
- `db/tailoring.ts` — row helpers + bumped CAS.

## Test inventory (59 new)

- `contract.test.ts` (5): strict rejection of smuggled approval/path/
  hash/template/coverage fields, versions, bounds, enums.
- `adapt.test.ts` (2): storage→port mapping incl. null evidence.
- `command.test.ts` (10): live subprocess round-trip, argv-hash
  stability, non-JSON/schema/exit/timeout/output-cap/missing-exe/
  empty-stdout mapping, config validation.
- `draft.test.ts` (6): ranking/summary/ordering/renumbering,
  validator acceptance, change-summary determinism.
- `orchestrate.test.ts` (8): full pipeline to four verified
  artifacts, fabricated-quote/mis-binding/timeout/empty-JD
  rejection, smuggled-approval rejection, render-failure
  fail-closed with accepted proposal retained.
- `handler.test.ts` (11): full version attach with verified bytes,
  idempotent rerun, supersede-blocked, no-provider/no-profile
  BLOCKED, invalid-proposal FAILED with zero rows, extraction/
  rejection fencing, lease loss, bad payload, enqueue dedupe.
- Extended: worker config (5), evidence enqueue seam (2), purity
  boundary (5), migration/enum pins (mechanical 0003 +
  RENDER_FAILED updates).

## For R4-F

- Review UX reads `resume_versions.contentJson` (ResumeContentV1:
  draft, rankedFactIds, coverage, omittedUnsupported, summary
  strategy, changeSummary, audit) plus `job_analyses`
  (requirements/gaps/attempt envelopes) and artifact rows/bytes.
- Requesting revision sets REVISION_REQUESTED then calls
  `requestTailoring(handle, {jobId, extractionId})` with the current
  active extraction; approval flow owns the Tailored transition.
- Operators set `TAILOR_PROVIDER_ARGV` (JSON argv array) plus optional
  `TAILOR_PROVIDER_TIMEOUT_MS` / `TAILOR_PROVIDER_MAX_OUTPUT_BYTES` /
  `TAILOR_PROVIDER_MODEL`; without it, runs report BLOCKED with a
  manual-retry path via `requeueWorkItem`.
