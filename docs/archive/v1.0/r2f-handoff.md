# R2-F Handoff — 1-Click Browser Clipper and Direct DOM Intake

```text
Work order: R2-F (1-Click Authenticated Browser Clipper and Direct DOM Intake)
Outcome: clip authenticated DOM from the user's own browser (extension or
  bookmarklet) straight to NEW jobs, plus a paste fallback on blocked
  attempts — no stealth, no sessions, no bypass
Status: accepted
Files changed:
  new: src/security/clip-token.ts (bearer token issue/verify)
  new: src/server/clip.ts (ingest core: validate, dedupe, detect,
    extract, persist)
  new routes: app/api/intake/clip (POST+OPTIONS), intake/clip-token
    (GET), attempts/[id]/content (POST)
  new: extensions/clipper/{manifest.json, service-worker.js,
    options.html, options.js, README.md}
  new: components/ClipperBookmarklet.tsx
  edited: app/intake/page.tsx (clipper section first),
    components/AttemptView.tsx (paste drawer)
  new tests: unit/server/clip, unit/security/clip-token,
    unit/routes/clip, unit/routes/attempt-content,
    unit/components/ClipperBookmarklet, unit/extensions/clipper
  edited tests: unit/components/AttemptView (+3 drawer cases)
  edited: docs/product-rebuild/status.md
Migrations/data effects: none (reuses intake/jobs/sources/attempts/
  artifacts/extractions tables; token lives in a 0600 data-root file,
  not the database)
Verification performed and exact result:
  npx tsc --noEmit clean; npx eslint . clean (incl. extension JS);
  context check consistent; npx vitest run --exclude
  '**/browser/**' 58 files / 328 tests green (+6 files / +30 R2-F);
  npx next build --webpack green (3 clip routes dynamic, /intake
  static); node --check on extension JS + manifest JSON valid +
  generated bookmarklet parses; /tmp 8-step handler probe green
  (token, preflight, auth, create+evidence files, duplicate,
  CAPTCHA reject, paste create, paste 409)
Acceptance criteria not yet proven: real-browser extension load and
  live-site clip (needs user machine + Chrome/Brave); live
  bookmarklet POST through Next (sandbox cannot listen); human review
Decisions or deviations:
  - Bearer token replaces the Origin gate on the clip route only:
    cross-origin-by-design, Host gate still via middleware, no
    cookies/credentials, token never leaves localhost (display
    route has no CORS headers), constant-time verify, corrupt
    file fails closed with an actionable error.
  - No DNS preflight for clips (nothing is fetched, so no SSRF);
    private/intranet URLs are clippable; scheme/credential/
    hostname syntax policy still enforced.
  - Full pipeline reuse: canonical-key dedupe, ensureFetchShell,
    detectBlock, runExtraction, persistFetchOutcome, identical
    byte caps; worker_id clip/paste marks provenance.
  - SUCCEEDED jobs are never re-clipped; FAILED/BLOCKED/in-flight
    shells are completed by the clip (self-healing; residual
    last-writer-wins race with an in-flight fetch documented).
  - Clips audit through intake batch+item rows but create no work
    items; domain outcomes are all HTTP 200 (mirrors intake).
  - Blocked/failed clips store no artifacts (evidence stays real
    postings); paste eligibility is server-enforced (409).
  - React 19 neuters javascript: hrefs, so the bookmarklet sets
    its href via ref — safe because the builder JSON-quotes the
    origin and the component validates the hex token.
  - Two routes beyond the owns-list were required: clip-token
    (bookmarklet/extension setup) and attempts content (the
    fallback deliverable itself).
Safety/human checkpoint: the user explicitly sends DOM from pages
  they opened; the manifest requests no cookie/session access;
  nothing fills or submits forms; every job lands NEW (board
  moves still need R3-A commands and human approval).
```

## What was built

`src/server/clip.ts` — `ingestClippedDom` runs the whole flow
synchronously: size bound → canonicalize → canonical-key dedupe →
shell ensure/reuse → block detect → extract → persist attempt,
artifacts, extraction, and job fields, plus intake batch/item audit
rows. `clipTextFromHtml` (script/style stripped, capped) and
`clipJsonLdBlocks` (fetcher-identical caps) derive pipeline inputs
from raw HTML; user-selected text wins when supplied.

`src/security/clip-token.ts` — lazy 0600 token file with exclusive
create (concurrent first reads converge), strict shape checks, and
constant-time bearer verification.

Routes — `POST /api/intake/clip` (token auth, OPTIONS preflight,
413 bounds, CORS headers on every response including errors),
`GET /api/intake/clip-token` (Host-gated, no CORS), and
`POST /api/attempts/[id]/content` (standard mutation gate, payload
parse, CAPTCHA/EXTRACTION_INCOMPLETE eligibility gate, then the
shared ingest core with `paste` provenance).

`extensions/clipper/` — dependency-free MV3 package: toolbar click
captures `{url, title, html, selectedText}` via a self-contained
injected function and POSTs with the stored token; badge reports
OK/DUP/FAIL/ERR with hover detail; options page holds base URL +
token with a health-check test button. Manifest requests no cookie
access (pinned by test).

UI — `/intake` leads with `ClipperBookmarklet` (personalized
draggable link, token + copy for the extension, setup explanation);
`/attempts/[id]` gains an accessible paste drawer (aria-expanded,
labeled textarea, status notices) that appears only for the two
eligible reason codes.

## Bugs found by the new tests

- `executeScript`-injected functions serialize source only: the first
  capture function referenced worker-scope constants that would have
  been `undefined` in the tab (size guard silently dead). Inlined all
  values; the manifest test now pins self-containment.
- React 19 replaces `javascript:` href props with a throw stub, which
  would have shipped a dead bookmarklet. Ref callback + validated
  token (above).

## For R3-B/C and R4

- Clipped jobs are ordinary NEW rows (same tables, same states);
  board projection needs no clip-specific handling. Clip provenance
  is `scrape_attempts.worker_id` (`clip`/`paste`) and the intake
  batch of one line.
- The `.clip-token` file is part of the data root: R5-B backup
  should include it (losing it only forces a token re-paste, since
  the route regenerates a fresh one).
- Live checklist for the user machine: `npm run dev`, load
  `extensions/clipper/` unpacked, paste the token from `/intake`,
  clip the two previously-failing jobs — expect NEW cards with
  HTML/TEXT/JSONLD evidence — and paste content into one
  CAPTCHA-failed attempt.
