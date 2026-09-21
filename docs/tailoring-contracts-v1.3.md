# v1.3 technical contracts

Normative implementation target inspected against the 2026-09-16 tree. This document specifies future code; no migration has been applied. Read with [work orders](work-orders-v1.3.md) and [acceptance](acceptance-v1.3.md).

## Step 2 amendment notice (2026-09-17)

For WO-1.3-S2-A–D, [Step 2 scope](step2-scope-v1.3.md) overrides the no-recommendation-AI-call, job-local profile selector and steering-only editor targets below. These remain the A–F baseline for historical formats. S2-A must publish exact versioned replacement contracts before S2-B construction; never reinterpret existing serialized v1/v2/v3 bytes in place. G–I reconciliation is deferred until the Step 2 checkpoint.

## Step 2 correction notice (2026-09-18)

[Step 2 correction scope](step2-correction-scope-v1.3.md) and R-ADR-026
supersede the new-format S2-D rule that unsupported user edits cannot generate.
S2-CP-A must publish exact replacement contracts in
`docs/contracts/v1.3-step2-correction-contracts.md`; until then, this document
and `v1.3-step2-contracts.md` remain authoritative only for their historical
formats. New bytes must distinguish verified source, user-accepted AI and user
edit provenance, link proposals to exact JD priorities, derive eligible roles
server-side and provide one Generate transition. Never reinterpret an existing
`step2-claims/1` or frozen input row.

## 1. Integration decisions

- Production route: /jobs/[id]/tailor. Preserve the actual mockup layout: Step 1 full JD; Step 2 profile, keyword cloud/inspector, themes, summary editor, phrase-to-role mappings and guidance; Step 3 progress; Step 4 review.
- Existing POST /api/jobs/:id/tailor/retry calls requestGeneration for both new and repeated requests. Add explicit workspace submission and attempt-specific retry adapters below; refactor the same service, not a second generation engine.
- Existing requestRevision mints a request ID. Extend it to accept the submitted operation ID and frozen focus in one outer transaction. Opening/canceling revision remains local; Generate commits parent review and child request together.
- v3 queue payload extends the v2 fields with inputHash and schemaVersion=tailor-queue/v3. Preserve the v2 reader and hashing byte-for-byte. Migration 0007 currently rejects non-v2 inserts; 0008 must replace that trigger.
- Freeze full master text at submission for the historical diff. Mutable workspace is never a worker input. New immutable request-input extension holds the additional focus/recommendation/projection fields without altering old request rows.
- Existing review service restricts decisions to active_resume_version_id. G must implement ADR-019 older-awaiting eligibility with exact current input/evidence checks; do not confuse viewing a version with selecting/approving it.
- No prototype fixture imports, fake scores/progress, implicit queue insertion, automatic approval, application automation, new columns or additional recommendation AI calls.

## 2. Schema ownership

B owns 0008_tailoring_workspaces.sql. The complete DDL is [v1.3-0008.sql](contracts/v1.3-0008.sql); the exact Drizzle mirror is [v1.3-drizzle.md](contracts/v1.3-drizzle.md). These are specifications under docs, not runtime migrations. If 0008 becomes occupied, reconcile numbering before implementation; never edit an applied migration.

| Table | Owner/lifetime | Primary identity |
|---|---|---|
| tailoring_workspaces | Mutable CAS draft, one per job | job_id, revision |
| tailoring_request_inputs | Immutable input extension; inserted with generation_requests | request_id |
| generation_progress_events | Append-only, maximum five boundary events per attempt | attempt_id, seq |
| resume_assessments | Immutable generation-time assessment | resume_version_id |

SQL enforces foreign ownership, immutable records, sequence/ranges and one live TAILOR item per job. Zod validates nested JSON; services validate hashes, active bindings, approved evidence, and trusted timestamps. All times are Date.toISOString(); no public request accepts now, actor, lease token, provider scores or paths.

## 3. JSON and API schemas

Implement the following pure schemas in src/domain/tailoringWorkspace.ts. All objects are strict. Id is the existing EntityId UUID; Key permits existing non-UUID profile IDs (including legacy local), fact IDs and role IDs. Apply semantic checks listed after the block.

