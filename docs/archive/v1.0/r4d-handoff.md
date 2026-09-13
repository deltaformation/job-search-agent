# R4-D Handoff — Canonical resume view model and renderers

```text
Work order: R4-D (Canonical resume view model and renderers)
Outcome: implemented — canonical view-model port (8/8 R4-B cases),
         Markdown/DOCX/HTML-PDF renderers from one model, template
         trust + lineage, artifact metadata/hashes, page-budget and
         cross-format parity checks, golden visual fixtures.
Status: accepted
Files changed:
  new: src/resumes/{viewModel,config,template,markdown,docx,pdf,checks,
       artifacts,index}.ts, src/resumes/templates/mouad_standard_v1.docx,
       scripts/build-docx-template.mjs,
       tests/unit/parity/view-model.test.ts,
       tests/unit/resumes/{view-model,render,parity,golden,
       pdf-extract}.test.ts, tests/unit/resumes/browser/pdf.test.ts,
       tests/fixtures/resumes/standard.{html,md,txt}
  mod: package.json, package-lock.json (docxtemplater/pizzip/pdf-parse),
       tests/unit/domain/purity.test.ts (resumes boundary),
       docs/product-rebuild/status.md
Migrations/data effects: none (no schema, product, or legacy code touched).
Verification performed and exact result:
  npx vitest run tests/unit/parity/view-model.test.ts → 8 passed;
  resumes suites (incl. browser PDF on macOS host) → 49 passed (49/49);
  tests/unit/resumes/browser/pdf.test.ts → 3 passed (real Chromium render);
  npx vitest run → 85 passed (85) / 579 passed (579) / 0 failed;
  npx playwright test (E2E) → 7 passed (7);
  npx tsc --noEmit → clean; npx eslint . → clean;
  node scripts/build-docx-template.mjs --check → DOCX_TEMPLATE_MATCH;
  embedded CSS verified byte-equal to the oracle .j2 (pinned by hash).
Acceptance criteria not yet proven: human review of this handoff;
  PDF visual QA (owned by R5-C document QA).
Decisions or deviations:
  - HTML is rendered by audited TS string assembly (not a template
    engine): static fragments are consts, every value is escaped with
    markupsafe fidelity, and the lineage hash covers all fragments.
  - Link hrefs are scheme-allowlisted (tel/mailto/http/https);
    javascript: URLs render as inert text — hardening over the oracle,
    which escapes but does not scheme-check.
  - config/resume.yaml converted to typed RESUME_CONFIG (no YAML read).
  - DOCX template binary is checked in; the reviewed generator script
    is its source and a test pins byte-identity.
  - Markdown/DOCX are new renderers (oracle has HTML/PDF only);
    inventory comparison strips Markdown emphasis markers.
Safety/human checkpoint: templates are presentation-only (no script,
  no external assets, CSP meta kept); renderers validate drafts only
  via the R4-C validator upstream — no approval or Tailored-transition
  logic touched; PDF page aborts all network requests.
```

## Module map

- `viewModel.ts` — pure port of `view_model.py`: month-year/dates,
  contacts, current-first ordering, role budgets, empty-header drops,
  evidence-qualified skills (via R4-C), education rows, plain-text
  projection, canonical baseline draft.
- `config.ts` — typed presentation budgets (5/3/14 bullets, 3 roles,
  2 pages, variants off).
- `template.ts` — trusted HTML template (verbatim reviewed CSS),
  allow-list registry, lineage hash, markupsafe-fidelity escaping,
  scheme-allowlisted hrefs, `renderHtml`.
- `markdown.ts` — pure Markdown projection, canonical section order.
- `docx.ts` — docxtemplater render over the checked-in template plus
  paragraph extraction for parity checks.
- `pdf.ts` — Playwright `page.pdf` (network-aborted page,
  `preferCSSPageSize`) plus pdf-parse text/page extraction.
- `checks.ts` — page budget, 300-char minimum, HTML body fragments,
  claim inventory, normalized containment assertions.
- `artifacts.ts` — UUID job-key validation, `v{version}_{hash8}`
  stems, SHA-256 + `ArtifactMetadata` records for the MD/DOCX/PDF set.

## Test inventory (54 new)

- `tests/unit/parity/view-model.test.ts` (8): all R4-B view-model
  cases byte-equal, builder output validated against the renderer
  contract.
- `tests/unit/resumes/view-model.test.ts` (8): date/contact edges,
  ordering, role split, malformed-input emptiness, baseline stability.
- `tests/unit/resumes/render.test.ts` (18): registry trust, lineage,
  CSS pin, M8 security ports (no-script/CSP/autoescape), Markdown
  order, DOCX round-trip + template byte-identity + hash pin,
  artifact metadata + hostile-input rejection, budgets, checks.
- `tests/unit/resumes/parity.test.ts` (3): claim inventory and HTML
  fragments contained in Markdown/DOCX/plain-text.
- `tests/unit/resumes/golden.test.ts` (3): pinned HTML/Markdown/text
  fixtures (`tests/fixtures/resumes/`).
- `tests/unit/resumes/pdf-extract.test.ts` (2): hand-built 2-page PDF
  extraction + corrupt-bytes rejection.
- `tests/unit/resumes/browser/pdf.test.ts` (3): real Chromium render
  (1 page, extractable text, hostile-text containment) —
  environment-blocked here, see above.
- Purity guard extended: pure subset, no forbidden imports,
  browser/fs confinement.

## For R4-E

Compose `buildViewModel` → `renderMarkdown`/`renderDocx`/
`renderHtml`+`renderPdf` → checks → `describeArtifacts`, then publish
bytes with the arch section 3 temp-file protocol and persist rows.
`templateInfo()` plus `docxTemplateHash()` supply the
template/version/hash lineage columns; `RESUME_CONFIG` supplies
policy values. Validate every draft with the R4-C validator before
rendering (the oracle's `render_resume_to_html` precondition).
