# R2-E Handoff — Intake Routes and Attempt Visibility

```text
Work order: R2-E (Public intake routes and attempt visibility)
Outcome: paste-to-queue intake with per-line outcomes plus live batch
  progress, attempt deep-dives with job cards, human retry, and
  sandboxed evidence downloads — all Host/Origin-gated
Status: accepted
Files changed:
  new: app/api/_lib/request.ts (gates, request DB, body parsing)
  new routes: app/api/intake/prepare|submit, intake/batches[/[id]],
    attempts/[id][/retry], evidence/[id]
  new pages: app/intake, app/intake/batches/[id], app/attempts/[id]
  new: components/IntakeForm|BatchProgress|AttemptView|RecentBatches,
    components/api.ts, components/outcome-label.tsx
  new: src/server/queries.ts (batch/attempt/artifact views)
  new tests: tests/unit/routes/*.test.ts (5 files + _helpers),
    tests/unit/components/*.test.tsx (3), tests/unit/server/queries.test.ts
  edited: next.config.ts (serverExternalPackages better-sqlite3)
Migrations/data effects: none (reads/writes R1-B intake_batches/
  intake_items/jobs/job_sources/job_extractions/scrape_attempts/
  source_artifacts and R2-B work_items/work_attempts as-is)
Verification performed and exact result:
  npx tsc --noEmit clean; npx eslint . clean; context check consistent
  (16 files, 9 entrypoints); npx vitest run --exclude
  '**/browser/**' 51 files / 278 tests green (+9 files / +35 R2-E);
  npx next build --webpack green (7 R2-E routes dynamic, /intake
  static-prerendered); supervisor fresh-root setup created migrated
  job-tracker.sqlite (24 tables); /tmp 22-step handler-level probe
  green (gates, prepare/submit, dupes, claim→scrape→complete,
  exhaustion→retry, attempt view, evidence bytes+CSP)
Acceptance criteria not yet proven: live TCP smoke (sandbox EPERM on
  listen; escalation denied — run `npm run dev` + curl on user
  machine); browser fetch file untouched by R2-E, still user-verified
  green from R2-C; human review
Decisions or deviations:
  - Mutations gated by Host/Origin (+sec-fetch-site), the R1
    security layer — no token CSRF exists in this codebase.
  - Routes never create storage or run migrations: missing/
    unmigrated DB is 503, because silent creation would mask a
    broken supervisor setup.
  - Evidence resolves through DB id + allowlisted evidence root
    only; hostile bytes ship sandboxed CSP + nosniff, immutable
    cache, optional ?download=1 attachment.
  - Retry is human-driven, FAILED-only, body-ignored; successes are
    never rewritten and live leases never yanked (409 otherwise).
  - Invalid/blocked lines repeat their own outcome and are never
    DUPLICATE (R2-A classify order: dedupe only past preflight).
  - Polling pauses when the tab is hidden and honors Retry-After;
    initial fetch-on-mount carries a scoped lint disable with
    rationale (no cascading render: setState only after network).
  - Turbopack build is sandbox-blocked (sidecar spawn EPERM);
    webpack production build is the green gate here.
Safety/human checkpoint: intake accepts user URLs only; retry only
  requeues queue work; evidence serves captured bytes; no ATS
  interaction, no autofill, no approval-state change anywhere.
```

## What was built

`app/api/_lib/request.ts` — shared route plumbing: `routePolicy`
(loopback hosts/origins for `PORT`), `mutationGate` (403 on
bad-host/bad-origin/missing-origin), `readGate` (Host only),
`openRequestDatabase` (one request-scoped handle, 503 when the
supervisor-owned DB is missing/unmigrated, caller-closed in
`finally`), Zod `parseJsonBody` (400 on malformed/schema-mismatch).

Routes (all `force-dynamic`, all gated):

- `POST /api/intake/prepare` — validates pasted lines without
  persisting (same classifier submit runs, so the preview matches).
- `POST /api/intake/submit` — persists the batch, items, jobs, and
  SCRAPE work rows; returns per-line results plus counts.
- `GET /api/intake/batches[?limit]` and `GET
  /api/intake/batches/[id]` — batch summaries and per-line outcomes
  with live queue state (re-derived from canonical URL, since intake
  rows predate the work rows they cause).
- `GET /api/attempts/[id]` — work item + attempts ledger + latest
  scrape outcome + normalized job card + artifact refs.
- `POST /api/attempts/[id]/retry` — requeues terminal FAILED items;
  404 unknown, 409 anything else.
- `GET /api/evidence/[id]` — one artifact's bytes by DB id with
  `content-security-policy: sandbox`, nosniff, immutable cache;
  `?download=1` switches to attachment.

`src/server/queries.ts` — `getBatchView`, `listBatches`,
`getWorkItemView`, `getArtifact`, `findWorkForCanonicalUrl`. Sync
reads, no transactions held, no framework imports.

Pages/components:

- `/intake` (statically prerendered — proves no build-time DB open):
  `IntakeForm` (paste → prepare preview → submit → batch link) plus
  `RecentBatches`.
- `/intake/batches/[id]`: `BatchProgress` polls until the batch is
  terminal, then stops; per-line outcome, reason, queue state, and
  attempt links; retry buttons on FAILED lines.
- `/attempts/[id]`: `AttemptView` with attempts ledger, scrape
  outcome/detail, job card (title/company/location/arrangement/
  salary/description/completeness), artifact download links, retry.
- `components/api.ts` (`fetchJson`, typed `ApiError` with
  retryable/Retry-After) and `outcome-label.tsx` (text+shape labels,
  never color-only).

## Bugs found by the new tests

- `void refresh()` fetch-on-mount trips the new
  `react-hooks/set-state-in-effect` rule in both polling components.
  Restructuring around it would defer or duplicate the load for no
  behavioral gain, so each site carries a scoped disable with the
  rationale (setState only after a network round-trip).
- Repeated lines that fail preflight (unresolvable, invalid,
  SSRF-blocked) are NOT duplicates — dedupe keys on canonical URLs
  that passed validation. Probe and tests pin this so the UI never
  promises a dupe link for a line that never enqueued.

## For R3 (resume tailoring)

- Attempt views expose `job.activeExtractionId` lineage and
  per-artifact SHA-256; `extracted_json.provenance` (R2-D) is the
  citation input for resume claims.
- `POST /attempts/[id]/retry` is the pattern for future
  human-gated queue actions: path id is the target, body ignored,
  terminal-state-only, 409 on anything else.
- Live smoke still owed on a non-sandboxed machine: `npm run dev`,
  paste 3 URLs at `/intake`, watch the batch page drain, open an
  attempt, download evidence, retry a FAILED line.