~~~ts
import { z } from "zod";
import { EntityId as Id, Sha256Hex as Hash, IsoUtcDateTime as Time } from "./fields";
const Key = z.string().min(1).max(128);
const Note = z.string().trim().min(1).max(4000);
export const FocusV1 = z.object({
  schemaVersion: z.literal("tailoring-focus/v1"),
  selectedPhraseIds: z.array(Hash).max(20), themeId: Key.nullable(),
  summaryDirection: z.string().max(4000),
  mappings: z.array(z.object({ roleId: Key, phraseId: Hash,
    factIds: z.array(Key).min(1).max(20) }).strict()).max(100),
  additionalGuidance: z.string().max(1000),
}).strict();
export const RecommendationV1 = z.object({
  schemaVersion: z.literal("tailoring-recommendations/v1"),
  policyVersion: z.literal("recommendations/1"),
  extractionId: Id, jdHash: Hash, profileVersionId: Id, profileHash: Hash,
  phrases: z.array(z.object({ id: Hash, text: z.string().min(1).max(512),
    startByte: z.int().nonnegative(), endByte: z.int().positive(),
    excerpt: z.string().max(1024), count: z.int().positive(),
    category: z.string().max(80), support: z.enum(["supported","uncertain","gap"]),
    factIds: z.array(Key).max(100) }).strict()).max(100),
  roles: z.array(z.object({ id: Key, label: z.string().max(200),
    factIds: z.array(Key).max(100) }).strict()).max(100),
  themes: z.array(z.object({ id: Key, title: z.string().max(80),
    factIds: z.array(Key).max(100), summaryDirection: z.string().max(4000)
  }).strict()).max(10), preset: FocusV1,
}).strict();
export const WorkspacePut = z.object({
  schemaVersion: z.literal("tailoring-workspace/v1"),
  extractionId: Id.nullable(), profileId: Key.nullable(), profileVersionId: Id.nullable(),
  requestKind: z.enum(["INITIAL","NEW_VERSION","REVISION"]),
  parentVersionId: Id.nullable(), revisionNote: Note.nullable(),
  recommendationHash: Hash.nullable(), focus: FocusV1,
}).strict();
export const GenerateBody = z.object({
  schemaVersion: z.literal("tailoring-submit/v1"), requestId: Id,
  workspaceRevision: z.int().positive(), observedRowVersion: z.int().positive(),
}).strict();
export const RetryBody = z.object({
  schemaVersion: z.literal("tailoring-retry/v1"), observedAttemptId: Id,
  observedRowVersion: z.int().positive(),
}).strict();
export const DecideBody = z.object({ resumeVersionId: Id,
  observedRowVersion: z.int().positive(), note: z.string().trim().max(4000).optional(),
}).strict();
export const DeclineBody = DecideBody.extend({ note: Note }).strict();
export const WorkspaceView = z.object({ jobId: Id, revision: z.int().positive(),
  draft: WorkspacePut, recommendations: RecommendationV1.nullable(),
  lastRequestId: Id.nullable(), lastSubmittedRevision: z.int().positive().nullable(),
  updatedAt: Time,
}).strict();
export const WorkspaceReply = z.object({ ok: z.literal(true),
  workspace: WorkspaceView.nullable() }).strict();
export const RecommendationsReply = z.object({ ok: z.literal(true),
  recommendations: RecommendationV1, recommendationHash: Hash }).strict();
export const GenerationReply = z.object({ ok: z.literal(true), requestId: Id,
  workItemId: Id, status: z.enum(["QUEUED","RUNNING","SUCCEEDED","FAILED"]),
  replayed: z.boolean(), jobRowVersion: z.int().positive(),
  workspaceRevision: z.int().positive(),
}).strict();
export const Stage = z.enum(["PREPARING_INPUTS","WAITING_FOR_PROVIDER",
  "VALIDATING_PROPOSAL","RENDERING_ARTIFACTS","PUBLISHING_RESULT"]);
