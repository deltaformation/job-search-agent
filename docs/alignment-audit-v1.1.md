# Release 1.1 — Analysis and Alignment Audit

Audit date: 2026-09-14 UTC / 2026-09-13 Toronto. Baseline: `bd7a227`, package `1.1.0`, plus the existing working tree. Audit status: complete; product alignment: **needs-review**.

## Verdict

The gap is substantive. The original request describes a user-led preparation experience: choose a career profile, inspect useful JD keywords, add coaching, generate a resume, then inspect and compare immutable versions. The implementation adds many of those controls around the previous automatic preparation workflow without completing the connections between them.

The strongest evidence is the re-tailoring loop: the UI offers “Re-tailor Resume,” its endpoint rejects awaiting-review and approved resumes, and the suggested revision route does not carry the new profile, selected keywords, or directives. Profile narratives are saved but do not enter generation. These are functional alignment failures, not simply layout preferences.

There is substantial working infrastructure worth retaining: multiple profile records and immutable versions, guidance hashing, provider adapters, version cards, evidence review, constant-count board queries, and the simplified Kanban shell. A focused alignment release is appropriate; a wholesale rebuild is not justified by this audit.

## Scope and evidence limits

Primary intent evidence is the user's supplied quotes from Steps 231, 235, 241, 251, and 265. The supplied introduction says Step 240, but its actual transition quote is labeled 241; this audit uses the supplied labels without independently authenticating the transcript. No missing assistant replies were supplied. Therefore, “yes that's perfect,” “good,” and numbered approvals cannot establish exactly what unseen proposals the user accepted.

Read: PROJECT, status, architecture, operations, decisions, the complete roadmap and work-order record, relevant UI, server services, queue/worker/provider contracts, resume renderers, and tests. Findings below distinguish direct code evidence, synthetic reproduction, interpretation, and unproven acceptance.

Existing uncommitted health-dashboard work was present before the audit: `app/page.tsx`, `components/AppHeader.tsx`, `components/PlatformStatus.tsx`, header tests, `app/health/`, page tests, and Record 12 in the execution log. It is preserved. The hard-coded header profile claim also exists in HEAD; it is not attributed to the later health change.

No live candidate database was inspected, no user resumes were approved or revised, and no paid provider calls were made. This is a repository and contract audit with isolated automated verification, not a live visual acceptance session or an external API certification. UI geometry deductions are identified as deductions; browser preview behavior remains unproven.

## Intent → plan → implementation matrix

“Partial” means some requested behavior exists but the complete user journey does not. “Unproven” does not mean broken.

