# Release 1.2 — Acceptance Criteria and Evidence

Canonical pass conditions and evidence ledger for [builder work orders](work-orders-v1.2.md). All original A1–J4/additional and U1–U16 IDs are preserved. Audit finding IDs F1–F10 are distinct from work-order F acceptance IDs F1–F6; always name the namespace in a handoff.

## Evidence rules

- Before coding, read the assigned order's criteria and relevant journey steps. Code presence, isolated tests, runtime evidence and human acceptance are separate observations.
- Every accepted cell needs revision/tree context, exact command/test, outcome and evidence path. Missing checks remain open; never infer completion from test counts or a historical implemented label.
- Use isolated synthetic profiles/DB/files. Automated consent/status simulations run only in fixtures. Human sign-off is not replaceable by an agent acting on live data.
- Expected-red specifications must use eligible real fixture states and fail at the documented target assertion. Prove setup independently and record failure location. Before final release, target behavior must pass normally: no skip, swallowed setup error, or residual expected failure used as acceptance.
- Use the narrowest meaningful checks first, then repository-required suites for changed layers. Browser/worker checkpoints happen at D/G, not only I. Visual/template acceptance requires actual rendered files; a parseable structural PDF proves structure only.
- Report controlled blockage, failed item and crashed worker accurately. Any aggregate percentage requires an explicit denominator/weighting; unit-test counts do not measure usable workflow completion.

## Early checkpoints

- **D exit (after C+D):** create/populate an independent secondary profile entirely through settings, explicitly generate v1, change profile/guidance and generate v2 through the real local worker with the deterministic provider seam. Capture trace/screenshots, request/attempt IDs, exact input values and output artifact IDs. Do not substitute SQL/terminal operations for user steps.
- **G exit (after D+G):** enter/test/save/activate provider configuration through settings, then demonstrate first and second guided generations. Test transport stubs support repeatable automation; record credential-available live-provider results separately. Missing credentials leave the live result open without blocking the isolated smoke.
- Repair failed core checkpoints before optional polish. These checks supplement the complete I journey; they do not certify unrelated later features.

## Per-order criteria

<a id="wo-12-a"></a>

### WO-1.2-A

- A1: each F1–F10 has an owner in the evidence ledger.
- A2: exact approved/latest/application pointer semantics and legacy queue policy are recorded.
- A3: context links pass and baseline revision/runtime/check results are captured.
- A4: shared-fact identity across profiles is explicitly designed, preserving existing approved IDs and snapshot membership; ordinary reuse of the same career history must not fail due to the current single-owner fact model.

<a id="wo-12-b"></a>

### WO-1.2-B

- B1: profiles A/B can store different masters and identical shared career facts without collisions or cross-contamination.
- B2: wrong-profile IDs, traversal and symlinks fail.
- B3: malformed input and injected import/activation/crash failures never replace the active source incorrectly.
- B4: fresh, upgraded, multi-profile, missing-source and restore/reset fixtures preserve old hashes, fact references, reviews and counts.
- B5: updating each new field round-trips without inventing defaults or altering historical snapshots.
- B6: copying a source profile preserves evidence lineage/verification, creates no fact-ID collision, requires explicit target activation, and remains independent after either profile is edited. Unapproved source facts do not become approved through copying.

<a id="wo-12-c"></a>

### WO-1.2-C

- C1: enter/edit every requested field through controls and inspect its persisted value.
- C2: upload, preview, activate and export two profiles without changing the default.
- C3: invalid input highlights a meaningful field and preserves entered content.
- C4: full master preview includes links, languages, credentials and other stored sections; any output omission is explained.
- C5: keyboard use, labels and settings scrolling work at the agreed viewports.
- C6: create a secondary profile from the default, adjust positioning, explicitly activate it, then select it for tailoring without changing the default, editing JSON manually or using a terminal. Also verify the Start empty → upload → activate path. Unready options explain the missing prerequisite and link to the exact profile setup.

<a id="wo-12-d"></a>

### WO-1.2-D

