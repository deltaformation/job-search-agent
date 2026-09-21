# Release 1.3 — Builder work orders

**Status:** in progress; A–H handoffs recorded (G/H proven 2026-09-18, e2e 21/21 on a browser Mac the same day). WO-1.3-I machine legs proven 2026-09-19 (I2/I3/I4/I6/I7 and U1–U17/U19/U20 PASS; I1/I5/I9 and U18 PARTIAL); I8 browser/PDF BLOCKED in this sandbox — release stays open.
**Sequence:** A → B → C → D → E → F → S2-A → S2-B → S2-C → S2-D → S2-CP-A → S2-CP-B → S2-CP-C → user checkpoint / downstream reconciliation → G → H → I.
**Target:** board → /jobs/[id]/tailor → Review Data → Tailor Resume → Generate → Review & Approve.

## 1. Required contracts

| Source | Read for |
|---|---|
| [Technical contracts](tailoring-contracts-v1.3.md) §§1–3 | Existing integration seams, state ownership, exact Zod schemas and canonical hashing |
| [Migration 0008 DDL](contracts/v1.3-0008.sql) and [Drizzle mirror](contracts/v1.3-drizzle.md) | All columns, checks, ownership FKs, indexes and triggers |
| [Technical contracts](tailoring-contracts-v1.3.md) §4 | Endpoint/status/envelope table, ETag/CAS, save/submit/retry/review transactions |
| [Technical contracts](tailoring-contracts-v1.3.md) §5 | Every mockup control mapped to queries, mutations or local presentation state |
| [Technical contracts](tailoring-contracts-v1.3.md) §§6–8 | Worker fences, progress/timing/errors, assessment, diff limits, upgrade/cutover |
| [Acceptance ledger](acceptance-v1.3.md) | HTTP, SQL, error and user-journey assertions |
| app/mockup/** | Verified layout/interaction reference; production components must use real read models |
| ADR-015,017,018,019 and latest [handoffs](execution-log-v1.2.md) | Explicit generation, immutable guidance, separate version pointers, revision/decline |

Follow AGENTS.md and required repository context. Before edits inspect git status and dependency outputs; preserve unrelated changes. Only implement the assigned order. Append the prompt and official handoff to execution-log-v1.2.md; record evidence in the acceptance ledger. Do not mark criteria PASS from code presence or expected-failure tests.

## Step 2 insertion — authority and sequencing (2026-09-17)

The user authorized the additional orders below between F and G. Do not restart A–F or renumber G–I. Existing acceptance evidence remains historical evidence, not proof of the new behavior. Read [Step 2 scope amendment](step2-scope-v1.3.md) with the assigned order; it takes precedence for the specifically listed conflicts with D/E and the technical contracts. S2-A must freeze exact implementation contracts before backend construction.

G–I implementation remains held. The S2-CP-C planning task must reconcile its
downstream contracts and acceptance criteria before G starts. Do not infer
permission to cut over the drawer or implement the feedback module. [Future
roadmap](roadmap-future.md) records feedback collection separately.

## Step 2 correction — authority and sequencing (2026-09-18)

The post-S2-D audit found that the shipped flow preserved bytes and queue
invariants but blurred AI proposal text with verified evidence, blocked direct
user edits, omitted priority-to-suggestion linkage, exposed ineligible roles,
offered two competing Step 2 exits, and did not prove the real provider/PDF
journey. The user authorized [the correction scope](step2-correction-scope-v1.3.md)
and made one controlling product decision: deliberate user edits are allowed,
preserved and labeled as user edits; lack of machine evidence does not block
them. AI proposals and user edits must never be presented as verified facts.

Execute S2-CP-A, S2-CP-B and S2-CP-C sequentially with one MAX agent. Do not
delegate, parallelize these orders, or start G. Each order must read the previous
handoff and stop at its own boundary. Existing S2D PASS rows document the old
target only and do not satisfy the correction criteria.

## 2. Release invariants

- One production flow; legacy drawer review is removed in H after parity.
- GET/navigation never creates a workspace, request, review or pipeline transition.
- Workspace saves use revision CAS; job commands separately use jobs.row_version.
- Generate freezes selected profile version, JD/extraction, focus, approved evidence anchors and master projection. Worker never reads current workspace.
- Same operation ID + same submission bytes replays; changed bytes returns 409; a different operation while busy returns 409. Retry names the failed attempt and never reads new guidance.
- Machine-verified claims require approved bound facts or allowlisted derivations. Source anchors on user-authored or user-accepted AI text provide lineage, not proof of the prose.
- New-format content records server-derived provenance: verified source, user-accepted AI suggestion, or user edit. User edits are non-blocking and preserved verbatim; non-verified categories never inflate evidence coverage.
- Every AI positioning/experience suggestion links to exact persisted JD priorities and valid source anchors. Eligible target roles are derived server-side and enforced in UI, save and generation paths.
- Step 2 has one primary exit: Generate resume. A separate navigation-only Continue action is forbidden.
- Attempts have stable started_at. Progress records real boundaries under a live lease; no timer-driven stages/percentages.
- Version content/artifacts and original master baseline are immutable. Only human approval sets selected_resume_version_id and moves NEW→TAILORED.
- Applied/Interviewed history stays bound to applications.resume_version_id; newer drafts never replace the selected approved PDF until approved.
- assessment/1 uses explicit eligible sets/counts; unavailable baselines are not_assessed. No composite ATS/Overall score.
- Settings/provider configuration and salary extraction remain existing scopes; F owns the elapsed/progress follow-up.

## 3. Work allocation

| Order | Depends on | Primary ownership | Acceptance |
|---|---|---|---|
| A | Current tree and prototype | Domain/API schemas, contract tests, baseline/ADRs | A1–A6 |
| B | A | 0008, Drizzle/repositories, read/save API, backup/restore | B1–B8 |
| C | B | Board launch, route/shell, Properties/Notes | C1–C8 |
| D | C | Step 1 real JD, deterministic recommendation adapter | D1–D7 |
| E | D | Step 2 draft controls, v3 request dispatch | E1–E9 |
| F | E | Worker progress, lease strengthening, retry API/UI | F1–F10 |
| S2-A | F | MAX: preparation/editor contracts and evaluation fixtures | S2A1–S2A4 |
| S2-B | S2-A | MAX: intake profile binding, preparation persistence/worker/APIs | S2B1–S2B6 |
| S2-C | S2-B | HIGH: prepared-plan editor and intake diagnostics UI | S2C1–S2C5 |
| S2-D | S2-B, S2-C | MAX: edited-content validation, generation and checkpoint | S2D1–S2D5 |
| S2-CP-A | S2-D + audit | MAX: correction contracts, ADR and adversarial pins | S2CPA1–S2CPA5 |
| S2-CP-B | S2-CP-A | MAX: provenance/priority/eligibility backend and migration | S2CPB1–S2CPB6 |
| S2-CP-C | S2-CP-B | MAX: corrected editor, real-flow verification and G–I reconciliation | S2CPC1–S2CPC6 |
| G | S2-CP-C + user checkpoint + downstream reconciliation | Assessment, historical diff, review commands/UI | G1–G12 |
| H | C–G parity | Legacy cutover and board selected-PDF action | H1–H8 |
| I | A–H | Integrated acceptance, operations/release closure | I1–I9, U1–U20 |

B owned migration 0008; S2-B exclusively owns new Step 2 runtime migrations under the S2-A specification. Never rewrite applied migrations. E owns request hashing/dispatch, F owns execution and G owns publication assessment/review; coordinate changes in shared services. This sequence does not authorize parallel agents or multiple writers.

## 4. Orders

### WO-1.3-A — Contracts and baseline

**Deliver:**
1. Implement the pure Zod schemas in technical §3, including semantic refinements. Define v3 payload/hash functions without changing v2 hash fixtures.
2. Inventory every prototype action against technical §5. Preserve Step 1 full-JD and Step 2 controls; record gaps in implementation, not new UX panels.
3. Record current database migration list, query-count baselines, provider/worker/review blockers and exact relevant v1.2 handoffs.
4. Add ADRs for workspace CAS, immutable input extension, progress, assessment and route cutover. Amend conflicting prior planning statements explicitly.
5. Add executable contract specifications for A1–A6 and future B–G behavior. Expected failures must fail at the target assertion with valid setup; never leave the standard suite red unintentionally.

**Inspect:** schemas, 0007 queue guard, server/tailoring.ts, server/review.ts, queue/leases.ts, tailoring/handler.ts, actual mockup components/tests.
**Boundary:** domain schemas/hash utilities/tests/docs only; no migration application, provider work or UI cutover.
**Exit:** A1–A6; concrete contracts ready for B.

### WO-1.3-B — Persistence and workspace APIs

**Deliver:**
1. Implement 0008 from the checked SQL specification and exact Drizzle mirror. Export new tables; retain existing FK/immutability guards. No existing-row backfill.
2. Implement repository methods: readWorkspace, saveWorkspaceCAS, insertRequestInputs, appendProgressFenced, insertAssessment. Repositories accept trusted service clocks/lease tuples only.
3. Implement GET/PUT workspace and paginated versions APIs per technical §4. GET on absent workspace returns 200/null + revision 0 ETag without INSERT.
4. Implement transaction W and bounded read queries. Pin owned profile/extraction; source/JSON corruption returns typed safe failures.
5. Update backup/restore/reset and migration tests. Upgrade verifies quiescence; resume schema changes never rewrite reviewed content.

**Boundary:** no generation dispatch, worker emission, assessment calculator or production card route switch. Persistence helpers can be exercised with isolated fixtures.
**Exit:** B1–B8; schemas/services available for C/E/F/G.

### WO-1.3-C — Board and workflow shell

**Deliver:**
1. Build /jobs/[id]/tailor and production-owned components; use installed Next.js documentation for route conventions.
2. Give cards a common compact title/company/status shape; status top-right, secondary metadata in Properties. Activation/keyboard opens route, drag and nested actions do not.
3. Implement header, four-step indicator, Back, Properties and Notes using existing detail/notes APIs. Preserve safe external URL behavior.
4. Implement technical §5 resolver and URL step/version hints. No automatic state mutations; explicitly requested history remains inspectable.
5. Preserve the legacy entry path until H. Do not expose fake functionality for unimplemented steps; unavailable action is disabled with a compact state.

**Exit:** C1–C8. No duplicate tailoring command implementation.

### WO-1.3-D — Step 1 and recommendations

**Deliver:**
1. Render actual retained JD in the verified Step 1 layout. Metadata comes from persisted extraction; absent/ambiguous values remain Unknown.
2. Implement GET recommendations with exact profileVersionId/extractionId, canonical byte-range phrase IDs, occurrence counts, support facts, role IDs, themes and preset per technical §3.1.
3. Reuse ATS extraction/support services; no provider call. Recompute on profile change, validate freshness, return 409 for obsolete active binding.
4. Feed Step 2 its preset/readiness without adding a mandatory Step 1 recommendation essay. Profile/master previews resolve exact IDs.
5. Missing provider permits reviewing/editing; Generate alone enforces readiness. No queue work on Continue.

**Exit:** D1–D7. **Product checkpoint:** board, shell, Properties/Notes and actual input data.

### WO-1.3-E — Step 2 and explicit submission

**Deliver:**
1. Map all Step 2 controls to FocusV1: cloud/inspector local state; selection/theme/summary/mappings/guidance durable W saves.
2. Implement500ms autosave with one in-flight save, revision chaining, visible conflict recovery and unsaved-input retention. Cancel summary/modal edits produces zero writes.
3. Implement G at POST generations. Refactor existing requestGeneration/requestRevision to accept exact immutable focus and caller operation ID. Do not delegate to the current default-profile fallback.
4. Dispatch v3 queue payload; canonical hashes include input extension; store existing keyword/directive fields as verified projections. Implement the provider v2 envelope and compiler steering adapter in technical §3.2; identical replay never requeues failed work.
5. Validate role-specific evidence and source membership; gaps disabled for insertion. Revision review+request+queue+CAS is all-or-nothing.
6. Persist enough generation identity for reload and safe uncertain-response replay.

**Exit:** E1–E9. No model call from web route.

### WO-1.3-F — Worker progress and recovery

**Deliver:**
1. Support v3 request verification alongside unchanged v2 reader. Add real stage emission through appendProgressFenced.
2. Strengthen renew/complete/publication/failure predicates with live expiry and exact attempt. Run one renewal timer during awaited work; stop/abort on lease loss.
3. Implement request progress/retry APIs, transaction R, safe Failure mapping and progress UI. Preserve automatic retry bounds/history.
4. Handle already-published and analysis-only crash recovery without duplicate analysis/version/provider call. Cached recovery emits accurate source-tagged stages.
5. Implement persisted-start elapsed time, clock resync, poll-disconnect/lease-expiry distinctions, safe diagnostics and verified Settings actions.
6. Mark the elapsed/progress follow-up as owned by F with criterion cross-references; do not maintain another implementation.

**Exit:** F1–F10. **Product checkpoint:** saved focus→real worker→result/failure/retry.

### WO-1.3-S2-A — Freeze preparation and editable-plan contracts (MAX)

**Read:** Step 2 amendment; technical §§2–6; canonical intake/queue/profile/workspace schemas; current intake service, recommendation builder, focus compiler and F handoff.
**Deliver:**
1. Author `docs/contracts/v1.3-step2-contracts.md`: exact versioned Zod inputs/outputs, DDL/Drizzle specification, endpoint/status table, CAS/idempotency rules, UI operation mapping, worker state transitions and size/query budgets. Reserve the next unused migration after inspecting the tree; do not edit 0008.
2. Define intake-time immutable profile/evidence/master binding, per-job preparation identity, extraction linkage, deduplication, missing-profile recovery, existing-job explicit preparation and old request readers. Specify the amendment to current active-profile freshness checks: later settings edits alone do not invalidate the captured version; evidence revocation/invalid ownership still blocks. Never use this exception to waive JD freshness or invalid evidence.
3. Define plan, priority, positioning and bullet identities; ordered Add/Replace/Exclude/edit operations; exact-text validation digest; persisted validation results and race handling. Resolve free-text claim verification and approved-wording chronology explicitly against architecture §7; valid fact IDs or an LLM verdict alone cannot authorize arbitrary claims. Use conservative Needs evidence outcomes when support cannot be established. No hidden master mutation.
4. Create fixed evaluation fixtures for multiword priorities, required vs preferred, a NetSuite gap, equivalent supported wording, fabricated metrics/technology/responsibility and cross-employer contamination. Include Lime-like transferable experience plus synthetic close-match and sparse-evidence cases. Record expected ranked concepts and prohibited claims; no new feedback module.
5. Specify provider planning schema/prompt and grounded rewrite policy using existing provider adapters; no KeyBERT/Python/Transformers.js dependency in this increment. Record targeted ADR/contract amendments as planned, not implemented.

**Boundary:** contracts, fixtures and contract tests only; no runtime migration, provider invocation or UI changes. Every unresolved contract must be named; S2-B cannot start with unresolved ownership, claim-validation or retry semantics.
**Exit:** S2A1–S2A4. Stop after S2-A.

### WO-1.3-S2-B — Intake-bound preparation backend (MAX)

**Read:** S2-A output, Step 2 amendment, intake/scrape handler and queue services, F handoff.
**Deliver:**
1. Implement approved new migration and repositories, backup/restore/reset handling and old-format readers. Pin one globally selected profile version plus evidence/master inputs at intake acceptance; never resolve the current default in a delayed worker.
2. After successful extraction, idempotently schedule distinct preparation work. Retain the clipped job when prerequisites or preparation fail. Preparation writes no generation request, resume version, approval or application. Support clip and pasted batch paths, source dedupe and explicit legacy-job preparation.
3. Run structured requirement/positioning/bullet proposal through existing provider orchestration, with validation, immutable accepted plan and provenance. Reuse cached accepted output after publication recovery; enforce finite retry/time/output/concurrency limits and worker lease fencing. Do not promise exactly-once remote calls after a crash before response persistence.
4. Implement plan/status/retry/recovery routes specified by S2-A. Expose safe diagnostics under intake batch read models and distinguish scrape success from preparation failure. One failed item cannot block other jobs. Reads/navigation/autosave cause no calls or queue insertion.
5. Serve bound master bullets, roles, priorities, summaries and suggestions to the editor; new defaults never rewrite old plans. Reject stale plan writes while preserving saved drafts. Retain append-only attempt and plan history.

**Boundary:** backend preparation only; no final generation dispatch on intake and no review/cutover UI.
**Exit:** S2B1–S2B6. Stop after S2-B.

### WO-1.3-S2-C — Focused Step 2 editor and batch diagnostics (HIGH)

**Read:** S2-A API/operation contracts, S2-B handoff, amendment, current Step 2/autosave and intake batch components; UI skills/guides required by AGENTS.md.
**Deliver:**
1. Replace job-local profile selector with captured profile name/version plus Preview and Edit profile. Preview uses the captured version; Edit explains future-queue effect. Global selection remains in Settings. No job-local profile mutation.
2. Show 3–5 important phrases with Supported / Related experience / Gap; reveal source/evidence and remaining requirements on demand. Do not fill sparse results with junk. Show keep-master positioning plus up to two distinct supported alternatives and a directly editable summary.
3. Show the captured master bullets per employment and 3–5 suggested bullets overall. Add by default; explicit Replace chooses one existing bullet. Use / Skip / Edit, drag/drop to eligible role, X exclusion and Undo have equivalent keyboard/button operations. Never erase master content.
4. Persist ordered draft operations, edited summary/bullets and selections through CAS autosave; retain unsaved edits on conflict. Display Needs evidence/checking states tied to exact edited text. Readiness and size/budget issues are actionable; no silent omissions or replacements.
5. Add actual preparation stages, safe failures and retry controls to `/intake/batches/[id]`; Step 2 links to its diagnostic context. Profile/provider missing, pending and failed states are honest. No fake progress or browser-triggered AI calls.

**Boundary:** consume S2-B APIs; do not redesign backend/claim rules or implement G. Preserve the four-step shell and restrained copy.
**Exit:** S2C1–S2C5. Stop after S2-C.

### WO-1.3-S2-D — Edited-plan generation integration and checkpoint (MAX)

**Read:** S2-A contracts, B/C handoffs, generation service, focus/compiler/rendering contracts, F recovery and existing G interface requirements.
**Deliver:**
1. Implement validation of exact edited text and final plan under the approved S2-A policy. Persist unsupported drafts without blessing claims. Generation blocks unresolved included text; excluded content does not become a claim. Never classify semantic support from token overlap or reference existence alone.
2. Freeze plan ID/hash, captured profile/master/evidence, selected theme, edited summary, ordered bullet operations and validation/policy versions in new generation inputs. Preserve old readers/hashes. CAS, replay and retry must never read newer draft/settings values.
3. Apply Add/Replace/Exclude consistently to canonical resume and all renderers, preserving role attribution, evidence citations and user's accepted wording. Raise actionable budget/validation issues instead of silently dropping chosen content. If content must change, return it for explicit review rather than silently rewriting user edits.
4. Verify real intake → preparation → edit/save/reload → explicit generation with isolated worker/provider fixtures, including crash/lease/CAS/security and existing-version regression. Record exact IDs/hashes; report live-provider and browser verification separately.
5. Deliver a user walkthrough checklist and a downstream impact report listing changes needed in G assessment/diff/review/freshness, H entry-point parity and I journeys. Stop for product feedback. Do not implement or broadly rewrite G–I yet; record that the next planning task must reconcile them before G starts.

**Boundary:** generation integration and Step 2 checkpoint only. Human approval and existing selected/application pointers remain unchanged. No feedback collection module.
**Exit:** S2D1–S2D5 plus user checkpoint pending. Stop after S2-D.

### WO-1.3-S2-CP-A — Correction contracts and adversarial pins (MAX)

**Read:** `AGENTS.md`; required repository context; [correction scope](step2-correction-scope-v1.3.md); S2-A contracts; S2-D handoff/evidence; current domain, policy, generation and Step 2 UI code.
**Deliver:**
1. Publish `docs/contracts/v1.3-step2-correction-contracts.md` with exact strict Zod schemas, canonical hashes, persistence/DDL and Drizzle specification, compatibility readers, endpoint/status envelopes and transaction boundaries for new plan/draft/validation/frozen-input versions. Inspect migrations and reserve the next unused number; do not edit 0008–0010.
2. Formalize server-derived segment provenance (`VERIFIED_SOURCE`, `USER_ACCEPTED_AI`, `USER_EDITED`). User edits remain generatable and verbatim. Provider/client payloads cannot declare human authorship, acceptance, evidence verdicts, scores or eligible roles. Define origin/anchor retention for edited summaries and bullets.
3. Require every AI angle/suggestion to link exact plan priority IDs and candidate anchors. Specify deterministic structural safeguards and server-derived eligible roles without claiming semantic proof. Remove the all-plan-facts summary union.
4. Specify one Generate transition: CAS flush → provenance/structural resolution → immutable freeze → idempotent submit → Step 3. Remove navigation-only Continue semantics.
5. Add expected-failure contract/adversarial tests for forged provenance, provider overclaim, user-edited unsupported wording, priority linkage, role ownership, summary-source isolation, replay/CAS and one-action UI. Add the accepted ADR and correction acceptance mappings. Tests must fail at target behavior, not setup.

**Boundary:** contracts, ADRs, fixtures and target pins only. No runtime migration, service or UI implementation. Do not change historical schemas/hashes or start G.
**Exit:** S2CPA1–S2CPA5; no unresolved normative contract before S2-CP-B. Stop after S2-CP-A.

### WO-1.3-S2-CP-B — Provenance-aware preparation and generation backend (MAX)

**Read:** S2-CP-A contracts/handoff; correction scope; current preparation, workspace, generation, compiler, renderers, queue/recovery, backup/restore and S2-D tests.
**Deliver:**
1. Implement the reserved ordered migration, Drizzle/repositories, immutability guards, backup/restore/reset and old-format readers. Never rewrite applied migrations or historical frozen inputs.
2. Upgrade preparation validation/persistence so every AI angle/suggestion carries exact priority links, valid anchors and server-derived eligible roles. Reject/ignore provider attempts to set trust fields. Preserve sparse 3–5 behavior without padding.
3. Upgrade editor save/validation services to retain immutable origin/anchors while deriving provenance from operations and exact text. User edits, including unverified metrics/technology/responsibility, remain non-blocking subject to structural/ownership/size rules and freeze verbatim as `USER_EDITED`.
4. Freeze a provenance manifest for every included segment. Untouched master text is verified source; explicitly selected untouched AI text is user-accepted AI; changed text is user edit. Neither non-verified category counts as machine-verified. Summary anchors come only from the chosen origin.
5. Enforce eligible roles and priority ownership in plan acceptance, workspace save and generation. Maintain CAS, operation replay, retry, lease and immutable-version guarantees; provider/worker never reads mutable settings or later workspace bytes.
6. Pass focused adversarial, migration, compatibility, queue/crash and renderer parity suites. Update acceptance evidence and append the mandatory handoff.

**Boundary:** backend/contracts persistence only. Do not redesign Step 2 presentation, approval, G assessment/diff, feedback collection or provider choice.
**Exit:** S2CPB1–S2CPB6. Stop after S2-CP-B.

### WO-1.3-S2-CP-C — Corrected Step 2 UX and real-flow checkpoint (MAX)

**Read:** S2-CP-A/B contracts and handoffs; correction scope; current Step2Focus/shell; actual Lime/master evaluation material; G–I contracts and S2-D impact report.
**Deliver:**
1. Show concise provenance labels for included content: Verified source, AI suggestion · accepted, and User edit. User edits never display Needs evidence or disable Generate solely for evidence. Preserve exact edited text through save/reload/generation.
2. Display the priority phrases addressed by every angle/suggestion and candidate source context on demand. Expose only server-returned eligible roles in Add/Replace/drag/keyboard controls; keep server refusal handling.
3. Replace the two Step 2 exits with one **Generate resume** action implementing flush → resolve → freeze → submit → Step 3. Preserve uncertain-response replay and CAS recovery; mount/navigation/autosave enqueue nothing.
4. Run a faithful redacted Lime JD/master fixture through intake → preparation → edit/save/reload → explicit generation with the supervised worker. Record batch, plan, attempt, request, version, artifact and provenance hashes. Add adversarial provider, user-edit, foreign-role and summary-union regressions.
5. Attempt and separately report one configured remote-provider preparation/generation and one real Chromium PDF visual check. Environmental failure is honest BLOCKED evidence, never replaced by a stub or deterministic provider.
6. Reconcile G–I and integrated journey contracts for provenance-aware assessment/diff/revision, frozen-profile eligibility and v1/v2 compatibility. Publish the walkthrough checklist and stop for user feedback; do not implement G.

**Boundary:** corrected Step 2 UI, integration verification and downstream specification only. No approval/cutover work or feedback module.
**Exit:** S2CPC1–S2CPC6 plus user checkpoint. Stop after S2-CP-C.

### WO-1.3-G — Exact-version review and approval

**Deliver:**
1. Calculate assessment/1 per technical §7 over frozen edited-plan segments and commit with version publication; no provider-owned score. Verified counts include VERIFIED_SOURCE segments only (R-ADR-026); accepted-AI/user-edited segments listed separately with provenance. Coverage derives from the frozen validation row. Legacy history remains not_assessed.
2. Extend review read model with frozen master projection, frozen edited ops/validation/origin, per-segment provenance, focus, assessment and allowedActions. Approve/decline/revise check the frozen captured profile/evidence, never the active profile. Validate exact selected version ownership.
3. Build Step 4 summary, compact measures/insights (insights cite provenance; user-edited claims never verified/gained), review gate, diff/filter, exact PDF preview and full content in the prototype structure.
4. Extract/reimplement pure diff utilities under production namespace with line/byte/work limits and full-text fallback. v2 diff carries per-line op attribution and non-color provenance markers; excluded content renders excluded.
5. Implement A/D and eligible older awaiting-version review. v2 revision reopens the v2 editor bound to the same accepted plan with operations preserved (rebind flow on drift); v1 revisions keep the v1 editor. Only submission changes parent. Approved/declined parent uses NEW_VERSION.
6. Verify NEW/TAILORED/APPLIED/INTERVIEWED approval cases, current input freshness, artifact rehash, application association and selected pointer across v1 and v2 rows.

**Exit:** G1–G12. **Product checkpoint:** complete four-step workflow before cutover.

### WO-1.3-H — Cutover and board download

**Deliver:**
1. Route all production tailoring/review entry points to the new route with exact version context across v1 and v2 rows. Entries expose identical Step 2 states (prepared, editing, blocked-with-reason, generating, failed) with deep links; pin a v1/v2 parity matrix.
2. Remove duplicate drawer tailoring/review controls/state after parity; retain normal job Properties/Notes access.
3. Batch selected approved PDF metadata into board read. Download Resume resolves that artifact ID; absent/corrupt artifact has explicit unavailable/error state, never latest-version fallback.
4. Preserve five columns, responsive board behavior, keyboard operation and query budget.
5. Remove dead production adapters after all callers migrate. Keep /mockup as reference pending I; no production imports from it.

**Exit:** H1–H8. **Product checkpoint:** production route cutover and card PDF download.

### WO-1.3-I — Integrated closure

**Deliver:**
1. Execute U1–U20 (corrected U4 capture journey; provenance-aware U5/U7/U11/U13/U18) with isolated SQLite, supervised worker and deterministic provider. Record live-provider evidence separately. Closure journeys cover edited-plan generate, blocked generation, byte-identical replay, crash recovery, and keyboard/zoom passes over the v2 editor and Generate states.
2. Run migration/restore, concurrency/crash, security (incl. forged-provenance/tampered-anchor adversarial cases), keyboard/browser/PDF and query-budget checks; report exact failures/unproven legs. Chromium launch failure stays BLOCKED, never unit-test substitute.
3. Resolve inherited v1.2 blockers that affect these journeys through an explicit owner. No silent acceptance carryover.
4. Update status/architecture/operations/ADRs/release metadata only from results. Record /mockup retain/archive decision.
5. Append official handoff and close every criterion with evidence; missing browser/PDF or core behavior keeps release open.

**Exit:** I1–I9 and U1–U20 PASS. No new feature scope.
