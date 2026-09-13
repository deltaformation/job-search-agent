# R1-C Handoff — Domain Contracts and State Machines

Status: accepted 2026-09-11. Branch: `rebuild/r1-platform` (R1-A + R1-B
+ R1-C files uncommitted in working tree; R0 checkpoint is commit `de8a533`
on `main`).

## Outcome

Pure TypeScript domain layer under `src/domain/`: Zod schemas mirroring
every R1-B CHECK list, state machines for board / scrape / tailoring /
review, human review command + exact-version approval record schemas,
artifact contracts, and a versioned JSON envelope convention. No storage,
network, browser, or framework imports; a purity guard test enforces that.

## Added pins (exact; lockfile still 649 packages — Zod has no dependencies)

zod 4.6.2. Verified v4 API surface empirically before use (`z.uuid()`,
`z.iso.datetime()` which already requires UTC `Z`, `z.int()`, `.strict()`).

## Contract notes for reviewers

- Board: ordinary move graph from the architecture; off-graph moves need a
  correction with a human note; entering `TAILORED` requires the approval
  kind unconditionally (corrections cannot enter it, even with a note);
  moves into `APPLIED` must carry `appliedAt`; every move CAS-checks
  `row_version` and returns `newRowVersion = current + 1`.
- Scrape/tailoring/review machines return data results (`ok` / `forbidden` /
  `reason-required`), never throw; `FAILED`/`BLOCKED` targets require a
  reason code. No re-scrape out of `SUCCEEDED` in MVP (deliberate).
- `contract-mirror.test.ts` parses every CHECK `IN` list from the migrated
  DDL and asserts exact equality with its Zod enum — neither side can drift.
- Deliberately not built (owned elsewhere): `TailoringInputV1` /
  `ResumeProposalV1` (R4-E), claim/ranking/keyword logic (R4-C), queue
  leasing (R2-B), URL canonicalization (R2-A), path root resolution (R1-D —
  domain validates path *shape* only, documented seam).
- One test-annotation fix during the run: Zod v4 changed the `ZodEnum`
  generic from tuple to record; annotations use `ZodEnum<Record<string,
  string>>`.

## Verification evidence (all on Node v24.21.0)

- `tsc --noEmit`: exit 0.
- `eslint .`: exit 0, no output.
- `vitest run`: 17 files, 91/91 passed (50 new: 48 domain + 2 mirror; all
  41 prior tests still green).
- `node scripts/check-project-context.mjs`: consistent.
- Not rerun: `next build` (no UI/bundle code touched), legacy Python suite
  (no Python touched).

## Decisions and deviations

- Corrections into `APPLIED` must carry `appliedAt` (same rule as ordinary
  moves) so no path lands in `APPLIED` without recorded metadata.
- `RequiredNote` trims before the length check, so whitespace-only notes
  are rejected at the schema level.
- Purity guard forbids the work order's named frameworks plus any `..`
  escape from `src/domain`; `node:` builtins are not forbidden (unused
  today, not prohibited by the work order).

## Next ready work

R1-D (supervisor, storage, security) still waits on R1-B acceptance. R2-A
(URL policy) and R2-B (queue) need R1 accepted (R1-D complete). R3/R4
services should consume these machines/schemas rather than re-implementing
transition rules.