| User intent / roadmap commitment | Delivered evidence | Assessment |
|---|---|---|
| Step 231: controls inside Tailoring & Resume | Profile selector, keyword chips, three starters and textarea in drawer | Implemented location and controls |
| Steps 231/251: choose guidance before tailoring | Successful extraction still immediately queues unguided tailoring | Misaligned sequence; see F1 |
| Step 231: choose the most appropriate profile | Selector resolves that profile's active fact version | Partial: initial guided selection works when eligible; repeat flow fails |
| Step 231: several complete career profiles | Named profiles, default flag, preferences and immutable fact versions | Partial: form omits several requested fields; see F3 |
| Authorization, work mode, sponsorship, relocation, experience, salary | Form fields exist | Implemented storage/UI; not automatically consumed as tailoring context |
| Personal information and categorized skills | Available through structured resume JSON, not dedicated profile editing | Partial usability |
| Target titles and target locations | Supported in stored structures; existing preferences preserved on edits | No form controls to manage them |
| Keywords, languages, profile notes, personal links | Not represented as requested first-class profile fields in the inspected strict import/profile forms | Missing |
| Executive narrative influences career positioning | Editable and saved on profile root | Disconnected from tailoring; see F4 |
| Upload/update master with format guidance, preview, download | JSON upload, re-sync, JSON download; drawer has separate preview page | Partial; global source file and no settings parsed preview/schema guide |
| Roadmap: JSON/YAML/Markdown guidance, upload or paste, parsed preview | Only JSON file input and JSON parse path | Roadmap scope dropped by WO-G |
| Step 235: explain/preserve master appearance | Standard trusted output templates retained | Preserves app template; does not import an uploaded document's design |
| Steps 231/251: 5, ideally 10, relevant selectable JD keywords | Technology lexicon plus repeated-token fallback, capped at 10 | Partial; reproduced quality/count failure, F5 |
| Step 231: three editable guidance examples | Exact requested themes implemented as appended starter text | Implemented for eligible guided calls |
| Step 251: master at top, new-tab preview, helpful empty state | Present | Partial: preview always resolves current default; see F6 |
| Step 251: v1/v2 cards with associated profile | Compact version cards and lineage-derived profile names | Implemented display; cross-profile creation remains blocked |
| Step 251: “Decline” version outcome | Uses “Revision requested”; no decline-only version action | Semantic gap: revision automatically queues work |
| Step 251: select version to inspect requirements and changes | Existing review audit is selected by version | Implemented core drill-down |
| Step 251: inspect selected keywords | Review shows derived Top-5 keyword audit, not original selected input | Missing input-history display; see F7 |
| Step 251: previews with no redundant downloads | Version-card downloads removed; review downloads retained | Partial and explicitly narrowed in WO-I |
| Step 231: direct Google/Meta keys and model entry | Direct adapters, model fields, environment-file keys | Backend implemented; no key-entry field in settings |
| Roadmap: test model before saving | Test posts only provider, uses configured model | Does not validate the unsaved model field; F8 |
| Step 231: local models not needed now | No new local-model setup | Aligned; local worker/command transport is not a local LLM feature |
| Steps 251/265: Kanban only, wider cards, navigation near logo, profile near settings | Implemented in board/header | Largely aligned; responsiveness remains unproven |
| Step 265: core three columns with side navigation across screen sizes | Fixed 360/400px columns and horizontal overflow | Partial approximation; F9 |
| Step 251: keep current theme; de-scoped viewer | No new theme switcher or embedded rich editor | Aligned |
| Roadmap: three trusted templates | Registry contains standard template only | Unimplemented plan item; authorization beyond supplied quotes unclear |
| Roadmap: 7/14/30-day applied badges | Client-derived badges exist | Implemented; mount-time clock limitation recorded in WO-I |
| Roadmap: measured INP ≤100ms and full release gate | Query fixture and non-browser tests; hardware gate explicitly outstanding | Release completion overstated; F10 |

## Findings and their causes

### F1 — Generation starts before the user's decisions (high)

Step 251 explicitly says “before tailoring a resume” and describes an empty state prompting profile/keyword selection. `src/scraping/evidence.ts:419` still calls `requestTailoring` immediately after extraction, without guidance. `components/board/CardDrawer.tsx:584` disables the start action during PENDING/RUNNING. With prerequisites available, the first run can finish before the user has selected anything.

The older R-ADR-010 explicitly requires automatic preparation. The roadmap added an interactive panel but never resolved this conflict. WO-H retained the legacy unguided path. This is a design transition omission spanning plan and implementation, not an individual button defect.

Recommended contract: clipping prepares the JD and suggestions; the user explicitly starts resume generation. This recommendation follows the supplied quotes but requires recording the superseding architecture decision during implementation. It does not alter human approval or introduce another board column.

### F2 — “Re-tailor Resume” cannot complete its advertised workflow (high)

The button is rendered for existing versions at `components/board/CardDrawer.tsx:689`. `src/server/tailoring.ts:140` returns 409 for AWAITING_REVIEW and APPROVED, directing the user to request revision.

That fallback is incomplete: `RequestRevisionInput` (`src/server/review.ts:79`) has no profile/keyword/directive fields. The enqueue call at line 620 passes only job, extraction and parent version. `requestRevisionRun` in `src/tailoring/enqueue.ts` constructs an unguided payload. The worker resolves the current default when no profile is supplied. Consequently revision does not preserve or apply the chosen guidance and can use a different default profile. The revision note is stored in review history, but is not forwarded in the inspected worker/provider input path.

For approved versions, the offered workaround is a dead end: review controls only permit revisions for an active AWAITING_REVIEW version (`src/server/review.ts:1116`). The underlying review state rules also reject invalid transitions.

WO-H acknowledges the 409 as a deviation, but does not prove the replacement route fulfills the requirement. Preserve prior artifacts and approvals while adding an explicit new-draft action carrying complete version-bound guidance. Define how a new draft relates to an already approved artifact without silently revoking approval or changing application status.

### F3 — Career profiles are metadata cards around a global master file (high)

WO-G reduced roadmap §2.2 to slug/display name, selected preferences, executive narrative, and a JSON upload block. It omitted personal editing, target-title/location controls, keywords, languages, notes, source-format help, and parsed preview. These omissions are visible in `components/settings/SettingsModal.tsx:1021` and the strict profile/import shapes in `src/domain/candidate.ts:55` and `:165`.