- D1: clipping produces zero tailoring calls before explicit Start.
- D2: PM v1 → Senior PM v2 carries the correct profile, narrative, keywords, directive and revision note end-to-end.
- D3: awaiting-review and approved parents both permit advertised new-version behavior; decline queues nothing.
- D4: previous artifact bytes, approvals and applied records survive.
- D5: duplicate clicks, concurrent clients, rejection during work, stale input, retry and worker crash never attach unauthorized/stale output.
- D6: an unsupported KPI directive produces a gap/explanation and no invented metric.
- D7: approving a newer version obeys all four board-state cases in the builder release contract.
- D8: an empty secondary profile fails preflight without enqueuing; a profile becoming unavailable after enqueue is handled without killing the worker, and a subsequent valid job completes. Complete the C+D early checkpoint above with browser/worker evidence; unit tests alone do not close D2/D3.
- D9: prove cancel-without-submit leaves review/history unchanged; new versions from approved/declined parents preserve parent decisions; approval-selection backfill uses evidence; old-process upgrade exclusion is enforceable against the old binary; new analyses with both linkage fields omitted are rejected; request/attempt/analysis publication preserves append-only history. Amend the technical contract if its current proposal cannot satisfy these cases.

<a id="wo-12-e"></a>

### WO-1.2-E

- E1: curated fixtures for PM, Senior PM, sales/business and engineering produce relevant phrases and exclude audited false positives.
- E2: rich sources provide 5–10; sparse/empty sources report fewer accurately.
- E3: no padded boilerplate, forged selections or unsupported metric/technology claims.
- E4: source excerpts and support state are accessible before generation.
- E5: changing the profile updates support and retains editable coaching without leaking another job's state.

<a id="wo-12-f"></a>

### WO-1.2-F

- F1: selecting v1/v2 changes input history and audit correctly.
- F2: master/version preview remains correct after switching defaults and updating master content.
- F3: actual valid artifacts render/open as labeled, with escaped hostile text and no arbitrary path access.
- F4: no duplicate download groups; keyboard version selection/focus works.
- F5: reuse-settings preserves known inputs and truthfully reports missing legacy history.
- F6: prior generated template appearance and cross-format content parity are proven with real rendered fixtures.

<a id="wo-12-g"></a>

### WO-1.2-G

Required reported regression: [provider selection/key management](feedback-g-provider-settings.md), mapped to G1–G6. Evidence remains open until the saved-versus-active flow and actual worker generation are proven.

- G1: typing a different model tests that model without saving.
- G2: invalid/auth/rate-limit/timeout replies are actionable and secret-free.
- G3: key save/remove survives restart, preserves unrelated settings and remains absent from database, logs, client payloads and backups.
- G4: web and worker identify the same active configuration after activation.
- G5: mocked tests plus a credential-available human-authorized live smoke result are separately recorded for each provider; missing credentials are not a fabricated pass.
- G6: first-time setup, activation/restart where required, generation and a second guided version are demonstrated without terminal configuration or database edits. Use a stubbed external provider for repeatable automation and record credential-available live evidence separately. Complete the G early checkpoint above before optional polish.

<a id="wo-12-h"></a>

### WO-1.2-H

- H1: screenshots at 1280×800, 1440×900, 1920×1080 and 3840×2160 CSS pixels show core three-column focus and readable spacing; record physical scaling separately.
- H2: 390×844 remains usable with access to every column and settings action.
- H3: keyboard, pointer drag and horizontal scrolling reach Interviewed/Rejected without accidental mutations.
- H4: header follows actual profile readiness.
- H5: reduced motion and focus management hold; badge thresholds update across midnight without a manual reload.

<a id="wo-12-i"></a>

### WO-1.2-I

- I1: every required journey step and fault case has revision-tied evidence.
- I2: no placeholder files stand in for document rendering.
- I3: all automated gates pass with no unexplained exclusions.
- I4: performance and manual acceptance are passed or explicitly open with a named cause; no automatic downgrade to “out of scope.”

#### Integrated and performance protocol

- Run the User journey below with isolated migrated SQLite, supervised worker, a deterministic provider test seam and valid generated artifacts. Use real routes and UI; do not satisfy assertions by directly updating the finished states in the test database. Keep synthetic approval/application simulations separate from the user's live data and manual sign-off.
- Cover fresh install, upgrade from v1.1 with queued/running/failed work and multiple profiles, backup/restore, source-publication failure and simultaneous generation/review. Verify historical hashes, fact memberships and recorded application associations before/after migration.
- Run focused tests, full unit/integration suites including browser renderer coverage, typecheck, lint, production build and product E2E. Record actual counts; do not pin success to the old 951 number. Fix deterministic ordering flakes at their cause, not by skipping or rerunning until green.
- Record performance using 0/10/50/100-card fixtures and the same query-count budget. Measure production-build board navigation, drawer open, filters, profile switch and version selection on Apple Silicon with at least 50 populated cards. Include hardware, Node/browser versions, CSS viewport, cold/warm conditions, run count and raw trace locations.
- Measure actual Event Timing/INP where supported, not just server timings or click handler duration. For a repeatable scripted sample use five warm sessions with a fixed interaction sequence, report each session and p75, target p75 ≤100ms, and list long tasks >50ms. Report cold navigation separately. This is a local release benchmark, not a population-level field INP claim.
- Record visual/keyboard review results for all H viewports and master/version previews. Arrange a human acceptance walkthrough of the intended workflow; do not assert subjective user satisfaction from automation.


