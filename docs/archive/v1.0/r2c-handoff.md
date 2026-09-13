# R2-C Handoff — Playwright Fetcher and Network Guard

```text
Work order: R2-C (Playwright fetcher and network guard)
Outcome: Chromium fetch pipeline with per-request guards, block
  detection, evidence persistence, and SCRAPE handler registration
Status: accepted 2026-09-11.
Files changed:
  new: src/scraping/browser.ts, src/scraping/guard.ts,
    src/scraping/throttle.ts, src/scraping/blocks.ts,
    src/scraping/envelope.ts, src/scraping/evidence.ts,
    src/scraping/fetch.ts, src/scraping/handler.ts
  edited: src/scraping/index.ts, src/server/intake.ts (import style
    only), src/worker/main.ts (SCRAPE registration + browser shutdown),
    src/worker/config.ts (PLAYWRIGHT_BROWSERS_PATH default)
  deps: package.json + package-lock.json (playwright 1.63.0, exact),
    .gitignore (.playwright-browsers/)
  new tests: tests/unit/scraping/guard|throttle|blocks|envelope|
    evidence|handler.test.ts, tests/unit/scraping/browser/fetch.test.ts
  edited: tests/unit/worker/config.test.ts (+1 browsers-path test)
Migrations/data effects: none (uses R1-B jobs/job_sources/
  scrape_attempts/source_artifacts as-is)
Verification performed and exact result:
  npx tsc --noEmit clean; npx eslint . clean;
  npx vitest run tests/unit/scraping/browser/fetch.test.ts: 14/14 passed;
  npx vitest run: 40 files / 234 tests green (all unit + browser tests).
Acceptance criteria not yet proven: human review.
Decisions or deviations:
  - intake.ts directory import converted to file imports (zero behavior
    change; intake tests green) so the worker loader can load the
    payload schema. Fixes the latent trap flagged in the R2-B handoff.
  - Blocked/failed fetches persist no artifacts; the attempt row carries
    the reason. Evidence stays a record of real postings only.
  - Status mapping: 404/410 STALE_INPUT, 429/5xx TIMEOUT (retryable),
    non-HTML and oversized UNSUPPORTED_PAGE, denials BLOCKED.
  - Per-origin politeness is worker-local memory (2s default), failing
    open on restart by design.
Safety/human checkpoint: no fetching ran against real sites in this
  session (all fixtures are route-fulfilled); no stealth, no login
  reuse, no cert-error bypass; strict-HTTPS and service-worker block
  are hardcoded in the isolation profile.
```

## What was built

Fetch pipeline (`src/scraping/`):

- `browser.ts` — one shared headless Chromium per worker; a fresh
  isolated context per fetch (service workers blocked, downloads off,
  strict HTTPS, popups closed, fixed viewport, honest default UA).
  Dead browsers are replaced on next use; worker shutdown closes cleanly.
- `guard.ts` — pure per-request policy (scheme, credentials, hostname,
  5-hop redirect budget) plus iterative redirect-chain counting. The
  route handler revalidates DNS on every request via the R2-A
  `preflightHost`, so redirects, subresources, and rebinding are all
  re-checked — never just the intake preflight.
- `throttle.ts` — `OriginThrottle` with injectable clock/sleeper.
- `blocks.ts` — conservative pure classifier over status + bounded
  text/HTML/title samples: refusal statuses → ACCESS_DENIED, challenge
  markers → CAPTCHA_REQUIRED, password field plus login demand →
  LOGIN_REQUIRED. Uncertain pages stay successes for R2-D to judge.
- `envelope.ts` — `FetchEnvelopeV1` (the R2-C → R2-D contract) with a
  deterministic content hash used as the queue `outputHash`.
- `evidence.ts` — content-addressed storage
  (`evidence/<sha-prefix>/<sha>.<ext>`, write-once dedupe),
  find-or-create job shell with domain-machine transitions (SUCCEEDED
  shells refuse; unique-race retry), and single-transaction persist of
  job state + `final_url` + attempt + artifact rows, with a
  double-persist guard.
- `fetch.ts` — orchestrator: throttle → context → guarded navigation
  (30s) → status mapping → best-effort network-idle settle → block
  detection → bounded capture (5MB HTML, 1M text chars, 50 JSON-LD
  blocks). Guard aborts on navigations map to PRIVATE_NETWORK /
  INVALID_URL failures; subresource aborts only degrade the page.