export const Failure = z.object({
  code: z.enum(["INPUT_STALE","PROFILE_UNAVAILABLE","CONFIGURATION","AUTHENTICATION",
    "RATE_LIMIT","NETWORK","PROVIDER_TIMEOUT","LOCAL_LAUNCH","INVALID_RESPONSE",
    "CLAIM_VALIDATION","RENDER_FAILED","PUBLISH_FAILED","LEASE_LOST","INTERNAL"]),
  stage: Stage.nullable(), occurredAt: Time,
  action: z.enum(["edit_focus","edit_profile","open_settings","retry","wait"]),
  retryAfterSeconds: z.int().nonnegative().nullable(),
  launchSubcode: z.enum(["ENOENT","EACCES","OTHER"]).nullable(),
}).strict();
export const ProgressReply = z.object({ ok: z.literal(true), requestId: Id,
  state: z.enum(["QUEUED","RUNNING","SUCCEEDED","FAILED"]), serverNow: Time,
  attemptId: Id.nullable(), startedAt: Time.nullable(), finishedAt: Time.nullable(),
  leaseExpiresAt: Time.nullable(), lastHeartbeatAt: Time.nullable(),
  events: z.array(z.object({ seq: z.int().min(1).max(5), stage: Stage,
    source: z.enum(["provider","cached"]), recordedAt: Time }).strict()).max(5),
  failure: Failure.nullable(), resumeVersionId: Id.nullable(), retryAllowed: z.boolean(),
}).strict();
const MeasureSide = z.discriminatedUnion("status", [
  z.object({ status: z.literal("assessed"), numerator: z.int().nonnegative(),
    denominator: z.int().positive() }).strict(),
  z.object({ status: z.literal("not_assessed"), reason: z.enum(["NO_ELIGIBLE_ITEMS",
    "BASELINE_UNAVAILABLE","CHECK_NOT_APPLICABLE","LEGACY_UNRECORDED"]) }).strict(),
]);
export const AssessmentV1 = z.object({ schemaVersion: z.literal("resume-assessment/v1"),
  policyVersion: z.literal("assessment/1"),
  measures: z.array(z.object({ key: z.enum(["selected_keywords","supported_requirements",
    "document_checks","evidence_integrity"]), original: MeasureSide, tailored: MeasureSide,
    itemIds: z.array(Key).max(1000) }).strict()).length(4),
}).strict();
export const WorkflowReviewExtension = z.object({
  schemaVersion: z.literal("workflow-review/v1"), requestId: Id.nullable(),
  masterText: z.string().nullable(), masterTextHash: Hash.nullable(),
  tailoredText: z.string(), tailoredContentHash: Hash,
  focus: FocusV1.nullable(), assessment: AssessmentV1.nullable(),
  selectedApproved: z.boolean(), latestPublished: z.boolean(),
  allowedActions: z.object({ approve: z.boolean(), revise: z.boolean(), decline: z.boolean(),
    newVersion: z.boolean(), reason: z.string().max(280).nullable() }).strict(),
}).strict();
export const ErrorBody = z.object({ ok: z.literal(false), error: z.object({
  code: z.enum(["INVALID_REQUEST","FORBIDDEN","NOT_FOUND","PRECONDITION_REQUIRED",
    "WORKSPACE_CONFLICT","JOB_CONFLICT","INPUT_STALE","GENERATION_BUSY",
    "IDEMPOTENCY_MISMATCH","PROFILE_NOT_READY","JD_NOT_READY","PROVIDER_NOT_READY",
    "INVALID_SELECTION","REVIEW_NOT_ALLOWED","RETRY_NOT_ALLOWED",
    "ARTIFACT_INTEGRITY","STORAGE_UNAVAILABLE"]),
  message: z.string().max(280), field: z.string().max(128).optional(),
  currentWorkspaceRevision: z.int().nonnegative().optional(),
  currentRowVersion: z.int().positive().optional(), requestId: Id.optional(),
  action: z.enum(["reload","edit_profile","open_settings","edit_focus","wait",
    "retry","inspect_artifacts"]).nullable(),
}).strict() }).strict();
~~~

Semantic checks: unique selected IDs/mapping pairs/measure keys; numerator ≤ denominator; endByte > startByte; profile/version both null or owned pair; INITIAL has no parent/note; NEW_VERSION has parent/no note; REVISION has parent/nonblank note. Empty draft is saveable, but cannot Generate. Stored JSON uses canonicalJson after parsing; SQL storage byte caps also apply.

Without a complete active binding/recommendation snapshot, selectedPhraseIds and mappings must be empty and themeId null; free summary/guidance remains saveable. An unknown resource/foreign ownership returns 404; an owned but no-longer-active binding returns 409 INPUT_STALE. Semantically invalid selection returns 422 INVALID_SELECTION. Schema/length/extra-field failure returns 400 INVALID_REQUEST.

### 3.1 Source and hash rules

