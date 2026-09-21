# Release 1.2 Acceptance Fixtures (WO-1.2-A)

Deterministic synthetic inputs for the v1.2 acceptance specs. All values
are invented (`@example.com` addresses); nothing here is verified career
memory. Fixtures conform to the **current** schemas so they validate
today; `WO-1.2-B` extends profile coverage (languages, keywords, notes,
links) without breaking these files.

## Profiles

- `pm-profile.json` — Product Manager track (`candidate-import/v1`).
- `spm-profile.json` — Senior Product Manager track, different
  positioning (headline, summary, targets, skills) over the same
  synthetic person.

Shared career history uses **identical statement text with distinct
fact ids** (`pm-fact-*` vs `spm-fact-*`), per R-ADR-020: reuse is an
explicit copy with provenance, never a silently shared row. `WO-1.2-B`
(B1) proves both profiles store these without collisions or
cross-contamination.

## Job descriptions (`jd/`)

| File | Role | Expectation |
|---|---|---|
| `pm-rich.txt` | Product Manager | 5–10 phrases incl. product strategy, roadmap prioritization, customer discovery, B2B SaaS, stakeholder management, go-to-market; `Go` must not match the go-to-market prefix (F5 reproduction, verbatim) |
| `senior-pm.txt` | Senior PM, Platform | 5–10 phrases; same business core plus platform strategy; no `Go` false positive |
| `sales-business.txt` | Account Executive | 5–10 intact business phrases (pipeline generation, enterprise accounts, discovery calls, forecast accuracy); no `Go` |
| `engineering.txt` | Backend Engineer | Positive control: `Go` IS a genuine language requirement here, alongside Rust, Kubernetes, REST APIs, CI/CD |
| `sparse.txt` | Office assistant | Honest small set (≤3); never padded with boilerplate |
| `empty.txt` | — | Zero suggestions |

`keywords.json` (`v1.2-jd-fixtures/v1`) is the machine-readable
manifest: per-case file, min/max suggestion counts, `mustInclude` /
`mustExclude` phrases (case-insensitive). `WO-1.2-E` (E1–E5) consumes
it; matching semantics stay with the extractor tests.

## Documents (`documents.ts`)

- DOCX fixtures render the PM profile through the trusted product
  renderer (`renderDocx` + checked-in template) and are verified with
  `extractDocxParagraphs`.
- PDF fixtures are minimal but structurally complete single-page files
  verified with the product parser (`extractPdfText`): catalog, pages,
  font, content stream, xref table, trailer.
- Markdown fixtures render through `renderMarkdown` where needed.

Validity is proven by `tests/unit/v1.2-fixtures/documents.test.ts` —
no placeholder bytes anywhere in this directory.

Scope note (WO-1.2-A correction pass): the minimal PDF is a
*structural* fixture — it proves bytes are a parseable document with
expected text. It is not a standard-template visual acceptance result;
template appearance and cross-format parity stay with F/I evidence on
real rendered artifacts.