- `handler.ts` — `createScrapeHandler` wired to the R2-B dispatcher:
  strict payload parsing (garbage → STALE_INPUT without fetching),
  shell ensure → fetch (outside transactions) → persist → outcome.
  `PLAYWRIGHT_BROWSERS_PATH` defaults to `<repo>/.playwright-browsers`
  via worker config; the R2-A contract is honored (fetch submittedUrl).

## Environment blocker: no browser launches in this session

Every Chromium launch here dies during macOS GUI-service registration
(`TransformProcessType`, see the user's pasted crash report): the
headless shell SEGVs, full Chromium SIGABRTs, and even system Chrome
fails under Playwright's pipe transport. Direct system-Chrome runs exit
134 as well. Approval prompts are disabled, so unsandboxed retry is
unavailable. I stopped spawning browsers to end the crash dialogs.

Consequences, all reflected in the verification block above:

- The 14 tests in `tests/unit/scraping/browser/fetch.test.ts` are
  committed, typechecked, and lint-clean, but have never run green.
  They use route fulfillment (no real network, no guard bypasses) and
  cover static, JS-rendered, JSON-LD, redirect-chain, over-budget,
  private-host, private-redirect, private-subresource, 403, login,
  CAPTCHA, 404, oversized, non-HTML, hung-navigation, and legacy ATS
  fixture cases.
- Route newest-first ordering (fulfill pre-registered, guard runs
  first) was verified by reading the installed `playwright-core`
  bundle (`routes.unshift`), not by execution.
- The private-host test doubles as an ordering proof: if fulfillment
  ever ran before the guard, it would fail loudly.
- What *is* proven here: all 220 non-browser tests (incl. the worker
  spawn tests, which prove the handler + `playwright` import graph
  loads under the TS loader), tsc, and eslint.

To verify on a normal machine (one command, ~1 min):

```sh
npx vitest run tests/unit/scraping/browser/fetch.test.ts
```

with `PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers` (already
installed here). If any fail, suspect fixture/fulfillment semantics
first — that surface is the one part I could not execute.

## Review fixes from the user-machine run (2026-09-11, verified green)

The first user-machine run failed 13/14 browser tests (the sandbox had
hidden every runtime browser behavior). Five fixes landed, all reviewed
and approved from the R2-C owner side:

1. `browser.ts` popup listener closed the primary page (my bug:
   `newPage()` fires the context `page` event). Fix: create the page
   first, close only `popup !== page`. This was the 9-failure killer.
2. `fetch.ts` status mapping shadowed denials: the generic 4xx →
   UNSUPPORTED_PAGE check ran before block classification. Fix: 401 /
   403 / 407 / 451 → BLOCKED / ACCESS_DENIED first, with no artifacts.
3. `fetch.ts` PDF navigations abort with "Download is starting";
   the catch-all mapped that to TIMEOUT. Fix: `/download/i` →
   FAILED / UNSUPPORTED_PAGE. Slightly message-dependent, but scoped
   to the navigation-error path and pinned by the PDF test.
4. `fetch.test.ts` fixture router moved to a CDP Fetch.requestPaused
   dispatcher: Playwright route handlers are skipped for redirected
   requests, so fulfilled 302 targets hit real OS DNS and died with
   ERR_NAME_NOT_RESOLVED. The dispatcher collects `context.route`
   handlers (newest-first, mirroring Playwright) and invokes the REAL
   guard closure per request with faithful request/route shims.
   Fidelity deltas vs production dispatch: pattern matching is
   reimplemented (exact/prefix/RegExp — no fixture collisions),
   `isNavigationRequest` is approximated by CDP `resourceType`
   `Document` (accurate for single-frame fixtures), redirect depth is
   re-derived from CDP redirect events. Genuinely browser-exercised:
   redirect following, JS execution, rendered text/title, bodies,
   statuses, download aborts. The private-host tests still prove the
   guard runs before fulfillment.
5. Oversized/PDF test split into two contexts: `fetchJobPage` closes
   its context in `finally`, so the second fetch needed its own.

Result after fixes (user machine): 14/14 browser, 234/234 full suite,
tsc + eslint clean. The self-diagnosing `expectOutcome` assertions
added during triage are retained.

## For R2-D (extraction)

- Consume `FetchEnvelopeV1` + artifact bytes; reject unknown envelope
  versions. Record the extraction adapter on `job_extractions.adapter`
  (`scrape_attempts.adapter` stays NULL = fetch-only by design).
- Fill normalized job fields and set `active_extraction_id` in the same
  completion path; shells arriving without extraction are fetchable but
  card-incomplete by contract.
- Follow the file-import rule in anything the worker loads.
