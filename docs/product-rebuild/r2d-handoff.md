# R2-D Handoff — Extraction Adapters and Normalization

```text
Work order: R2-D (Extraction adapters and normalization)
Outcome: deterministic extraction pipeline (ATS adapters, JSON-LD,
  generic fallback) wired into the SCRAPE handler with immutable
  extraction rows and visible missing-field reports
Status: accepted
Files changed:
  new: src/extraction/types.ts, normalize.ts, jsonld.ts, generic.ts,
    extract.ts, index.ts, adapters/index.ts, adapters/greenhouse.ts,
    adapters/lever.ts
  edited: src/scraping/evidence.ts (extraction persist),
    src/scraping/handler.ts (extract step between fetch and persist)
  new tests: tests/unit/extraction/normalize|adapters|strategies.test.ts
  new fixtures: 6 posting HTML cases + oracle-inputs/goldens JSON
  new: scripts/generate-extraction-goldens.py (reproducible oracle run)
  edited: tests/unit/scraping/evidence|handler.test.ts (+3 cases)
  deps: package.json + lock (node-html-parser 9.0.4, exact)
Migrations/data effects: none (uses R1-B jobs/job_sources/
  job_extractions as-is; first writer of job_extractions rows)
Verification performed and exact result:
  npx tsc --noEmit clean; npx eslint . clean; context check consistent;
  npx vitest run --exclude '**/browser/**' 42 files / 243 tests green
  (+23); browser file untouched by R2-D (calls fetchJobPage directly)
  and still user-verified green from R2-C
Acceptance criteria not yet proven: human review
Decisions or deviations:
  - First-usable-wins precedence (adapter, JSON-LD, generic); fields
    never merge across strategies, so provenance stays exact.
  - Legacy title/location inventions NOT ported ("Unknown Role",
    "Unknown Company", seniority inference, Toronto/Ontario/Canada
    expansions, full_time default). Trim-only + null instead; each
    diff asserted as intentional against oracle goldens.
  - Content hash and arrangement mapping ported byte/semantics-exact
    (incl. code-point slicing and the remote>hybrid>onsite order).
  - No salary annualization: hourly/daily/monthly and unknown-
    currency amounts keep raw text with null minors.
  - Extraction failure (no title AND no description) fails the job as
    EXTRACTION_INCOMPLETE with artifacts kept but no extraction row
    and no card fields — never a malformed card.
  - applyUrl falls back to the posting URL (legacy parity); arrangement
    is always classified (UNKNOWN default), never in missingFields.
  - source_identity left NULL: no merge consumer exists in MVP and
    inventing identity semantics without a merge design is speculative.
Safety/human checkpoint: extraction runs on fetched bytes only, writes
  no resume content, changes no approvals; all values traceable to
  selectors/JSON-LD paths in extracted_json provenance.
```

## What was built

`src/extraction/` — pure, browser-free, transaction-free:

- `types.ts` — `ExtractionInput`, `NormalizedJobFields`,
  per-field `FieldProvenance` (selector/JSON-LD path per value, for
  R4 fact citation), `ExtractionOutcome`, `JOB_EXTRACTION_VERSION`.
- `normalize.ts` — content hash (exact legacy port), trim-only
  cleaners, arrangement classifier (exact legacy mapping),
  conservative salary parser (annual-only minors, reversed-range
  swap, explicit-code-beats-`$`), posted-date ISO-or-null,
  policy-validated apply-URL resolution.
- `jsonld.ts` — first `JobPosting` across blocks (malformed skipped,
  `@graph`/arrays searched): title, hiringOrganization,
  jobLocation→"Locality, Region, Country", TELECOMMUTE flag,
  baseSalary with the no-annualization rule, markup-stripped
  description, datePosted.
- `adapters/` — Greenhouse (`h1.app-title`, `.location`, `#app-body`,
  `#apply_button`) and Lever (`.posting-headline h2`,
  `.posting-categories .location`, `.posting-content`,
  `a.postings-btn`) against public posting DOM. URL slugs are never
  promoted into company names. Registry keyed by `detectAtsType`
  labels; unmapped boards fall through.
- `generic.ts` — og:title/`<title>`/h1, meta descriptions, longest
  paragraph ≥100 chars, salary lines from captured text, apply-like
  anchors, `<time datetime>`. Company/location stay null.
- `extract.ts` — precedence runner, usability gate (title OR
  description), deterministic confidence (strategy base + coverage,
  capped 0.95), missing-field report, content hash.

Integration (`src/scraping/`):

- `handler.ts` runs extraction after successful fetches only
  (blocked/failed skip it); extractor crashes are caught and recorded
  as EXTRACTION_INCOMPLETE, never lost.
- `evidence.ts` `persistFetchOutcome` takes an optional extraction:
  one transaction writes the attempt, the `job_extractions` row,
  normalized job fields + `activeExtractionId`, and the source
  `applyUrl`, ordered for immediate FKs and the active-extraction
  triggers. Extraction on a non-SUCCEEDED outcome throws.

## Oracle port evidence

`scripts/generate-extraction-goldens.py` runs the untouched legacy
`services/discovery/normalizer.py` (`.venv` Python 3.11) over
`tests/unit/extraction/fixtures/oracle-inputs.json` into
`oracle-goldens.json` (5 hash, 7 arrangement, 5 title cases).
`normalize.test.ts` asserts byte-exact hash and arrangement parity and
pins each deliberate invention-fix divergence with rationale.

## Bugs found by the new tests

- Shared `/g` regex `lastIndex` state made find-then-parse salary
  sequences silently miss (unit tests passed by call-order luck).
  Fixed with fresh matchers per call; adapter/generic fixtures are
  the regression net.

## For R2-E (attempt UI)

- Job cards read normalized columns; `missingFieldsJson`,
  `confidence`, and `adapter`/`adapterVersion` on `job_extractions`
  feed the completeness display; `extracted_json.provenance` explains
  each value. `EXTRACTION_INCOMPLETE` attempts carry kept artifacts
  for retry/deep-dive views.