- Canonical JD: NFC and LF, preserve internal whitespace; quote ranges are UTF-8 bytes [start,end), never JS UTF-16 indices. Verify exact decoded slice.
- Phrase ID = SHA256(canonicalJson({extractionId,jdHash,startByte,endByte,text})). Counts use case-folded whole-phrase token boundaries in exact JD. Fixed category dictionary, fallback Other. Reuse extractAtsKeywords/evaluateKeywordSupport; 5–10 ranked phrases where justified, ≤100 cloud candidates; never pad.
- Preset and selectedPhraseIds include only supported phrases with approved facts. Uncertain/gap candidates are inspectable but disabled for inclusion. Role mapping additionally proves fact ownership of that role; generic transferable experience cannot prove a missing tool/domain.
- Role IDs use immutable payload keys or SHA256(profileVersionId + canonical role path), not employer names. Themes group approved evidence deterministically; default summary is canonical master summary/approved statements. Summary edits are requested wording, not trusted claims.
- recommendationHash = SHA256(canonicalJson(RecommendationV1)); server recomputes on save/submit. Client supplies no recommendation object.
- Existing selected_keywords_json equals sorted/deduped selected phrase text; directives_text equals additionalGuidance (empty→NULL); revision_note matches draft. Worker rejects disagreement with focus. Existing steering snapshot retains narrative/preferences.
- inputHash = SHA256(canonicalJson({schemaVersion:"workflow-request-input/v1",workspaceRevision,focus,recommendations,candidateSnapshotId,masterText,masterTextHash,projectionVersion})). Projection version master-text/1 freezes full canonical master text ≤262144 UTF-8 bytes. This hash is distinct from the provider-envelope inputHash recorded on provider attempts.
- v3 payloadHash = SHA256(canonicalJson({schemaVersion:"generation-hash/v3",base:<existing canonical request object>,inputHash})). Keep v2 hash and identity genreq:v1:{requestId} unchanged.
- submitHash = SHA256(canonicalJson({jobId,requestId,workspaceRevision,observedRowVersion})); identical submission replays even if failed; different body/job with same ID→ 409.

### 3.2 Provider and deterministic compiler integration

E owns the envelope and dispatch plumbing; F executes it. Extend src/tailoring/contract.ts with the following input schema (imports FocusV1/RecommendationV1 from the pure domain module). Preserve the v1 input reader for queued v2 work; new v3 work uses v2 provider input. Update the command adapter and the actual configured Google/Meta/OpenRouter client scripts together. Unsupported schema versions fail before making a remote call.

~~~ts
export const TailoringInputV2 = TailoringInputV1.omit({
  schemaVersion: true, promptVersion: true, revisionNote: true,
}).extend({
  schemaVersion: z.literal("tailoring-input/v2"),
  promptVersion: z.literal("tailor-prompt/v2"),
  revisionNote: z.string().trim().min(1).max(4000).optional(),
  focus: FocusV1,
  recommendations: RecommendationV1,
}).strict();
~~~

- Transport canonical bytes of this complete envelope; provider-attempt inputHash covers those bytes. Expand promptVersion validators in attempt/audit readers to accept v1/v2; do not relabel historical records.
- selectedKeywords is the same frozen selected-text projection. Provider limit128 characters remains enforced: extracted phrase text can be512 characters, but only terms≤128 can be selected; longer quotes remain mapping/inspector context. Directives remain≤1000. Revision note limit4000 is explicit in v2; do not truncate to v1's2000.
- Provider returns existing ResumeProposalV1 requirements, evidence references and rationale. It cannot return edited resume bytes or trusted summary wording. Tell it to consider chosen theme/summary direction/mappings only when identifying evidenced requirements.
- Feed focus to the deterministic compiler as well as the prompt: validate mappings against role-owned facts; prioritize mapped eligible facts, then selected-term eligible facts, then existing rank/tie-break rules, preserving section budgets. Ties use existing stable rank then fact ID. No new claim/template path is introduced.
- Summary direction can select/reorder approved summary statements or existing approved wording variants only. Unsupported verbatim edits become a gap; don't silently claim the typed summary was applied. If the compiler cannot assess a requested paraphrase, existing coaching outcome is not_assessed. Return used/omitted_budget/unsupported/not_assessed outcomes through the existing coaching read model, tied to focus field/phrase ID and supporting fact IDs. G displays them in the inspector.
- Test both consumers: the provider spy receives the exact frozen v2 envelope; compiler fixtures demonstrate a supported mapping changes eligible ordering while an unsupported summary sentence never appears in generated content.

