# WO-POST-J-SALARY — Capture compensation already present in the JD

**Status:** planned; user-reported defect, not yet reproduced against retained clipping evidence.
**Placement:** after WO-1.2-J by default; independent follow-up, not an added v1.2 closure gate. If I exposes the same issue as a blocker of an existing criterion, record that dependency explicitly rather than silently changing release scope. No release number assigned yet.
**Outcome:** a clipped job with an explicit salary shows that compensation in the board/drawer after extraction, without starting resume generation, configuring an AI provider, or manually editing the job.

## Report and expected result

User report: Quo, **Senior Product Manager, Accounts, Billing, & Compliance**, location **CAN**, remote, posted **2026-09-11**, pipeline **New**. The description contains compensation but Facts shows **Salary / Compensation: Unknown**. Original URL/job ID and retained HTML were not supplied; do not invent them.

Exact relevant user-provided text:

> Compensation The annual base salary range for this position in Canada is $166,000 - $196,000 CAD, plus equity and benefits. This range is designed to align with market rates in areas where we are actively recruiting across the US and Canada. The range displayed reflects the target for new hire salaries, and within this range, individual pay is determined by your skills and experience, as well as relevant education. Your recruiter can share more and answer questions about the specific salary range during the hiring process. Salary is just one component of Quo’s total compensation package. Your total rewards package will include equity, extensive medical coverage, a monthly lifestyle stipend, and a flexible PTO policy.

The pasted JD was one long paragraph; this passage appeared after the role and qualifications, well beyond character 500.

Expected normalized annual base range: **CAD 166,000–196,000**, stored as `salaryCurrency: CAD`, `salaryMinMinor: 16600000`, `salaryMaxMinor: 19600000`. Preserve the source compensation sentence and its annual/base meaning. Equity and benefits are additional, unpriced compensation; never add guessed amounts to the range. The nearby US reference must not override the explicit Canada/CAD range.

## Read and inspect

Follow AGENTS.md and required repository context; inspect the current tree and preserve unrelated work. Relevant entrypoints verified during planning:

- `src/extraction/normalize.ts`: `findSalaryLine`, `parseSalaryLine`.
- `src/extraction/extract.ts`, `generic.ts`, `jsonld.ts`, and site adapters: strategy selection, description fallback, provenance.
- `src/server/clip.ts`, `src/scraping/evidence.ts`: intake and publication.
- `src/db/schema/jobs.ts`, relevant extraction schema/read models: persisted salary and active evidence.
- `src/tailoring/salaryFallback.ts`, `components/board/salaryFormat.ts`, `CardDrawer.tsx`: later enhancement versus immediate display.
- Existing extraction, clip, salary-formatting and salary-fallback tests.

**Hypothesis, not confirmed root cause:** `findSalaryLine` currently finds a line containing money but returns only its first 500 characters. For a flattened JD, those characters can precede the salary entirely, so `parseSalaryLine` sees no money. Inspect the actual clip/extraction path and demonstrate the failure before choosing the fix. Do not assume that changing one regex repairs persistence and display.

## Bounded implementation

1. Add a failing regression using the quoted passage after more than 500 characters of clearly labeled synthetic role text, with no newlines. Also test the same content as normal HTML paragraphs. Use retained original evidence if available; distinguish it from synthetic fixtures.
2. Extract a bounded compensation-relevant span around the actual evidence before truncation. Preserve source wording/provenance; respect existing whole-input limits. Do not scan arbitrarily large input or concatenate unrelated monetary figures into a range.
3. Preserve valid structured salary data and documented strategy precedence. Add or repair the winning description's fallback only where needed. Avoid a broad extraction architecture rewrite or mandatory model call.
4. Publish salary through normal extraction persistence/read models into the Facts panel and board. Keep ambiguous compensation as informative raw text with unknown normalized fields; do not infer currency from location or annualize hourly/monthly rates.
5. Provide and verify a bounded recovery path for an already-clipped affected job using existing re-extraction/retry behavior where possible. Prefer retained evidence without a network fetch; inspect available actions first. If none exists, document the smallest explicit reprocess action needed before implementing it. Repair must respect active-extraction fencing, be repeat-safe, and preserve job identity, notes, pipeline state, resume/artifact history and approvals. Do not bulk rewrite live jobs or regenerate resumes.

**Excluded:** compensation benchmarking, currency conversion, inferred pay, new provider infrastructure, new general-purpose import system, changes to candidate salary preferences, resume lifecycle redesign, automatic live-data repair. Prefer existing columns; justify any unavoidable migration against the current schema before adding one.

## Acceptance and verification

| ID | Required evidence |
|---|---|
| SAL1 | Flattened and paragraph-form Quo regression both yield CAD 16600000–19600000 minor units with the compensation source text retained. Compensation beyond character 500 and near the supported input limit is covered. |
| SAL2 | Normal clip/extraction/persistence/read flow shows the range in Facts and board after reload. Job remains New; no generation request or tailoring/provider call is made. Parser-only tests are insufficient. |
| SAL3 | Explicit CAD wins over the adjacent US mention; dash/spacing variants and existing structured-salary fixtures remain correct. Conflicting regional/currency ranges are not merged into one fabricated range. |
| SAL4 | Hourly/monthly rates are retained without invented annual values. Absent salary stays unknown; unrelated prices, revenue, equity counts and benefits amounts do not become base salary. Ambiguous dollar currency remains unknown unless source evidence disambiguates it. |
| SAL5 | Reprocessing an affected existing synthetic job repairs salary and is repeat-safe; stale extraction cannot overwrite newer data. Job identity, notes, pipeline state, resume versions, artifact hashes and approval/application history remain unchanged. |
| SAL6 | A real browser walkthrough on isolated data proves the initial Unknown → repaired salary display and reload persistence. Record any unavailable browser evidence as unproven. |

Run the new focused regression first, then relevant extraction/clip/persistence/formatting integration tests and repository-required checks. Include bounded-input behavior and existing extraction goldens; do not silently regenerate expected outputs to accept regressions. Record exact commands/results and fixture provenance. No live job lookup is required to reproduce the supplied textual case.

Append the actual implementation prompt and official AGENTS handoff to the active execution log (currently `execution-log-v1.2.md`). Report SAL1–SAL6 individually as passed/failed/unproven, root cause, recovery procedure, files changed, data effects, and unresolved evidence. Update this order's status and the known-defect note only from observed results. Stop after this order; a document marked planned is not a product fix.