The backend supports an optional target profile, but the UI uploads `{ content }` only (`SettingsModal.tsx:519`). `app/api/settings/master-resume/route.ts:36` reads one shared file; POST replaces that same file before importing into the target/default profile. The database retains separate immutable versions, so this is not evidence that every profile is overwritten. It is evidence that source-document management is global and cannot reliably represent one master per career profile through the present UI.

There is also a consistency risk: file replacement happens before re-sync succeeds. A schema-valid upload that fails import/activation can leave the shared downloadable file different from the active database version. Invalid-schema rejection tests do not establish rollback after a later import failure.

Implement profile-targeted source management, an explicit selected-profile upload action, structured field editing and a parsed preview before activation. Keep verified facts distinct from preferences, and never treat uploaded prose as automatic permission to approve a generated resume.

### F4 — Saved narrative and preferences do not reach generation (high)

`workPreferences` and `executiveNarrative` are saved and returned by profile settings. The generation path resolves immutable candidate versions (`src/server/candidates.ts:514`), adapts snapshot content (`src/tailoring/adapt.ts:15`), and passes profile ID, keyword selections and directives (`src/tailoring/handler.ts:281`). Neither saved root narrative nor preferences enter this path or `TailoringInputV1` (`src/tailoring/contract.ts:26`).

A user can change “Executive Narrative,” save successfully, and reasonably expect different positioning; that particular field cannot affect the provider input. Snapshot the relevant career-positioning metadata as bounded steering, hash it with the generation inputs, and distinguish advisory preferences from approved facts. Work authorization and salary must not become fabricated resume claims or automatic application answers.

### F5 — “Top ATS keywords” favors engineering vocabulary and can misread business terms (high)

`src/domain/atsKeywords.ts` first ranks a curated technology lexicon, then backfills single tokens only when repeated at least twice. It is deterministic frequency matching, not a demonstrated ranking of hiring importance. It does not connect suggestions to candidate support before selection. Existing evidence safeguards still constrain rendered claims; this finding does not establish unsupported claims reaching resumes.

Reproduced using this synthetic input, without an API or candidate data:

> Own product strategy, roadmap prioritization, customer discovery, B2B SaaS growth, stakeholder management, pricing, experimentation, KPI measurement and go-to-market launches. Use Jira and Figma.

Actual output: `Figma`, `Go`, `Jira`. “Go” matched the prefix of “go-to-market”; the relevant business phrases were omitted. This example has enough substantive concepts for at least five suggestions but returns three.

Use phrase-level JD evidence and role-diverse relevance tests. Display supporting JD text and candidate support/gap status, making unsupported terms unavailable as resume claims. Do not fabricate extra keywords to satisfy a count on genuinely sparse JDs. Separate the user's selected inputs from the later evidence-qualified coverage audit.

### F6 — Master preview does not represent the selected profile or original appearance (medium)

`components/board/CardDrawer.tsx:718` selects the default profile for the master card. `/master-resume` uses `getDefaultProfile` and its current active version (`app/master-resume/page.tsx:24`), independently of the drawer selector and selected resume's historical lineage. Changing defaults changes the preview target. It is a readable custom page, not the canonical output-template rendering or the uploaded original document; it also does not render every payload category, such as credentials.

The supplied theme question lacks the assistant's response, so exact source-theme import cannot be treated as an agreed implementation requirement. The roadmap instead promised preserving the application's trusted templates. Those templates remain. The actual contract needs to distinguish source document, parsed master content, and generated output styling, and use profile/version-specific preview URLs.

Version artifact links open a new tab and serve the stored bytes by ID. That proves routing intent, not a functioning visual DOCX preview. No DOCX-to-browser preview conversion exists in that route. Browser behavior for DOCX/Markdown remains an acceptance item. WO-I retained a second Preview/Download set inside `ResumeReview.tsx:246`, contrary to the broader removal request; the claim that review requires download controls was not justified by the supplied user quotes.

### F7 — Version review omits the actual user-selected inputs (medium)

`ResumeReviewView` (`src/server/review.ts:716`) exposes requirements, gaps, claims and derived `topKeywords`, but no original selected keywords or directives. `ResumeReview.tsx:426` labels its section “Top 5 ATS keywords & match audit.” Guidance is carried in queue input and hashed into analysis history, but hash binding does not make it visible or explainable in the version detail view.

Version review should show the exact selected profile version, selections, directives and relevant positioning snapshot, then explain used / omitted / unsupported outcomes. Current guidance controls are a draft for another run, not a historical record of the selected version.