## 4. HTTP operations

All new endpoints use strict schemas above, application/json and Cache-Control: no-store. Apply existing Host/Origin/mutation protections. Limit request bodies to 128 KiB before JSON parsing; excess→ 413 INVALID_REQUEST. New failures use ErrorBody; existing endpoints retain their envelopes while their clients migrate. Public review bodies omit actor/now even though current service schemas permit injected clocks internally.

Workspace ETag: quoted strong token "tw:{jobId}:{revision}"; missing workspace has revision 0. GET never inserts. PUT requires one If-Match: absent→ 428, malformed/wildcard/list→ 400, wrong job/revision→ 412. Successful PUT returns new ETag. Job CAS is observedRowVersion (409), independent of workspace ETag.

| Method/path | Request | Success | Failure status/code |
|---|---|---|---|
| GET /api/jobs/:id/tailoring/workspace | none | 200 WorkspaceReply + ETag; null valid | 400 invalid UUID;403;404 job;503 storage |
| PUT /api/jobs/:id/tailoring/workspace | WorkspacePut + If-Match | 201 create /200 update WorkspaceReply + ETag | 400 shape;403;404 ownership;412 WORKSPACE_CONFLICT;428;409 INPUT_STALE;422 INVALID_SELECTION;503 |
| GET /api/jobs/:id/tailoring/recommendations?extractionId=&profileVersionId= | two required UUIDs | 200 RecommendationsReply | 400;403;404 ownership;409 INPUT_STALE;422 readiness;503 |
| POST /api/jobs/:id/tailoring/generations | GenerateBody | 202 accepted /200 replay GenerationReply | 400;403;404;409 JOB_CONFLICT/WORKSPACE_CONFLICT/GENERATION_BUSY/INPUT_STALE/IDEMPOTENCY_MISMATCH;422 readiness;503 |
| GET /api/jobs/:id/tailoring/generations/:requestId | none | 200 ProgressReply | 400;403;404 wrong job/request;503 |
| POST /api/jobs/:id/tailoring/generations/:requestId/retry | RetryBody | 202 requeued /200 replay GenerationReply | 400;403;404;409 job/attempt/busy;422 RETRY_NOT_ALLOWED;503 |
| GET /api/jobs/:id | existing | 200 JobDetailView for header/properties/notes/version summaries | existing statuses |
| GET /api/resumes/:id/review | existing | 200 ResumeReviewView + workflowReview: WorkflowReviewExtension | existing statuses |
| POST /api/jobs/:id/resume/approve | DecideBody | 200 existing ApproveResumeResult | 400 body/forbidden;403;404;409 conflict/stale;500 artifact integrity |
| POST /api/jobs/:id/resume/decline | DeclineBody | 200 existing DeclineVersionResult | same review mapping |
| POST /api/jobs/:id/notes | {body:string(1..4000)} | 200 existing AddNote result | existing statuses; server controls timestamps |
| GET /api/settings/profiles/:profileId/versions/:versionId | none | 200 existing owned profile/version/payload/source | existing statuses |
| GET /api/resumes/artifacts/:artifactId[?download=1] | none | 200 exact bytes or existing safe content preview | existing ID/allowlist/integrity statuses |

Add strict response validation to reused read models before extension; no z.any/unchecked database JSON. Initial version history is 50 summaries; GET /api/jobs/:id/tailoring/versions?cursor=&limit= paginates by created_at/id (limit 1..50). Strict response {ok:true,versions:VersionSummary[],nextCursor:string|null}; VersionSummary uses {id:Id,version:positive int,profileDisplayName:string|null,reviewState:existing ReviewState,createdAt:Time,selectedApproved:boolean,latestPublished:boolean}. Malformed cursor→ 400; no artifact body in list/board reads.

### 4.1 Transactions

**W — save:** Compute recommendations outside transaction. BEGIN IMMEDIATE; compare workspace ETag (0 creates); recheck job/extraction/profile active ownership and recommendation hash; validate selected terms/role facts; INSERT revision 1 or UPDATE WHERE revision=:observed SET revision=revision+1. Preserve last_request_id/last_submitted_revision. Commit or roll back all. No job version increment, queue/review/provider call.

