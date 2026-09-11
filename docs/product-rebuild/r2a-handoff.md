# R2-A Handoff — URL Policy and Intake Service

Status: accepted 2026-09-11. Branch: `rebuild/r1-platform` (past R1
commit `d392814`; R2-A files uncommitted in working tree).

## Outcome

Paste-to-queue intake without UI or fetching: URL validation +
canonicalization (`src/scraping/urls.ts`), SSRF DNS preflight
(`src/scraping/ssrf.ts`), and a transactional batch service
(`src/server/intake.ts`) that classifies every line, dedupes twice, and
enqueues `SCRAPE` work with idempotency keys and a versioned payload for
R2-C. Legacy normalizer/deduplicator cases ported with documented fixes.
No new dependencies.

## Contract notes for reviewers

- Canonical forms: `submittedUrl` (trimmed original, preserved verbatim,
  fetched by R2-C), `canonicalUrl` (lowercased host, default port dropped,
  trailing slash trimmed, tracking stripped, query sorted, no fragment),
  `canonicalKey` (`ats:<board>:<id>` for Indeed `jk` / LinkedIn job ids,
  else `url:<canonicalUrl>`). Namespaces cannot collide.
- Ported from legacy: tracking strip list, `jk`/`currentJobId`/`/jobs/view`
  recognition, ATS domain list + labels, canonical-URL dedupe signal.
  Deliberately fixed: `spJobID`/`spPostingID` never stripped (case bug),
  geo/scheme-rewriting Indeed/LinkedIn shortcuts (now host-preserving),
  substring ATS matching (now exact-or-subdomain), unstable query order
  (now sorted). Title/location/ATS-apply/company/content-hash signals are
  R2-D post-fetch work, not built here.
- SSRF: 40+ address matrix (v4/v6, mapped/6to4 unpacking, cloud metadata
  IP), literals skip DNS, any non-public answer blocks, NXDOMAIN is
  invalid, stalls/resolver errors are retryable `TIMEOUT` blocks.
  Connect-time pinning stays R2-C's job.
- Service: blank lines skipped (original numbering kept), whole batch
  capped at 100 URLs (`IntakeError`, nothing persisted), per-line
  transactions (batch row, line item, work item), in-batch → stored-key →
  queue-key dedupe order, UNIQUE races reclassify to `DUPLICATE`.
  Previously failed queue entries dedupe on re-paste; retry is R2-E's
  explicit action, not re-paste.
- `ScrapePayloadV1` (`scrape-payload-v1`) is the R2-C handoff: fetches
  `submittedUrl`, dedupes on canonicals.

## Verification evidence (all on Node v24.21.0)

- `tsc --noEmit`: exit 0 (two narrowing restructures during the run).
- `eslint .`: exit 0, no output.
- `vitest run`: 30 files, 160/160 passed (30 new: 14 urls, 9 ssrf,
  7 intake; all 130 prior green).
- `node scripts/check-project-context.mjs`: consistent.
- Not rerun: `next build` (no UI/bundle code touched), legacy Python
  suite (no Python touched; legacy tests were read, not run).

## Decisions and deviations

- Bare domains without a scheme are invalid (no `https://` guessing);
  R2-E may suggest it in UI copy.
- `http` is accepted and preserved per architecture (warning is R2-E UI).
- Scheme is part of the dedupe key (no cross-scheme merging).
- `refId` kept as a significant param (legacy-faithful; only the
  LinkedIn key ignores it); the tracking list can grow with evidence.
- Teredo is not unpacked (deprecated tunnel; documented in code).

## Ready next

R2-B (queue leasing + dispatch, already ready) can start in parallel —
no file overlap. R2-C consumes `ScrapePayloadV1` + `scrapeIdempotencyKey`
and owns connect-time SSRF, adapters, and job creation. R2-D owns
post-fetch dedupe signals 2–5 and the merge that sets `intake_items.job_id`.