Also clarify “Decline”: the user's example names that outcome; the delivered action is “Request revision,” which immediately queues another run. A decline-only decision and a new-version request have different consequences. Any correction must preserve append-only review history.

### F8 — Provider configuration is incomplete as a settings journey (medium)

Google/Meta adapters and free-form model fields exist. API keys are read from `.env.local`; settings has no key-entry field and labels key presence “Connected” before a successful diagnostic (`SettingsModal.tsx:730`). The quote requires direct API-key support but does not explicitly demand a UI key field, so external-file setup is an ergonomic shortfall rather than an unequivocal breach of that literal sentence.

The roadmap's test-before-save promise is more definite: `testAi` (`SettingsModal.tsx:415`) submits only `{ provider }`, and `pingProvider` (`src/server/settings.ts:423`) tests the configured primary model. The newly typed model is not tested. Saving instructs the user to restart. A green diagnostic can therefore refer to a different model than the field being edited.

Test the proposed configuration, label key presence separately from verified connectivity, and make activation/restart state clear. Provider adapters are supported by mocked tests; live Google/Meta model behavior is not certified here. The user-provided Meta endpoint and Bearer auth are implemented, but those two facts alone do not establish its full request schema or a valid default model.

### F9 — Board improvements are real, but responsiveness is only approximated (medium)

The view toggle and breadcrumbs are removed, cards are wider, and navigation/profile placement broadly follows the quotes. `BoardColumn.tsx:43` uses fixed 360px columns, 400px at 2xl. `Board.tsx:467` provides horizontal overflow. At a true 3840 CSS-pixel viewport all five 400px columns fit; fixed widths do not enforce a three-column focus. At roughly 1280 CSS pixels they naturally show about three. Physical 4K resolution does not establish CSS viewport width because display scaling matters.

No explicit column-navigation buttons or drag-to-pan handler were found in the board component. Card drag and horizontal scrolling are present; their ergonomics should be evaluated independently. The active-profile pill is hard-coded to “Mouad Atfi · Profile Active” and hidden below xl (`AppHeader.tsx:143`), so it is not evidence of the actual selected/default profile's readiness.

Validate agreed CSS viewport sizes, keyboard navigation, touchpad/drag behavior and profile truthfulness. The user's “ideally” leaves room for a flexible layout; do not claim five visible columns on a large screen is categorically forbidden.

### F10 — Release closure replaced requirement acceptance with narrower checks (high)

Roadmap §4 includes browser INP verification. WO-J explicitly instructs marking the roadmap Complete while its verification list contains only type, lint, non-browser tests and context checks. Earlier handoffs still leave 13-inch/4K layout, live guided worker flow, browser upload and provider checks unproven. WO-J's “None for cutover scope” does not discharge those release-wide obligations.

The roadmap's three-template registry has no corresponding implementation work order. The standard-only allowlist is visible in `src/resumes/template.ts:244`. This is an unclosed planning promise, not a reason to prioritize two extra templates: the supplied quotes do not establish that the user requested those alternatives, and expressly favor preserving the current theme.

Phase labels also drift: roadmap §2.1 is interactive tailoring, §2.2 profiles, §2.3 providers, §2.4 templates; work orders label E schema §2.1, F providers §2.2, G settings §2.3, H interactive §2.4. Mapping by section number alone conceals omissions.

Architecture still describes a single profile and automatic local-agent preparation; newer ADRs modify some but not all of those assumptions. Status “Complete” is consequently not a reliable substitute for the requirements matrix. Preserve the history and append a corrective acceptance status during the alignment work.

## What the AI currently does

The provider returns requirements, evidence mappings, rationale and questions (`ResumeProposalV1`, `src/tailoring/contract.ts:78`). The resume draft is composed by deterministic ranking and summary logic (`src/tailoring/draft.ts`). Guidance can affect upstream mappings, but the schema does not accept arbitrary newly rewritten resume bullets from the model.

This explains why “actionable coaching” may feel weaker than expected. It is not itself proof that the user's quotes demanded unrestricted rewriting. Specify observable coaching outcomes—such as prioritizing an approved B2B SaaS achievement and explaining an unsupported KPI request—before expanding the proposal contract. Truthfulness safeguards should be retained.

## Why the drift happened