**G — generate:** Verify source bytes/build projection outside transaction. BEGIN IMMEDIATE; lookup requestId FIRST. Existing identical submitHash→ 200 no writes/requeue, different→ 409. Check draft revision, job CAS, no live work, pinned current inputs, provider/evidence readiness, parent eligibility; recheck source hashes. Create/reuse candidate/JD snapshots; insert work item→generation request→immutable request inputs (FK order). CAS job once to PENDING; CAS workspace revision+1 and last_request_id/last_submitted_revision=new revision. REVISION also sets parent REVISION_REQUESTED and appends human review/note/digests atomically. Any failure aborts all, including new snapshots. Commit→ 202. No I/O/await inside transaction.

**R — retry:** BEGIN IMMEDIATE; resolve owned request/observed failed attempt. If later attempt exists, or same work already requeued/running, return 200 replay without writes. Otherwise require current inputs, retryable terminal failure, job CAS, no other live run. Requeue same work item through existing primitive; preserve immutable input and attempt numbering; mark request QUEUED/job PENDING. Claim creates new attempt. Existing automatic maxAttempts/backoff remains bounded; explicit retry follows existing requeueWorkItem policy and never rewrites old attempts. An earlier observed attempt cannot requeue a later failure.

The existing primitive is named requeueWorkItem in src/queue/leases.ts; use it inside R's outer transaction. Foreign/missing observedAttemptId→ 404 NOT_FOUND; latest successful/nonretryable attempt→ 422 RETRY_NOT_ALLOWED; stale job revision→ 409 JOB_CONFLICT; another live request→ 409 GENERATION_BUSY. Replay detection precedes CAS so a lost202 response can be reconciled without a second retry.

**A/D — review:** Hash artifacts outside transaction for approval; inside BEGIN IMMEDIATE recheck target/hashes/job CAS/freshness/no live run. Older awaiting version may be eligible without being active, provided bound extraction/profile are current and evidence validates. A appends review, updates selected pointer; NEW→TAILORED only. D appends DECLINED, leaves active/selected/application pointers intact. When deciding older version, job tailoring state follows active version. Repeated stale decision→ 409 with zero second review. Existing artifact-integrity failures remain500.

## 5. UI operation mapping

| /mockup action | Production operation and effect |
|---|---|
| Card/Back to board | Route navigation; GET detail/workspace; no mutation. Retain board filters/scroll in presentation state. Drag/nested actions do not navigate. |
| Properties / Notes open-close | Loaded detail; no write. Add note→existing notes POST (job_notes only). |
| Original posting | Open retained safe URL; never record application automatically. |
| Step 1 Tailor Resume | Navigate Step 2; GET recommendations for saved/local default binding. No automatic draft/queue creation; provider absence cannot block reading/editing Step 2. |
| Step indicator / Back | URL/presentation state; flush pending user edits. No mutation solely from navigation, no cancellation. |
| Profile dropdown | Resolve exact active version→GET recommendations→W with changed binding; preserve free guidance, clear incompatible selections/mappings, reset summary/theme. Global default unchanged. |
| Preview master / Edit candidate profile | Existing version-specific preview; editor opens selected profile (implement query selection if absent). Return shows stale-binding prompt, no silent repin. |
| Cloud category/search/inspector/evidence expansion | Local filtering from RecommendationV1. Real counts/excerpts/fact references; zero mutation/provider calls. |
| Keyword add/remove/Clear | W selectedPhraseIds; gaps disabled; Clear affects selected terms only. |
| Preset/theme | Copy server-generated choices/direction; W; no model call. |
| Summary Edit/Cancel/Save/Reset | Local edit buffer; cancel writes nothing; Save W.summaryDirection; Reset frozen master summary. Provider and deterministic validation still required. |
| Phrase role drag/drop or keyboard selector/remove | W mappings with role-specific approved fact IDs. Never insert JD sentence directly into resume content. |
| Starter/free guidance | W bounded additionalGuidance. Over limit→ 400 field error; no silent truncation. |
| Generate | Flush W and await latest revision; mint operation UUID once→G; retain exact body/ID for uncertain network replay. |
| Status/timer | Poll request GET every2s visible/10 s hidden; browser clock writes nothing. |
| Retry/Back to focus | R /navigate Step 2. Changed guidance→new G ID; Back never requeues/cancels. |
| Connection test/settings | Existing real settings test/save; success never automatically retries or proves worker activation. |
| Demo slow/error/fast-forward/reset | Omit from production; injection only through test dependencies. |
| Version selector | GET exact owned review; no selected-approved pointer mutation; wrong-job version 404. |
| All/Changed sections, inspectors | Local filters only; full canonical content unchanged. |
| PDF/master/DOCX/Markdown | Existing exact ID-scoped preview routes; no regeneration; historical master from frozen input. |
| Approve | A; on200 refresh board/detail/review. |
| Request changes/New version | Local modal; Cancel zero writes. Continue explicitly W with parent/note, go Step 2. Awaiting parent→REVISION; approved/declined→NEW_VERSION (no revision note). Only G changes parent/enqueues. |
| Decline | D with note; zero queue work. |
| Card Download Resume | Batched board lookup of selected approved PDF ID; GET ?download=1; no fallback to latest draft. |