<a id="wo-12-j"></a>

### WO-1.2-J

- J1: all required evidence-ledger cells are closed before Complete.
- J2: docs, runtime and UI agree on lifecycle, format support and active configuration.
- J3: rollback/restore instructions are verified against the final schema and artifacts.
- J4: human acceptance result is recorded accurately.

## User journey

Use synthetic data in automated runs. The user executes the equivalent real-data sign-off; no agent may impersonate that consent.

| Step | Action | Observable result |
|---|---|---|
| U1 | Create PM and Senior PM profiles with shared career facts and different positioning | All requested fields saved; independent active masters; no fact collision |
| U2 | Preview/export both, switch default, return to first profile | Correct profile/version throughout; previews and source downloads stay consistent |
| U3 | Clip a rich PM JD | New card and extracted JD; zero automatic resume generation |
| U4 | Select PM profile, inspect keyword evidence and choose supported terms | 5–10 relevant phrases where justified; no Go/go-to-market false positive |
| U5 | Add B2B SaaS emphasis and an unsupported KPI request; Generate | One request with bound snapshots; unsupported request remains a gap |
| U6 | Inspect v1 and all document previews | Exact inputs and outcomes visible; formats agree on claims; new-tab actions work as labeled |
| U7 | Decline v1 with a note | Declined history recorded; no queued work; job remains New |
| U8 | Reuse v1 settings, choose Senior PM and edit guidance; Generate v2 | New immutable version using new profile; v1 files and decisions unchanged |
| U9 | Approve v2 explicitly in the synthetic UI test / personally in real use | Exact reviewed version selected; New → Tailored only by that action |
| U10 | Create and approve v3 from Tailored | v2 approval survives; v3 awaits review until explicit approval; board remains Tailored |
| U11 | Manually record an application, then create a later draft | Recorded application version/time remains unchanged; draft cannot imply reapplication |
| U12 | Repeat clicks, retry after failure, change default while queued, reject during work | Deduplication, input binding and fencing behave as specified without lost history |
| U13 | Change model field and test before saving, then activate saved config | Diagnostic matches entered model; configured/tested/active states are truthful |
| U14 | Use core board at laptop and 4K CSS sizes and reach the final two columns | Readable three-column focus, accessible side navigation and correct profile label |
| U15 | Create a secondary profile from an existing reviewed profile, then edit and activate it | Independent usable profile with preserved evidence lineage; source unchanged; no terminal workaround |
| U16 | Attempt generation with an empty profile, then use a ready profile | Actionable preflight error and no futile queue item; worker remains healthy and valid work succeeds |

## Evidence ledger

Implementation agents must add revision, commands/test names, result and artifact paths to Evidence. “Tests pass” without the relevant scenario is insufficient.

