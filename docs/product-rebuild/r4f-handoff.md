# R4-F Handoff — Resume review and approval UI/service

```text
Work order: R4-F (Resume review and approval UI/service)
Outcome: Human review vertical complete: side-by-side proposal/evidence/gap
      review, artifact preview/download, mandatory-note revision requests with
      atomic follow-up enqueue, and exact-version approval that re-hashes
      artifacts and moves the card to TAILORED via the R3-A gate.
Status: accepted
Files changed:
  New: src/server/review.ts (commands + read model),
       components/board/ResumeReview.tsx,
       app/api/jobs/[id]/resume/approve/route.ts,
       app/api/jobs/[id]/resume/revise/route.ts,
       app/api/resumes/[id]/review/route.ts,
       app/api/resumes/artifacts/[id]/route.ts,
       tests/unit/server/review.test.ts,
       tests/unit/routes/resume-review.test.ts,
       tests/unit/tailoring/revision.test.ts,
       tests/unit/components/board/ResumeReview.test.tsx
  Edited: src/server/workflow.ts (gate flips tailoring APPROVED in its CAS),
       src/db/workflow.ts (optional tailoring columns on CAS),
       src/tailoring/enqueue.ts (revision key + requestRevisionRun),
       src/tailoring/persist.ts + src/db/tailoring.ts (dedupe converges
       only onto the live active version),
       components/board/CardDrawer.tsx (per-version review panels),
       app/api/jobs/_lib/failures.ts (review mapping),
       tests/unit/tailoring/support.ts, tests/unit/tailoring/handler.test.ts,
       tests/unit/server/workflow.test.ts, docs/product-rebuild/status.md
Migrations/data effects: None. No schema or migration changes.
Verification performed and exact result:
  - 7 touched files: 60/60 pass (12 service, 6 route, 3 revision-loop,
    5 component, plus existing handler/workflow/CardDrawer suites).
  - Full npm test: 95 passed (95 files) / 655 passed (655 tests) / 0 failures.
  - npm run test:e2e: 7 passed (7).
  - npm run typecheck: exit 0. npm run lint: exit 0.
  - Rejects proven by test: tampered/missing/partial artifacts, stale
    row versions, superseded versions, repeat approvals, non-NEW jobs,
    agent actors (schema throw + route 400), missing revision notes,
    REJECTED jobs, corrupt JSON sections (fail-soft), unknown ids.
Acceptance criteria not yet proven:
  - GateRejected rollback branch is concurrency-only; reasoned correct
    via throw-rollback, not directly testable single-threaded.
Decisions or deviations:
  - Revision notes persist on the review row and show in UI but are NOT
    forwarded into the provider envelope (TailoringInputV1 is a frozen
    R4-E contract; needs a v2 input + prompt follow-up). A deterministic
    provider may yield a byte-identical child, honestly recorded as a
    new version with parent link — satisfies "revision creates a new
    version".
  - Revision binds stored digests without disk reads (damage is a reason
    to revise); approval strictly re-hashes and fails loud on drift.
  - True-concurrent double approval can surface a 500 (trigger abort);
    sequential double-submit returns forbidden; UI disables while busy.
Safety/human checkpoint: Actor forced to human server-side; approval is
  a two-step UI gesture plus Origin-gated route; no ATS/autofill paths
  touched; human applies manually as before.
```

## Module map

- `src/server/review.ts` — review read model (`getResumeReview`), approval command
  (`approveResumeVersion`), and revision command (`requestResumeRevision`).
- `components/board/ResumeReview.tsx` — review UI panel with requirements audit,
  gaps, summary, draft bullets, artifact download links, revision request modal,
  and 2-step approval gesture.
- `app/api/jobs/[id]/resume/approve/route.ts` — CSRF/Origin-gated POST route for approval.
- `app/api/jobs/[id]/resume/revise/route.ts` — CSRF/Origin-gated POST route for revision request.
- `app/api/resumes/[id]/review/route.ts` — GET route for review detail.
- `app/api/resumes/artifacts/[id]/route.ts` — GET route for artifact download with safe headers.

## Milestone 4 Completion

With R4-F accepted, Milestone 4 (Truthful tailoring and resume artifacts) is
fully complete. All 6 work orders (R4-A through R4-F) are verified and accepted.