1. **Intent became component presence.** “Choose before generation” became “add a panel”; “complete profile” became selected form fields; “inspect selected keywords” became reuse of an existing Top-5 audit.
2. **Old state transitions remained authoritative.** The new UI advertises new-version behavior while the existing retry/review contracts disallow it or discard its inputs.
3. **Work orders narrowed the roadmap without closing removed items.** WO-G omitted profile and preview requirements; WO-I narrowed download removal; no order owned the extra templates.
4. **Tests validated the narrower contracts.** Passing shape, render and hash tests do not prove the sequential user story, keyword relevance, visual preview or model configuration experience.
5. **Outstanding acceptance lost its release-level owner.** Deferred evidence was carried in individual handoffs, then metadata cutover was reported as completion.

## Prioritized alignment work and acceptance gates

These are proposed follow-up tasks, not changes executed by this audit.

| Order | Bounded correction | Required acceptance evidence |
|---|---|---|
| 1 | Reconcile automatic preparation with explicit user start; repair guided new-version/revision flow | Clip a synthetic JD: no resume generation before Start. Choose profile A/keywords/notes for v1, choose B/new guidance for v2. Worker input and version history retain exact selections; v1 bytes and approval history remain unchanged. Repeated clicks/retries do not duplicate work. |
| 2 | Complete profile authoring and connect positioning to generation | Create and edit every requested field; upload/preview/download A and B independently without changing the global default. Snapshot relevant steering. Show that narrative changes affect input while unsupported facts are rejected. Failed import leaves active source/version consistent. |
| 3 | Replace weak keyword suggestions and connect coaching | Product Manager, Senior PM, sales/business and engineering JDs yield evidence-backed phrases; reproduce and eliminate the Go/go-to-market error. Show 5–10 where the source supports them, an honest smaller set otherwise; explain gaps and selected-term outcomes. |
| 4 | Finish resume hierarchy and input audit | Master preview targets the chosen profile/version. Switching version cards changes both original guidance and resulting audit. Clarify decline versus revision. Verify actual new-tab PDF/DOCX/Markdown behavior with valid files; remove redundant controls consistently. |
| 5 | Finish settings configuration and board ergonomics | Diagnostic tests the entered model, distinguishes configured/tested/active states; keys remain protected. Verify measured CSS viewports, horizontal navigation, actual profile state and keyboard access. |
| 6 | Reopen and close release acceptance honestly | Trace every roadmap item to implemented evidence or an explicit deferral. Decide whether extra templates are wanted. Record browser performance on target hardware and end-to-end user journey results before claiming full alignment. |

The original quotes support retaining the current visual theme and the five-column manual application workflow. Do not add discovery, application autofill, scheduling, local-model setup, or new board states as remedies for these gaps.

## Verification performed

- Focused audit run: `npx vitest run tests/unit/domain/atsKeywords.test.ts tests/unit/tailoring/enqueue.test.ts tests/unit/tailoring/revision.test.ts tests/unit/server/tailoring.test.ts tests/unit/routes/profiles.test.ts tests/unit/components/board/CardDrawer.test.tsx tests/unit/components/settings/SettingsModal.test.tsx tests/unit/server/board-perf.test.ts` — **8 files, 71 tests passed**, exit 0.
- Full non-browser run: `npx vitest run --exclude '**/browser/**'` — **121 files, 951 tests passed**, exit 0. This includes the existing uncommitted health tests; it is not the exact historical 945-test cutover result.
- `node scripts/check-project-context.mjs` — **11 required files / 11 active entrypoints consistent**, before report creation. Rechecked after documentation changes.
- Synthetic keyword reproduction: imported the actual extractor with Node and supplied the quoted synthetic JD — exact result **Figma, Go, Jira**.
- Query-budget coverage checks 0/10/50/100 jobs, compares 10 and 100, and caps query count at 10. It supports bounded query count, not constant runtime cost or browser INP.
- Existing E2E fixtures were inspected: the review scenario uses placeholder DOCX/PDF bytes, so those fixtures cannot certify real document rendering. Existing board E2E tests do not cover the complete multi-profile guided-generation journey.
- No product code changed, so type/lint/build were not repeated for this documentation-only audit. Historical green checks are identified in the execution log; they are not presented as new audit runs. Browser/E2E, live provider, real-document visual QA and Apple Silicon INP were not run.

## Completion interpretation

The audit is complete. Release 1.1 contains implemented infrastructure and passing regression tests, but it is **partially aligned with the user's intended workflow**. The highest-priority correction is the entire choose → generate → inspect → change guidance → generate next version loop. Acceptance should be based on that loop working with realistic career profiles and job descriptions, not the number of controls or tests present.