Autosave500ms debounce; one in-flight W, queue latest local edit against returned revision. 412 stops autosave and retains local input for explicit reload/reapply. Pending page unload warns unsaved changes; do not promise persistence before 200/201. No browser storage authority.

Resolver: explicit owned version→Step 4 inspect; live request→Step 3 default (explicit Step 1/2 allowed, Generate disabled); draft revision>last_submitted_revision→Step 2; otherwise last request failed→Step 3, published version→Step 4, saved draft→Step 2, absent workspace→Step 1. Old failures must not trap new edits.

*(2026-09-16 WO-1.3-A clarification: the resolver list above is priority-ordered. When a live request and an explicit owned version URL coexist, the explicit version wins — inspection is read-only — and the live request stays reachable through its own navigation. The C5 matrix cases are single-condition cases; they do not reorder this precedence.)*

## 6. Worker and progress

Every progress/publication/failure write rechecks tuple {workItemId,attemptId,leaseToken} in the same short transaction:

~~~sql
SELECT 1 FROM work_items w JOIN work_attempts a ON a.id=w.current_attempt_id
WHERE w.id=:workItemId AND w.state='RUNNING' AND w.current_attempt_id=:attemptId
  AND w.lease_token=:leaseToken AND a.result='RUNNING' AND a.work_item_id=w.id
  AND julianday(w.lease_expires_at)>julianday(:serverNow);
~~~

- serverNow is trusted/injected clock, never browser/provider input. Strengthen renewLease/completeWorkItem: current code checks state/token but not expiry/current attempt. Expired leases cannot revive before recovery runs.
- Claim creates RUNNING attempt and request. Emit seq 1 after loading valid immutable inputs; seq 2 before provider/cached proposal retrieval; seq 3 before proposal validation; seq 4 before rendering; seq 5 after staged artifact validation before DB publication. Failure stops sequence. Model fallback stays within stage2, no duplicate stage event.
- Event source=provider|cached persists per attempt and is constant. Cached proposal recovery labels stage2 "Loading saved proposal"; never says AI is called when it is not.
- Renew every min(30000,floor(leaseDurationMs/3))ms during provider/render awaits; default lease300000ms. One timer, cleared in finally. Failed renewal aborts work where supported and forbids publication. Process log heartbeat is not attempt liveness.
- Stage5 publication transaction attaches version/claims/artifact metadata/assessment/active pointer/request success under lease and input/job fences. Stage/rename/hash files outside DB transaction; failed attach leaves unreferenced staged files for existing reconciliation.
- In addition to the lease tuple, publication requires jobs.row_version=the expected version returned by this attempt's beginTailorRun, jobs.active_extraction_id=request.extraction_id, the bound profile version still active, matching recomputed request/input hashes, and board status in NEW/TAILORED/APPLIED/INTERVIEWED. A CAS miss aborts the entire attachment; no partial version/assessment/pointer commit. Workspace edits do not invalidate a frozen request because the worker never consults workspace revision.
- Crash after successful publication: recover committed request/version, complete work without provider rerun. Existing request-linked analysis is unique: if analysis exists but no version, reuse its validated immutable proposal under a new attempt; preserve original analysis attempt lineage and bind new resume to the publishing attempt. Never insert second analysis or resume for request. Cached path still runs real validation/render boundaries1–5.
- Transient failed attempt followed by queued retry reports QUEUED and retains failure evidence; terminal/exhausted failure reports FAILED. Committed version wins over stale RUNNING bookkeeping. Lease recovery finishes old attempt once; old token cannot append/finish/publish.
- Elapsed=floor(max(0,estimatedServerNow-startedAt)/1000), using serverNow plus performance.now delta and resync on poll/visibility. New attempt resets; terminal uses finishedAt; queue wait separate. Invalid/missing/>1 s future start shows no numeric duration. No interval-tick accumulation or per-second SQL writes.
- Two failed visible polls (≥4 s)→"Status unavailable", retain stage. Server time≥leaseExpiresAt→"Waiting for worker recovery", not FAILED. Stage2≥30 s→"Waiting for AI response"; only actual timeout ends work. lastHeartbeatAt=observed successful renewal timestamp (work_items.updated_at while RUNNING); never infer provider progress from it.

