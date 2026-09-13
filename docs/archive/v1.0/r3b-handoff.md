# R3-B Handoff — Board Queries and Card Detail API

```text
Work order: R3-B (Board queries and card detail API)
Outcome: five-column board projection with search/sort/pagination
  plus complete safe card detail, both read-only and path-leak-free
Status: accepted
Files changed:
  new: src/server/board.ts (BoardCardView/BoardView/JobDetailView
    builders, URL validation, fail-soft JSON reads)
  new routes: app/api/board (GET), app/api/jobs/[id] (GET)
  new tests: tests/unit/server/board.test.ts (9 builder cases),
    tests/unit/routes/board.test.ts,
    tests/unit/routes/job-detail.test.ts
  edited: docs/product-rebuild/status.md
Migrations/data effects: none (pure reads over existing tables)
Verification performed and exact result:
  npx tsc --noEmit clean; npx eslint . clean; context check
  consistent; npx vitest run --exclude '**/browser/**' 61 files /
  342 tests green (+3 files / +14 R3-B); npx next build --webpack
  green (both routes dynamic); /tmp 5-step probe green reading
  board/detail back from real R2-F clip + R3-A move/note writes
Acceptance criteria not yet proven: human review; R3-C consumer
  proof that cards render/escape correctly (R3-C owns the UI)
Decisions or deviations:
  - Every column always appears (empty ones carry total 0);
    search/pagination apply per column so totals stay meaningful.
  - Search covers card-visible title/company/location only, with
    LIKE wildcards escaped to literals.
  - History orders by rowVersion (the true per-job event
    sequence), not by millisecond timestamps with random-UUID
    tiebreaks.
  - URLs validate to http(s)-or-null at the boundary; hostile
    submitted/apply URLs degrade to null, never to links.
  - Corrupt/unknown-version stored JSON degrades to null per
    section; one bad row cannot 500 the board or a card.
  - Text travels raw for the renderer to escape (React default);
    the API transforms no content.
  - job_analyses requirements are not parsed: no R4 schemas exist
    yet, so the analyses section is omitted until R4 defines it.
  - Dangling resume pointers are impossible (trigger-enforced);
    the builder's null fallback is unreachable defense in depth.
Safety/human checkpoint: read-only routes (Host gate, no
  mutations); no filesystem paths serialized (artifacts resolve
  by id); no unvalidated URL is ever served as a link target.
```

## What was built

`src/server/board.ts` — `getBoardView(handle, {q, sort, limit,
offset})` returns all five columns with per-column totals and rank-,
updated-, or created-ordered cards carrying `rowVersion` for R3-A
compare-and-swap moves, resume pointer state, notes counts, and a
validated source URL. `getJobDetail(handle, jobId)` assembles the
job row, validated source URLs, scrape attempts, all-attempt
evidence refs (id/kind/media/size/hash — never paths), the active
extraction with parsed fields/provenance, resume versions with
artifact refs and reviews, notes, the application record, parsed
workflow history, and intake provenance.

`GET /api/board` — validates `sort` (rank/updated/created),
positive `limit` (clamped 1–200), non-negative `offset`, and
200-char `q` with 400s on violations; `GET /api/jobs/[id]` returns
404 for unknown jobs. Both are Host-gated reads sharing the R2-E
request plumbing.

## Bugs found by the new tests

- Timestamp+UUID history ordering is nondeterministic under
  same-millisecond inserts: the corrupt-JSON test exposed random
  event order, fixed by sequencing on `rowVersion`.
- The planned dangling-pointer degradation case is unseedable — a
  database trigger rejects cross-job active pointers at write time.
  The builder fallback stays as unreachable defense in depth.

## For R3-C (board UI)

- Cards carry everything the board needs plus `rowVersion` for
  moves; poll or revalidate `/api/board` after each mutation and
  retry once on `conflict` with the fresh version.
- Detail `notes[].body`, `descriptionText`, titles, and history
  metadata are raw user/page strings: render as text (React
  default), never `dangerouslySetInnerHTML`, and never as link
  targets — only `sourceUrl`/validated URL fields are links.
- Evidence and resume bytes resolve by artifact id
  (`/api/evidence/[id]` exists; an R4 resume-artifact route will
  mirror it) — the views intentionally contain no paths.
- Empty columns, null resumes, and missing extractions are normal
  states (fresh/failed jobs), not errors — render explicit
  unknowns per the R2-D convention.