| Audit gap / requirement | Owner | Required gates | Status | Evidence |
|---|---|---|---|---|
| F1: guidance before generation | A, D, I | D1; U3–U5 | Open | A-design proven (WO-1.2-A): R-ADR-015, lifecycle-contracts §§3/5/9, D1 pins in tests/unit/acceptance-v1.2/explicit-generation.test.ts (2 expected-fail). D1 behavior proven (WO-1.2-D, baseline bd7a227): pins flipped — tests/unit/acceptance-v1.2/explicit-generation.test.ts 3/3 passing (clip queues zero TAILOR; later extraction after failed scrape queues nothing); route/worker checkpoint on an isolated root (clip route → 0 TAILOR rows, job NEW/READY). U3–U5/I gates still open. |
| F2: re-tailor/revision/approval lifecycle | D, I | D2–D9; U7–U12 | Open | D slice substantially proven (WO-1.2-D, baseline bd7a227, uncommitted tree): migration 0007 (generation_requests + immutable bindings/no-delete + linkage triggers + legacy-TAILOR refusal); explicit requestGeneration command with preflight (tests/unit/server/tailoring.test.ts); v2 worker with claim-minted attempts, reopen/terminalize recovery, and binding/hash fences (tests/unit/tailoring/handler.test.ts 16/16, requests.test.ts, directives.test.ts — 7 tests incl. 3 checkpoint-found pattern/boundary fixes); revision/decline + move/select approval (tests/unit/server/review.test.ts 14/14); D9 DB guards (legacy refusal, linkage rejection, binding freeze in tests/unit/db/constraints-immutable.test.ts); D2/D3 pins flipped (cross-profile-v2.test.ts 3/3). Route/worker checkpoint (isolated APP_DATA_ROOT, real supervised worker, deterministic no-key provider seam): clip → profiles via settings routes → empty-profile 422 with zero enqueue (D8) → INITIAL request 83888cbf…/item 2a0cffb6… → attempt 6dce2a9e… published analysis a4eb6c8e… (provider "command", 5 fallback gaps + directive-0 D6 gap) then FAILED/RENDER_FAILED at Chromium launch (environmental headless-shell SEGV — same sandbox blocker as B/C browser suites); item requeued, job/request RUNNING, worker drained cleanly on SIGTERM (D5). Full non-browser suite 140 files / 1045 pass + 2 F-owned expected-fail; typecheck 0 errors; lint clean; context 17/17. Open: version-attach/artifact legs (v1→v2, D4 bytes, approval E2E) and all browser-click legs — blocked on the sandbox browser SEGV, not on code; no screenshots/traces capturable here. I/U gates still open. |
| F3: complete profiles and independent masters | B, C, D, I | B1–B6; C1–C6; D8; U1–U2, U15–U16 | Open | B1–B6 proven (WO-1.2-B, baseline bd7a227): migration 0006 (candidate_sources + provenance_json, additive) with post-migration backfill; B1/B3/B5 in tests/unit/routes/profile-sources.test.ts; B2 pins flipped in tests/unit/acceptance-v1.2/profile-source-access.test.ts; B3/B6 in tests/unit/server/profile-copy.test.ts; B4 upgrade in tests/unit/db/migrate-0006.test.ts + backup/restore/reset in tests/unit/server/backup-sources.test.ts — 5 files / 26 passed; suite 130 files / 986 pass (+6 expected-fail, 17 skipped; 2 browser suites fail environmentally at Chromium launch, unrelated); typecheck/lint clean; context 17/17. C implementation complete (WO-1.2-C, baseline bd7a227): version history/read/activate/parse/export routes + workflow chain (tests/unit/routes/profile-versions.test.ts, profile-workflow.test.ts — 12 passed), Markdown renderer + shipped example (tests/unit/domain/master-preview.test.ts — 4 passed), settings UI with per-profile workspaces (tests/unit/components/settings/ — 36 passed), E2E walkthrough spec committed (tests/e2e/settings-profiles.spec.ts — 7 tests, loads via --list). C1–C6 all UNPROVEN: no browser engine launches and no loopback bind is permitted in this sandbox (see C execution record); unit/route/component evidence does not substitute. Browser-leg update 2026-09-18 (e2e validation on this Mac, Chromium): `npx playwright test` 21/21 green incl. all 7 settings-profiles tests — C1 structured entry + activation, C2 example/upload/activate + JSON/Markdown exports, C3 invalid-input highlighting (JSON + structured), C5 keyboard/viewport, C6 secondary/copy/default-flip. Required two product fixes (server: omit undefined employmentId in evidence canonicalization; client: recover 422 issue bodies in MasterOnboarding) with committed unit regression tests; remaining changes were spec locator/expectation corrections. D/I gates still open. |
| F4: saved narrative/preferences reach generation | B, D | D2, D6; immutable steering snapshot | Open | D slice proven (WO-1.2-D, baseline bd7a227): frozen SteeringSnapshotV1 + canonical keywords + directives + revision note on every request, hash-verified by the worker (requests.test.ts hash sensitivity; handler tamper/cross-job refusal tests); checkpoint request row carried keywords ["roadmap prioritization","stakeholder management"] and the exact directive text through the real worker to the published analysis. Display of recorded guidance stays with F (F7 pins). |
| F5: relevant keyword phrases and coaching | E, I | E1–E5; U4–U6 | Open | E slice substantially proven (WO-1.2-E, baseline bd7a227, uncommitted tree): E1 passed — deterministic extractor (curated tech+business lexicon, hyphen term-boundaries, longest-span nesting, frequency→JD-order rank, unpadded backfill) with the 6-fixture manifest green (tests/unit/domain/atsKeywords.test.ts 16/16: F5 go-to-market/Go, engineering Go positive control, REST nesting, excerpt/offset determinism). E2 passed — rich sources 5–10, sparse/empty honest (checkpoint sweep pm-rich 10, senior-pm 10, sales-business 5, engineering 10, sparse 0, empty 0; zero missing/zero leaked). E3 passed — forged (non-JD) selections fail closed 422 with zero generation_requests rows (tests/unit/server/tailoring.test.ts E3 case + checkpoint real-route forged vs valid/provider-unavailable ordering). E4 passed non-browser — every suggestion carries excerpt+offset (unit/route/checkpoint allHaveExcerpts); GET keyword-support evaluates supported/uncertain/gap vs APPROVED facts per profile with policy version (tests/unit/routes/keyword-support.test.ts 5/5); coaching outcomes (5 term states + per-directive map, keyword-coaching/v1) projected in the review view (resume-review route + ResumeReview component tests). E5 passed non-browser — profile switch re-evaluates (route test + checkpoint PM→SPM supported→gap/uncertain flip); drawer retains chips/directives on profile change, count/Clear, job-switch reset (3 new CardDrawer tests, 23/23). Gates: focused E 8 files / 87 passed; full non-browser 145 files / 1124 passed + 2 F-owned expected-fail, 0 failures; typecheck 0 errors; lint clean; context 17/17. Open: every browser-click leg (drawer chips/badges/Clear/profile clicks, coaching render in browser) — sandbox Chromium launch failure, same blocker as B/C/D/G; U4–U6/I gates still open. Scratch driver /tmp/e-checkpoint/drive.mjs + report.json (not committed); live .env.local untouched by E. |
| F6: profile-correct previews and standard styling | C, F | C4; F2–F6; valid rendered artifacts | Open | F slice substantially proven (WO-1.2-F, baseline bd7a227, uncommitted tree): F2 passed non-browser — master card follows the guidance selection with pinned `/master-resume?profile=&version=` links (resolver survives default switches + master updates; tests/unit/server/master-preview.test.ts 4/4); history rows carry bound-master links + frozen generation-time names + distinct Latest/Selected badges (tests/unit/server/board.test.ts lineage case). F3 passed non-browser — DOCX canonical content preview route (escaped/sandboxed/labeled + original-file link), bytes inline/download with CSP/nosniff, traversal rejected (tests/unit/routes/resume-artifacts.test.ts 4/4 with real rendered DOCX bytes incl. hostile text). F4 passed non-browser — single preview group in the drill-down, drawer duplicates removed (asserted absent), keyboard-native selection + focus move on selection (component tests). F6 passed non-browser except the PDF-render leg — claim inventory parity across Markdown/DOCX/plain/HTML (parity.test.ts), byte-pinned standard template (golden.test.ts), escaping/budgets/lineage (render.test.ts), and loud RENDER_FAILED on dropped resume text (orchestrate.test.ts — overflow reported, never silent). Open: PDF-render parity leg + every browser-open/click leg (sandbox Chromium launch failure, same blocker as B/C/D/E/G); C4/U6/I gates still open. |
| F7: original guidance and decline semantics | D, F | D3; F1, F5; U6–U8 | Open | D persistence slice proven (WO-1.2-D, baseline bd7a227): request row carries exact submitted guidance incl. legacy-absent "not recorded" rule (tests/unit/acceptance-v1.2/guidance-history.test.ts guards passing); decline queues nothing and freezes the version (review.test.ts decline matrix). F display slice proven (WO-1.2-F, uncommitted tree): both F7 pins flipped to passing — review exposes the exact recorded guidance (profile/version/keywords/directives/revision note) in stored canonical order, invariant under later default/profile mutations; legacy rows still expose null (not-recorded rule strengthened). F1 passed non-browser — v1/v2 selection swaps guidance/audit (review route + drawer component tests). F5 passed non-browser — reuse prefills profile/keywords/directives only, with honest legacy/unavailable-profile explanations (drawer component tests). Open: browser-click legs (sandbox Chromium launch failure); U6–U8/I gates still open. |
| F8: keys and proposed-model diagnostics | G, I | G1–G6; U13; early setup/generation checkpoint | Open | G slice substantially proven (WO-1.2-G, baseline bd7a227, uncommitted tree): G1 passed — testProviderDraft tests the exact entered provider/model/transient-key without saving (tests/unit/server/settings.test.ts draft/fallback/transient cases; tests/unit/routes/settings-providers.test.ts real-route draft with file-untouched assert; SettingsModal draft-send + invalidation tests; checkpoint fetchedModels ["google/gemma-4-26b-a4b-it:free","nvidia/nemotron-3.5-lightning:free"] via the real ai-test route). G2 passed — reason-coded actionable errors for missing-key/auth/rate-limit/timeout/502/invalid-request/bad-response (unit matrix incl. simulated 502 "unchanged" wording; route 502 case; spawn-failure unit + worker evidence below), all secret-free. G3 passed — masked write-only add/replace (0600, atomic, unrelated preserved), blank-retain no-op, explicit remove with absent no-op (unit + route); secrets absent from responses (fingerprint-only), SQLite (byte-scan test), and backups (planted-.env archive test); restart persistence via file→env agreement (checkpoint reopen + post-restart snapshot). G4 passed — saved/active/worker distinguished ("Configured" label; Saved badge; restart banner cleared only on agreement); checkpoint settings-final active=saved=openrouter, workerMatch=true, worker-status.json openrouter/reported-models/key-set. G5 partial — mocked success+failure recorded for all three providers (openrouter/google/meta stubbed pings); credential-available live smoke NOT run (no authorized credentials; the one synthetic 401 during repro is non-evidence). G6 partial — setup→save→activate→generate checkpoint via real routes + supervised worker + deterministic stub: v1 INITIAL (PM, request ccee7511…/item 89f8cc0c…) and v2 INITIAL (SPM, request 497f81bc…/item 3af22a94…) both published worker analyses with exact bound guidance (canonical keywords, verbatim directives, directive-0 D6 gap on v1) after the worker verified openrouter/reported-models/key (3/3 stub calls); spawn failure exercised separately (ENOENT detail + boot warning, exit 0, recovery run proceeded). Open: version-attach/artifact legs (all three stub runs FAILED/RENDER_FAILED at Chromium launch — same sandbox SEGV/blocker as B/C/D, not code) and all browser-click legs (E2E spec tests/e2e/settings-providers.spec.ts committed, 4 tests load-verified via --list, unexecuted here). Browser-leg update 2026-09-18 (same 21/21 run on this Mac, Chromium): all 4 settings-providers tests green — G1 exact-draft/transient-key test + result invalidation, G3 write-only save/blank-retain/explicit-remove, G4 Configured labeling + OpenRouter save/restart banner incl. reopen persistence. Scratch driver /tmp/g-checkpoint/drive.mjs + report.json + stub-calls.jsonl + worker logs (not committed); live .env.local untouched (372B, mtime intact). U13/I gates still open. |
| F9: board/header responsiveness and truthfulness | H, I | H1–H5; U14 | Open | — |
| F10: measurable release acceptance | A, I, J | A1–A4; I1–I4; J1–J4 | Open | A1–A4 proven (WO-1.2-A, baseline bd7a227): §7 owners verified; pointers/legacy policy in lifecycle-contracts §§7–9 + R-ADR-018/019; context 14/14, suite 126 files / 960 pass + 8 isolated pins, typecheck/lint clean; fact reuse in R-ADR-020. I/J gates still open. |
| Preserve fact/approval/manual application boundary | B, D, I | Adversarial + migration + synthetic lifecycle tests | Open | B slice proven (WO-1.2-B): adversarial wrong-profile/traversal/symlink rejection (B2 pins flipped); migration preserves facts/hashes/reviews/counts with legacy file as unassigned evidence (B4); copy keeps source verification/lineage and unapproved facts unapproved (B6). D slice proven (WO-1.2-D, baseline bd7a227): unsupported directives record explicit gaps and never reach claims (directives.test.ts + handler D6 test + worker checkpoint directive-0); stale/superseded/rejected runs fence without attaching output (handler.test.ts); human-only approval/decline preserved (no agent approval path; routes require actor human); app never fills ATS forms (unchanged boundary). I slice still open. |
| v1.1 extra templates and arbitrary format/theme import | A, J | Explicit builder §2/F dispositions carried into release docs | Planned deferral | This plan; no support claim |


The existing evidence entries above were transferred without converting historical test counts into current acceptance. A's correction handoff is in [the execution log](execution-log-v1.2.md); independently verify relevant prerequisites before accepting downstream behavior.
