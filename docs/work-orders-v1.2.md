# Release 1.2 — Builder Work Orders

**Purpose:** implement the user-led profile → guidance → generation → review loop. This file owns scope, work allocation and dependencies; it is not an execution diary or proof of completion.

**State:** in progress. A, its correction and B have recorded handoffs; C is next. B reports its focused gates passing, with two browser suites failing at Chromium launch; that diagnosis has not been independently verified by the documentation pass. Validate dependency outputs before resuming. Package/release acceptance is tracked in [status](status.md) and the [acceptance ledger](acceptance-v1.2.md#evidence-ledger), not inferred from files present.

## 1. Read and execute

1. Follow the required repository context in `AGENTS.md`/`PROJECT.md`; inspect git status before editing.
2. Read §2 below, the assigned work order, its [acceptance criteria](acceptance-v1.2.md), and the latest relevant [execution record](execution-log-v1.2.md). Read only the relevant sections of [lifecycle contracts](lifecycle-contracts-v1.2.md) and ADRs for that order. Historical discussion is in [release context](release-context-v1.2.md); it is background, not mandatory reading every session.
3. Verify dependency outputs against actual code/tests. Work on one assigned order. Preserve concurrent/unrelated changes; do not infer permission to spawn agents from the dependency graph.
4. Deliver connected behavior through all layers owned by the order. Do not replace behavior with UI presence, silently weaken acceptance, or implement a later order to make an early test green.
5. Run focused verification first, then required unit/integration, type, lint and relevant browser/E2E checks. Use isolated synthetic data. A structural PDF fixture cannot prove visual output; expected-failure tests cannot count as implemented behavior. [Evidence rules](acceptance-v1.2.md#evidence-rules) apply.
6. Update proven acceptance cells and append the mandatory AGENTS handoff to [execution-log-v1.2.md](execution-log-v1.2.md). Stop after the assigned order and state next-order readiness. Do not paste prompts, reviews or test transcripts into this file.

**Authority:** user instructions and repository safety constraints govern. This file defines release behavior; the acceptance document defines observable pass conditions; lifecycle contracts/ADRs define engineering decisions. Code proves current behavior, not whether an unmet requirement can be discarded. Resolve contradictions explicitly before dependent implementation; record the correction and align the affected documents. Never use a historical handoff to override current scope.

**Change discipline:** retain WO-A…J, criterion A1…J4 (including added gates), journey U1…U16 and audit F1…F10 IDs. State changes with evidence belong in the ledger. Design changes belong in the owning contract/ADR with an execution record. Migration numbers are based on the current tree; inspect existing `0006` work rather than creating a competing migration or editing an applied one.

## 2. Release contract

### Generation and review

- Scraping prepares the JD and suggestions; it never starts resume generation. A truthful ready/blocked state is separate from the five board columns. No queued indicator without queued work.
- **Generate resume** and **Generate new version** explicitly start work. Bind a concrete profile version, JD, steering snapshot, selected terms, directives, parent and applicable revision note server-side. Default/profile changes cannot retarget queued work or historical input.
- Retry repeats one immutable request. Duplicate submissions dedupe by operation identity; a deliberate later generation may use identical guidance and still create a new version. Keep attempts, version lineage and failures inspectable.
- **Revise** opens an editable draft; opening/cancelling writes no review or terminal state. An explicit revision submission from an eligible awaiting-review parent atomically records the revision, binds guidance and queues its child. **Generate new version** from approved/declined parents preserves their terminal decisions; it must not force an illegal parent transition.
- **Decline version** requires a note, records a terminal decision and queues nothing. Creating a new draft never implicitly declines an earlier one or revokes approval.
- Latest draft, selected approved resume and the resume used for a recorded application are distinct. Approval from New moves to Tailored; approval from Tailored updates selection without moving the board. Applied/Interviewed allow later drafts/review without changing past application associations or timestamps. Rejected requires explicit reopen/correction before generation.
- Eligible older awaiting-review versions remain reviewable when their bound inputs are current. Stale versions stay inspectable with an actionable explanation. Conflict/fencing rules must prevent old work from undoing a human action.
- Claims require approved immutable evidence or an allowlisted derivation. Keywords, notes, work preferences and narrative are steering, never automatic fact approval or application answers. Resume approval and application/status recording remain explicit human actions.

### Profiles, documents and providers

- Independently manage each profile's master history without changing the default. Required fields: personal name/contact/links; employment, achievements, education/credentials; categorized skills, languages, career keywords and notes; executive narrative; authorization, work mode, sponsorship, relocation, experience, salary with currency/period, target titles and locations. Preserve unknown values.
- Support structured editing, documented JSON upload/paste, parsed review before activation, a valid downloadable example, JSON and readable Markdown export. **Create from existing profile** copies an immutable source into an independent draft with provenance and preserved verification states; explicit activation is still required. No copied resume approvals/application history and no silent approval upgrades.
- Preserve the existing standard output template. Full-master preview includes all supported sections and is not subject to a tailored one-page budget. Profile/version-specific links must survive later default/master changes.
- Tailored PDF preview shows the exact PDF; Markdown is safely readable; DOCX has a clearly labeled canonical **content preview** and an **Open original DOCX** action. Do not claim pixel-exact DOCX rendering. One compact preview group replaces duplicate download controls; original files remain obtainable from previews.
- Suggestions contain source-backed, relevant phrases: 5–10 when justified, fewer honestly on sparse JDs. Show source and support/gap state before generation. Unsupported requirements cannot become resume claims/keywords. Keep suggestions, user-selected input and actual coverage separate. Explain coaching outcomes honestly, including “not assessed” when needed.
- Google AI Studio, Meta Muse and OpenRouter have masked key entry and editable models. Test the entered configuration without saving; distinguish configured/tested/active state. Secrets stay only in `.env.local`, never returned, logged, stored in SQLite or included in backups. Optional providers do not block ordinary local use.

### Board and build limits

- Keep the theme and five-column Kanban. At desktop CSS widths ≥1280, show a readable three-column focus for New/Tailored/Applied, with accessible horizontal access to Interviewed/Rejected. Cap excessive 4K reading width; narrower screens may show fewer columns.
- Navigation stays near the logo; actual profile/readiness stays near settings. No breadcrumbs, stacked-view toggle, hard-coded active profile or new board column. Include native Previous/Next column navigation and lightweight follow-up date refresh.
- Included small improvements: profile readiness/setup link, JSON example/field errors, keyword count/Clear/source excerpt, reuse previous guidance, honest coaching outcome, stale-diagnostic invalidation, column navigation, badge freshness. Implement within existing seams.
- Deferred: extra template families, arbitrary Markdown/YAML/DOCX/PDF import, source-theme preservation, pixel-exact DOCX emulation, rich document editing, discovery, fit scoring, cover letters, scheduling/reminders, email/calendar, application automation, cloud sync, local LLM setup and new orchestration/database runtimes. No mandatory extra provider call or new service to deliver these fixes. [Rationale](release-context-v1.2.md).

## 3. Dependencies and checkpoints

Preferred sequence: **A → B → C → D → G → E → F → H → I → J**. G's isolated configuration work can start after A, but cannot close its integrated checkpoint before D. H can start after A when it does not overlap active edits.

| Order | Required inputs | Exit evidence |
|---|---|---|
| A | Existing schema/runtime and audited scope | A1–A4; corrected contracts and meaningful future-behavior specifications |
| B | A profile/source/fact-copy contracts | B1–B6; migration, repositories and profile-owned source APIs |
| C | B usable APIs/version/activation contract | C1–C6; complete settings onboarding |
| D | B persistence; C required for runtime checkpoint | D1–D9; real browser/worker PM-v1 → Senior-PM-v2 checkpoint |
| G | A provider contract; D required for runtime checkpoint | G1–G6; in-app setup → first/second generation checkpoint |
| E | D immutable input and provider path | E1–E5; relevance/support/coaching evidence |
| F | C master UI, D version/input history, E keyword outcomes | F1–F6; profile-correct history and valid document previews |
| H | A scope and current board/header | H1–H5; viewport/keyboard evidence |
| I | C–H behavior complete; B/D upgrade paths | I1–I4; integrated journey, migration, performance and human review evidence |
| J | I and required ledger gates | J1–J4; truthful release metadata/operations |

The two [early checkpoints](acceptance-v1.2.md#early-checkpoints) are required before optional polish. They use real routes, the supervised worker, isolated SQLite and valid artifacts; never terminal edits/direct SQL in place of user steps. Stub provider transport for repeatable automation; record live-provider evidence separately. Missing credentials remain an open live gate, not a fabricated pass. Final I repeats the complete integrated story.

## 4. Work orders

### WO-1.2-A — Contracts and acceptance ownership

**Outcome:** later builders have explicit behavior and data contracts, with no hidden interpretation of UI actions. Existing A/correction handoffs are in the log; review them before repeating work.

**Inspect:** lifecycle contracts, ADR-015…020, candidate/job/queue/review schemas, migrations, fixture helpers.

- Ratify state/command, snapshot/deduplication, draft/approval/application, copy-provenance and legacy-upgrade contracts. Preserve old ADRs and histories; reserve migration ownership based on actual files.
- Maintain PM/Senior PM and role-diverse JD fixtures; use valid DOCX/PDF bytes. Future-behavior specs must use real eligible profiles/parents and exact recorded input; separate legacy missing history. Prove an expected failure occurs at its intended assertion with setup verified.
- Keep active context/log links consistent and capture baseline revision/runtime/checks. Amend contracts for cancellation, old-worker exclusion, evidence-based approval selection and durable request-to-version links without implementing B/D.

**Verify:** [A1–A4](acceptance-v1.2.md#wo-12-a). **Writes:** docs/fixture/test harness only; no product migration or release bump.

### WO-1.2-B — Profile-owned data and master sources

**Outcome:** complete independent profiles and recoverable immutable master-source persistence.

**Inspect:** candidate domain/schema/repositories, candidate/settings/source services, profile/master routes, CLI import and backup/restore. Inspect existing `0006` and its recorded handoff; do not overwrite an applied migration.

- Implement the full §2 field inventory with versioned validation, explicit unknown values, and separate evidence versus steering. Preserve existing facts/hashes/membership; changed statements need new provenance and review.
- Implement independent source-profile copying under ADR-020; retain source identity/verification, mint IDs where required, avoid collisions and shared mutable content. Keep target activation explicit.
- Provide profile/version-ID-scoped stage/parse/review/activate/read/export APIs. Stage and publish files outside short DB transactions; later import/activation failure keeps prior active source and exports consistent. Reconcile/quarantine abandoned staged files.
- Migrate from stored profile payloads; retain a legacy source only where ownership is established. Label reconstructed exports, never attach one global file to every profile. Update CLI targeting, backup/restore/reset and path/symlink protection.

**Verify:** [B1–B6](acceptance-v1.2.md#wo-12-b), including injected failure/recovery and fresh/upgrade/restore cases. **Writes:** B-owned ordered migration, data/API/storage seams; UI is C. Publish concrete API/schema handoff for C/D.

### WO-1.2-C — Complete profile settings

**Outcome:** create, populate, inspect and activate any profile without switching defaults or terminal work.

**Inspect:** SettingsModal and B's APIs/schemas.

- Build labeled controls for every §2 field, list and employment/achievement group. Separate Save preferences from Review and activate master. Pending evidence is visible; ordinary form use requires no hand-authored IDs.
- Add Start empty/Create from existing profile with displayed source version; JSON upload/paste/example, field-level errors, parsed full preview and selected-version JSON/Markdown exports.
- Show readiness and a precise setup action. Preserve unsaved input on validation errors/background refresh; guard genuine loss of edits. Empty profiles can be inspected but cannot start generation.

**Verify:** [C1–C6](acceptance-v1.2.md#wo-12-c). **Writes:** UI and necessary route integration using B's persistence; no second source of truth. C onboarding must be available for D's early checkpoint.

### WO-1.2-D — Explicit generation and version lifecycle

**Outcome:** one complete user-started generation/revision/review loop, including repeat versions and failures.

**Inspect:** scrape publish, tailoring/review state machines and commands, queue/worker/orchestrator/provider, resume persistence, CardDrawer/ResumeReview, lifecycle contracts §§2–10.

- Stop automatic enqueue and phantom pending UI. Preflight known missing profile/evidence/JD/provider prerequisites before queue insertion; retain worker race checks and actionable errors. A blocked job cannot terminate the worker or prevent valid work.
- Implement §2 command distinctions, exact server-built snapshots and durable request → work/attempt → analysis → version retrieval. Preserve input on retry, canonical keyword-set hashing and operation-identity dedupe while permitting deliberate identical later requests.
- Implement cancel-safe Revise, atomic revision submission, decline-only, generation from awaiting/approved/declined parents, older eligible review, separate approved/application identity, and board rules. Require CAS/fencing for concurrent actions; preserve old files/approvals/applications.
- Complete the D-owned upgrade: quiescence, old-process exclusion, legacy work disposition, evidence-based selected-approved-pointer initialization, honest unknown application history and recovery. Validate the actual mechanism against old code; a new-worker guard alone cannot fence an old binary. Enforce new-request linkage even when both nullable analysis links are omitted. Define attempt publication ordering without mutating append-only completed history.
- Leave missing legacy guidance explicitly unrecorded. Update UI and worker together; removing a retry-route guard is not completion.

**Verify:** [D1–D9](acceptance-v1.2.md#wo-12-d) and [early C+D checkpoint](acceptance-v1.2.md#early-checkpoints). **Writes:** D migration/commands/state/worker/UI; coordinate with completed B schema. Record any needed contract amendment before dependent code.

### WO-1.2-E — ATS phrases and coaching

**Outcome:** useful evidence-aware choices before generation and truthful requested-emphasis outcomes afterward.

**Inspect:** ATS extractor, evidence matcher/ranker, provider guidance, drawer suggestions and coverage audit.

- Rank source-backed multiword business/domain/technical phrases with documented deterministic signals; exclude boilerplate, nested duplicates and false positives such as Go from go-to-market. Do not pad sparse sources.
- Show JD excerpts/locations and supported/uncertain/gap status; re-evaluate on profile change. Server-validate selections against the bound JD/evidence. Unsupported terms may inform coaching, never resume insertion.
- Preserve the three editable directive starters. Expose used/omitted by budget/unsupported/not applicable/not assessed outcomes with evidence where available. Add count, Clear and source explanation; keep suggestions, selected inputs and derived coverage distinct.

**Verify:** [E1–E5](acceptance-v1.2.md#wo-12-e), role-diverse fixtures and unsupported directives. **Writes:** existing domain/provider/UI seams; version selection policy in lineage, no required extra service/call.

### WO-1.2-F — Resume hierarchy and previews

**Outcome:** chosen master → scannable versions → immutable input/output detail → next-run guidance.

**Inspect:** drawer/review read models, master/artifact routes and canonical renderers.

- Master card targets selected profile/version; history targets its bound master independently. Show helpful empty state, truthful version/profile/status and distinct latest/approved markers. Record historical display name at generation where available; do not invent it for legacy rows.
- Version selection displays exact original guidance/revision note, requirements, gaps, selected-term outcomes and changes. A separate form is for the next run. Reuse settings prefills only; unavailable profiles/missing legacy history require an honest explanation.
- Deliver §2 new-tab preview contract, escape hostile content and resolve IDs safely. Remove duplicate download groups; preserve original-file access. Verify real cross-format claim parity and standard styling; report overflow rather than silently dropping claims.

**Verify:** [F1–F6](acceptance-v1.2.md#wo-12-f) with actual artifacts and keyboard/focus checks. **Writes:** read models/routes/UI and only necessary immutable preview metadata; never replace old artifacts.

### WO-1.2-G — Provider configuration

**Reported blocker to reproduce:** [provider-settings regression](feedback-g-provider-settings.md): saving OpenRouter resets the form to Google, key editing is unavailable, “Connected” only reflects key presence, and connection testing ignores model drafts. Resolve within G and prove G1–G6; do not defer to the post-J UX order.

**Outcome:** in-app setup tests the proposed config and truthfully identifies the config actually used by web/worker.

**Inspect:** settings/save/test routes, provider clients, environment loading and backup exclusions.

- Add masked write-only keys with explicit replace/remove; blank keeps existing. Use restrictive permissions and atomic serialized/conflict-aware env writes; preserve unrelated entries and redact secrets/errors.
- Test entered provider/model/transient key without saving; stored key may be reused. Editing invalidates prior results. Show configured/tested/active distinctly.
- Synchronize activation across web/worker; a documented existing restart is acceptable. Clear restart-needed only when active configuration is verified. Validate official provider contracts/defaults during implementation; unsupported/unverified live behavior is not “connected.”

**Verify:** [G1–G6](acceptance-v1.2.md#wo-12-g) and [setup/generation checkpoint](acceptance-v1.2.md#early-checkpoints), including auth/rate/timeout and secret exclusion. **Writes:** config/UI/provider seams; secrets never in SQLite. May build after A; checkpoint closure requires D.

### WO-1.2-H — Board and header usability

**Outcome:** readable three-column desktop focus and accessible downstream columns with truthful profile state.

**Inspect:** Board/BoardColumn/JobCard/AppHeader/page styles and existing health changes.

- Implement §2 responsive region, native horizontal navigation, touchpad/card-drag edge scroll, compact header/actions and actual profile readiness. Preserve filters/sort/search, current theme, polling and health behavior.
- Keep narrow-screen controls reachable and keyboard/focus behavior intact. Refresh follow-up dates on rollover/foreground return with a client clock; no scheduled jobs.

**Verify:** [H1–H5](acceptance-v1.2.md#wo-12-h) at specified CSS viewports, reduced motion and keyboard/pointer interactions. **Writes:** UI/read projections, no board-state migration.

### WO-1.2-I — Integrated release acceptance

**Outcome:** revision-tied proof of complete user journeys, upgrade safety, real document rendering and measured responsiveness.

**Inspect:** [acceptance protocol](acceptance-v1.2.md), B/D migration contracts, all C–H handoffs.

- Execute U1–U16 with real UI/routes, supervised worker, isolated DB, deterministic provider seam and valid artifacts. No direct state edits stand in for user actions. Cover fresh/upgrade/restore, legacy work, source failures, concurrent review/generation and preserved evidence.
- Run required unit/integration/browser-renderer/type/lint/build/E2E gates. Prove remaining expected-red specs have been replaced by passing target behavior. Fix flakes rather than repeating until green.
- Capture the specified viewport, production Apple Silicon performance, live-provider and human acceptance evidence. Record missing evidence as open, never inferred satisfaction or a scope exemption.

**Verify:** [I1–I4 and performance protocol](acceptance-v1.2.md#wo-12-i). **Writes:** isolated test/evidence artifacts and bounded defects within the proven requirement; no live consent impersonation.

### WO-1.2-J — Release closure

**Outcome:** release metadata and operations accurately reflect accepted behavior and explicit limits.

- Close every required ledger cell with evidence or an explicit user-approved scope change; do not silently defer core behavior. Preserve historical handoffs and clarify remaining v1.1 acceptance in release notes.
- Align current docs with source ownership, supported formats/previews, lifecycle, application identity, key activation and verified rollback. Bump package/lock to 1.2.0 only after required acceptance passes.
- If required browser/hardware/live-provider/human evidence is missing, label release candidate/needs-review rather than Complete. No automatic tag, deployment or live destructive migration.

**Verify:** [J1–J4](acceptance-v1.2.md#wo-12-j). **Writes:** final metadata/docs only after I; do not equate version bump with success.

## 5. Evidence and record destinations

**Planned follow-up after J:** [WO-POST-J-ELAPSED](work-order-post-j-elapsed.md) covers stable tailoring elapsed time, actual progress stages and actionable failures. Separate defect order; use D's final attempt model and G's configuration flow. Triage any launch failure blocking ordinary use at G's checkpoint.

**Planned follow-up after J:** [WO-POST-J-SALARY](work-order-post-j-salary.md) addresses explicit JD compensation missed during clipping, including existing-job recovery. It is a separate defect order, not an additional A–J release gate.

| Information | Canonical destination |
|---|---|
| Assigned outcome, scope, dependencies | This file |
| Criterion definitions, U1–U16, audit mapping, current evidence | [acceptance-v1.2.md](acceptance-v1.2.md) |
| State/data/upgrade design | [lifecycle-contracts-v1.2.md](lifecycle-contracts-v1.2.md), relevant [ADRs](decisions.md) |
| Actual prompts, handoffs, reviews, test results, deviations | [execution-log-v1.2.md](execution-log-v1.2.md) |
| Original intent, PR commentary, rationale and old section mapping | [release-context-v1.2.md](release-context-v1.2.md) |

Append implementation records to the log, not this plan. A handoff marked implemented closes only its proven bounded scope; unproven release criteria remain open. Every final response states changed behavior, exact verification, unresolved gates, data effects and next dependency readiness.