| Failure.code | Automatic retry/action |
|---|---|
| INPUT_STALE, PROFILE_UNAVAILABLE | None; edit focus/profile and create new request |
| CONFIGURATION, AUTHENTICATION, LOCAL_LAUNCH | None; Settings, explicit same-input retry after repair. Show ENOENT/EACCES only from actual spawn code |
| RATE_LIMIT | Existing bounded retry honoring capped Retry-After; wait/retry |
| NETWORK, PROVIDER_TIMEOUT, INVALID_RESPONSE | Existing bounded retry, then explicit retry |
| CLAIM_VALIDATION | None; explicit gap/edit focus, never publish invalid claim |
| RENDER_FAILED, PUBLISH_FAILED | Transient I/O bounded retry; corrupt template/hash nonretryable |
| LEASE_LOST | Old worker writes nothing; recovery decides state |
| INTERNAL | Safe generic message; no stack/raw payload in response |

Existing request/attempt error_code holds code; error_detail holds versioned {schemaVersion:"tailoring-failure/v1",failure:Failure} JSON through an allowlisted adapter. Legacy text→INTERNAL; keep raw text server-private. No stderr, arguments, paths, candidate text, keys or raw provider payload in UI diagnostics. Actual provider/model/config identity remains in existing attempt metadata.

## 7. Assessment and diff

| assessment/1 key | Denominator | Original numerator | Tailored numerator |
|---|---|---|---|
| selected_keywords | frozen selected supported phrase IDs | exact phrase matches in frozen master | same matcher/evidence-qualified matches in canonical tailored text |
| supported_requirements | supported requirement IDs in validated analysis (exclude gaps) | Not assessed: no original claim mapping | requirements linked to ≥1 rendered approved claim |
| document_checks | applicable check IDs: nonempty content, valid contact, no render overflow, cross-format claim parity | Not assessed: no equivalent master render set | passed recorded checks; unrun checks not passes |
| evidence_integrity | rendered claim IDs requiring facts/allowlisted derivation | Not assessed: no generated claim inventory | claims passing snapshot membership/derivation checks; any failure blocks publication |

Zero denominator→not_assessed. Numerator≤denominator. Delta only for both sides assessed over same eligible IDs; percent round(100*n/d). No composite or ATS-vendor score. Insights derive from recorded diff/coverage/budget/gaps; no extra AI call.

Diff compares frozen master_text with selected canonical tailored text, LF-normalized, preserving spaces/blank lines and escaping content. Cap each side262144 bytes/10000 lines; algorithm budget1000000 cell comparisons. Over budget display complete escaped side-by-side text with diff-unavailable notice; no silent truncation/content rewriting. No per-line editing/acceptance.

## 8. Upgrade and resource limits

- Stop web/worker before 0008. Assert zero live TAILOR items; drain/recover/cancel explicitly through existing commands. New partial unique index may reject corrupted duplicate work; do not delete rows to force migration. Existing historical v2 records unchanged.
- Reset follows current backup/database-rebuild path; do not drop immutable triggers in a live DB. Backup/restore validates all four new tables; restored leases recover before execution. New binaries support v2 and v3; old binaries cannot operate v3 safely and must remain stopped.
- Query budgets: workspace/recommendations≤8 statements each; progress≤5; board≤measured baseline+1 batch artifact query; version page≤4 per50; full review≤baseline+3. A records existing baselines. No artifact-body loading in board/list/poll.
- C–G retain old route adapter until H; H removes duplicate generation/review UI only after parity. User checkpoints after D,F,G,H.
