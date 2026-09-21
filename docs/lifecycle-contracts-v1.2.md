# Release 1.2 — Lifecycle and Migration Contracts

Frozen by `WO-1.2-A` on 2026-09-14. Authority:
[Release 1.2 work orders](work-orders-v1.2.md#2-release-contract) (binding product
decisions), [R-ADR-015 … R-ADR-020](decisions.md), and the
[v1.1 alignment audit](alignment-audit-v1.1.md) findings F1–F10. Later
orders implement against this target design; current behavior is proved by
code and acceptance evidence. Read the assigned work order and its
[acceptance gates](acceptance-v1.2.md), including D9, before treating a
proposed guard or migration mechanism as sufficient. Historical reasoning
and handoffs live in [the execution log](execution-log-v1.2.md).

Table and column names below are the actual current names verified in
`src/db/schema/*`, `src/domain/*`, `src/server/*`, and `src/tailoring/*`
at baseline `bd7a227`. Target deltas name their owning work order and
migration number. The table inventory is the historical baseline, not a claim about the current
working tree. B owns profile/source persistence changes; D owns generation
and review changes. Inspect current migrations before implementing either.

## 1. Current persistence (verified)

| Table | Role | Decisive current fields |
|---|---|---|
| `jobs` | Normalized job + board/worker state | `status`, `rank`, `row_version`, `tailoring_state` (default `PENDING`), `tailoring_reason_code`, `active_extraction_id`, `active_resume_version_id` (latest published; written at publish in `src/tailoring/persist.ts`) |
| `work_items` | Durable queue | `kind` (`SCRAPE`/`TAILOR`), `idempotency_key` (unique), `state` (`QUEUED`/`RUNNING`/`SUCCEEDED`/`FAILED`/`CANCELLED`), lease columns, `attempt_count` (never reset, R-ADR-011), `max_attempts` |
| `work_attempts` | Append-only executions | `(work_item_id, attempt_number)` unique, `result` (`SUCCEEDED`/`FAILED`/`BLOCKED`), `error_code`, `error_detail` |
| `resume_versions` | Immutable versions | `version`, `parent_version_id`, `analysis_id`, template/ranker/policy/config lineage, `content_json`, `content_hash`, `review_state` (`DRAFT`/`AWAITING_REVIEW`/`APPROVED`/`REVISION_REQUESTED`/`FAILED`) |
| `resume_reviews` | Append-only human decisions | `action` (`APPROVED`/`REVISION_REQUESTED`), `actor`, `note`, `resume_hash`, `content_hash`, `artifact_hashes_json` |
| `resume_artifacts` | Rendered files | `kind` (`MARKDOWN`/`DOCX`/`PDF`), `relative_path`, `media_type`, `byte_size`, `sha256`; unique per version+kind |
| `candidate_profiles` | Named career tracks | `name` (unique slug), `display_name`, `is_default`, `work_preferences_json`, `executive_narrative` |
| `candidate_profile_versions` | Immutable typed payloads | `profile_id`, `version`, `payload_json`, `payload_hash`, exactly one `activated_at` per profile |
| `candidate_facts` | Verified facts | `fact_id` (global primary key), owning `profile_version_id`, `verification` |
| `candidate_snapshots` + `candidate_snapshot_facts` | Immutable generation inputs | Canonical JSON + hash; relational membership so claims cite only bound evidence |
| `jd_snapshots` | Immutable JD inputs | `job_id`, `extraction_id`, `jd_text`, `canonical_sha256` |
| `job_analyses` | Requirements + gaps | `jd_snapshot_id`, `candidate_snapshot_id`, `work_attempt_id`, provider/prompt/proposal lineage, `input_hash` (includes R-ADR-013 guidance) |
| `applications` | Human-recorded applications | `job_id` (unique), `recorded_by` (`human` only), `applied_at`, `confirmation_number`; no version link today |
| `workflow_events` | Append-only board history | `actor`, `from_status`/`to_status`, `rank`, `row_version`, `reason`, versioned `metadata_json` |

Source bytes today: one global `master-resume.json` under the candidate
directory (`src/server/settings.ts` `masterResumePath`), replaced before
re-sync. Queue keys today: `tailor:v1:{job}:{extraction}` (automatic,
unguided), `tailor-guide:v1:{job}:{extraction}:{guidanceHash}` (guided),
`tailor-rev:v1:{job}:{parentVersion}` (revision follow-up, unguided),
all with `tailor-queue/v1` payloads.

## 2. Board state — no graph change

`New → Tailored → Applied → Interviewed`, with `Rejected` reachable as
today (`src/domain/board.ts`). Entering `Tailored` stays approval-only.
Target clarifications (behavior, `WO-1.2-D`):

- Approval from `New` moves to `Tailored` and sets the selected pointer.
- Approval from `Tailored` updates the selected pointer; board stays.
- `Applied`/`Interviewed` allow new drafts and exact-version review;
  the recorded `applications` row (`applied_at`, bound version) is
  immutable and a replacement approval is recorded separately.
- `Rejected` requires the existing explicit reopen/correction before
  any new generation; decline/revise never move the board.

## 3. Tailoring state — current → target

Current `jobs.tailoring_state` values: `PENDING`, `BLOCKED`, `RUNNING`,
`AWAITING_REVIEW`, `APPROVED`, `REVISION_REQUESTED`, `FAILED`
(`src/domain/tailoring.ts`). `PENDING` is also the row default, so a
fresh card and a queued run look identical — the F1 display defect.

Target (migration + transitions owned by `WO-1.2-D`):

| Stored state | Meaning | Display rule |
|---|---|---|
| `PENDING` | Initial row value (no extraction yet), or an explicit request queued awaiting worker claim | Never rendered as queued work unless a `QUEUED` TAILOR item exists for the job |
| `READY` (**new**) | JD extracted, guidance available, no run queued or running | "Ready to tailor" + `Generate resume` / `Generate new version`; never a board column |
| `RUNNING` | Worker holds the lease | Unchanged |
| `AWAITING_REVIEW` | A version awaits human review | Unchanged |
| `APPROVED` | Latest activity approved | Unchanged (record-level approvals live in `resume_reviews`) |
| `REVISION_REQUESTED` | A version was sent back for guidance editing | No automatic run follows; shows the guidance draft, not a spinner |
| `BLOCKED` | Prerequisite missing at execution (post-enqueue race) or provider unavailable at run time | Reason code + manual retry action. Known-missing prerequisites fail earlier at command preflight (§5) with no work item; `BLOCKED` covers only what preflight could not know |
| `FAILED` | Latest run failed (including fenced stale/legacy completions) | Reason code + retry (same inputs) or new request |

New-job default stays `PENDING`; extraction publish moves
`PENDING → READY`; explicit enqueue moves `READY → PENDING`; the worker
claim moves `PENDING → RUNNING`. Declining the only live version moves
the job back to `READY`; when another version is live
(`AWAITING_REVIEW`/`RUNNING`), the job reflects that instead.

## 4. Review state — current → target

Current `resume_versions.review_state` and `resume_reviews.action`:
approval and revision-request only (§1). Target (`WO-1.2-D` migration
extends both `CHECK`s with `DECLINED`):

- `DECLINED` is terminal at both levels: no exit transition, no queued
  work, no board effect. Requires an eligible `AWAITING_REVIEW` version
  and a human note.
- `REVISION_REQUESTED` stays terminal per version but is recorded
  only at explicit submit (see the correction box below): opening or
  cancelling the guidance form persists nothing. The follow-up run
  starts only from a submitted new-version request (parent + note +
  full guidance).

> **Correction WO-1.2-A-CP (finding 4):** the original text said
> revision-requesting "opens the guidance draft", which readers
> implemented as *opening the form marks terminal state*. The binding
> rule is: **opening or cancelling Revise is UI state only** — no
> review row, no state change, no queue effect; the version stays
> `AWAITING_REVIEW` and remains approvable. The **explicit submission
> boundary** is a revision submit from an eligible awaiting-review parent, which atomically (a)
> appends the `REVISION_REQUESTED` review and freezes the parent, (b)
> persists the immutable guidance record (§6), and (c) enqueues the
> child run. A Revise-submit racing an approval resolves by the
> existing `row_version` compare-and-swap: the loser gets a conflict
> with its draft inputs preserved, never a half-applied review. Ordinary
> new-version generation from an approved or declined parent preserves its
> terminal review state; it does not append an illegal revision transition.
- Eligibility no longer means "is the active pointer": any
  `AWAITING_REVIEW` version whose JD/profile inputs are current is
  reviewable. Stale ones stay previewable with an explanation and a
  new-version action. Concurrent runs must not let a stale completion
  undo a human review (§7 fencing).

## 5. Supported commands (target)

| Command | Inputs | Effects |
|---|---|---|
| Generate resume (first version) | Expected row/version, concrete profile version, JD snapshot, keyword selections, directives, request identity | Server preflight first (selected profile has an active usable evidence version, JD available, intended provider configured — actionable setup errors, no futile work item, no worker harm), then persists immutable guidance (§6), enqueues one run, `READY → PENDING`. Worker-side checks stay for races |
| Generate new version | Above + parent version + revision note | Same; parent/start inputs shown as history, never rebuilt from defaults |
| Retry failed attempt | Work item id | Requeues the same bound inputs under R-ADR-011 budget extension; never retargets |
| Revise (open guidance) | Version id | Opens the guidance draft; persists nothing until submit (see §4 correction). Cancel leaves version, job, and history untouched |
| Decline version | Version id + required note | Marks `DECLINED`, appends review; queues nothing; board untouched |
| Approve exact version | Version id + observed row version | Re-hashes artifacts, validates facts, appends review, sets selected pointer, applies §2 board rule |
| Use these settings again | Version id | Prefills a new guidance draft from recorded inputs; starts nothing; missing legacy history reported truthfully |
| Record application | Observed row version, `applied_at`, optional confirmation | Manual `applications` row bound to the then-selected approved version id (`NULL` = not recorded); immutable afterwards |

The client can never supply trusted hashes, snapshot bytes, approval
fields, template paths, or output paths: the server builds and binds
every trusted value. Double-submits reuse the request identity;
deliberate re-submits mint a new one (§7).

## 6. Immutable lineage (target)

`generation_requests` (**new table**, designed here, migrated by
`WO-1.2-D` after `0006`): `id`, `job_id`, `parent_version_id` (nullable),
`profile_version_id`, `jd_snapshot_id`, `steering_snapshot_json`
(versioned: executive narrative + relevant work-preference metadata as
submitted), `selected_keywords_json` (canonical set semantics: sorted,
deduped — cosmetic chip reorder never forks identity),
`directives_text`, `revision_note` (nullable), `request_identity`
(unique), `payload_hash`, `created_at`. Queue payload `tailor-queue/v2`
carries the request id plus snapshot hashes; the worker revalidates
every binding before executing; the provider input embeds the steering
snapshot as subordinate steering (R-ADR-017); the analysis records
`input_hash` over the same bytes; the version points at the analysis.
Keyword-selection order, profile-default flips, and master edits after
submission cannot alter a bound request. Legacy versions without
recorded guidance display "not recorded for this version" — history is
never reconstructed from current settings.

> **Correction WO-1.2-A-CP (finding 6): durable request → work →
> analysis → resume relationship.** A hash alone is not a retrieval
> relationship, so D's `0007` records these explicit links for every
> post-upgrade generation (all `WO-1.2-D`):
>
> - `generation_requests.id` (primary key) is the durable request
>   identity. The TAILOR `work_items` row binds it twice: the
>   `idempotency_key` is `genreq:v1:{requestId}` (so double-submit
>   dedupes by identity, §7), and the `tailor-queue/v2` payload embeds
>   `generation_request_id` plus `payload_hash`. The worker resolves
>   the request row by that id at claim time and refuses the item when
>   the row is missing or the hash mismatches.
> - `job_analyses` gains `generation_request_id` (nullable for legacy
>   rows; foreign key to `generation_requests.id`). All D-written
>   analyses populate it. A trigger rejects a `NULL` value whenever the
>   row's `work_attempt_id` references a `tailor-queue/v2` execution,
>   so new rows cannot silently drop the link while legacy rows stay
>   untouched.
> - `job_analyses.work_attempt_id` (existing, nullable, today never
>   populated — `insertAnalysis` takes no attempt) is populated for
>   every D-written analysis with the executing attempt's id. The same
>   v2-execution trigger class requires it. Legacy `NULL`s are kept.
> - `resume_versions.analysis_id` (existing `NOT NULL` foreign key) is
>   unchanged and completes the chain.
>
> Retrieval paths: request → run =
> `generation_requests` → `work_items` by id/payload id →
> `work_attempts` by `work_item_id`; run → outputs = `work_attempts`
> → `job_analyses` by `work_attempt_id` (and `generation_request_id`)
> → `resume_versions` by `analysis_id`. I proves every join over the
> [user-journey fixtures](acceptance-v1.2.md#user-journey); a version whose analysis lacks both links
> displays "not recorded for this version".

## 7. Deduplication and staleness fencing

- Double-click / retry / redelivery: same `request_identity` → the
  existing work item is returned or requeued; no second version.
- Deliberate later request, even with byte-identical guidance: new
  `request_identity` → new run → new child version.
- Completion fencing compares lease token, input hashes, job
  `row_version`, active extraction, and snapshot pointers before
  attaching output. Stale work is retained as an unattached attempt and
  surfaces an actionable message; it can never resurrect, mutate, or
  undo a human review, approval, decline, or recorded application.
- Rejection during work cancels/fences queued items as today; starting
  a concurrent run never lets the older completion win over newer human
  state.

## 8. Pointer semantics (target, exact)

- `jobs.active_resume_version_id`: latest published version. Written
  only at publish. Drives "latest draft" display and board badges.
- `jobs.selected_resume_version_id` (**new**, `WO-1.2-D`): approved
  version selected for application. Written only by the approval
  transaction. `NULL` until the first approval. Drives "approved for
  application" display.
- `applications.resume_version_id` (**new nullable**, `WO-1.2-D`):
  approved version bound at manual record time, copied from the then
  selected pointer; `NULL` means "not recorded". All pre-v1.2 rows stay
  `NULL`; D must not infer the newest version. The column plus
  `applied_at` and `confirmation_number` are immutable once recorded.

> **Correction WO-1.2-A-CP (finding 5a): evidence-based
> selected-pointer initialization.** D's `0007` backfills
> `jobs.selected_resume_version_id` for pre-v1.2 jobs from approval
> evidence only — never from "newest version". For each job, the
> evidence set is: `resume_reviews` rows with `action = APPROVED` and
> `actor = human` joined to that job's `resume_versions`, plus
> `workflow_events` with `reason = approval` whose metadata names
> `resumeVersionId`/`reviewId`. Rule: when exactly one human APPROVED
> review binds one version of the job, and every approval event for
> the job agrees on that version, the pointer is set to it; any other
> case (zero, multiple, or disagreeing evidence) leaves `NULL`
> (honest unknown, selectable again by a new explicit approval). The
> rule is status-independent (it covers `Tailored`/`Applied`/
> `Interviewed` alike) and deterministic pure SQL documented in the
> migration comments; I verifies before/after counts and spot-checks
> the evidence rows. `applications.resume_version_id` is always left
> `NULL` for pre-v1.2 rows — unknown legacy associations stay
> unknown.

## 9. Legacy queue upgrade policy (executed by `WO-1.2-D`)

1. Preserve every `work_attempts` row, `resume_*` row, artifact file,
   and approval/application record. Nothing is rewritten or deleted.
2. At upgrade, move every `QUEUED` TAILOR item with a v1 payload
   (`tailor:v1:*`, `tailor-guide:v1:*`, `tailor-rev:v1:*` keys) to
   `CANCELLED` — v1 payloads cannot satisfy v1.2 binding, so no legacy
   item is guessed to be an explicit request. Each cancellation appends
   one `work_attempts` row (`result = BLOCKED`,
   `error_code = LEGACY_AUTO_CANCELLED`, next attempt number per
   R-ADR-011, worker `upgrade-v1.2`) with an actionable message telling
   the user to start generation explicitly. `QUEUED` SCRAPE items are
   untouched; scraping is unchanged.
3. Never touch `RUNNING` rows in the upgrade: leases are recovered by
   the existing stale-lease path, and completion fencing (§7) plus a
   payload-version guard decide the outcome. Post-upgrade, the TAILOR
   handler refuses to execute or attach any `tailor-queue/v1` payload:
   such completions are recorded as unattached attempts and the job
   lands `FAILED` with `STALE_INPUT` and an actionable re-submit
   message. Legacy items are not retryable — retry returns a conflict
   directing to a new explicit request.
4. Jobs left with no queued work and an extracted JD land in `READY`
   (see §3); jobs mid-review keep their review state.

> **Correction WO-1.2-A-CP (finding 5b): quiescence and old-worker
> exclusion.** A new-worker payload guard cannot govern an
> already-running old process, so the upgrade procedure (executed by
> D's migration path and verified by I) is:
>
> 1. **Stop:** shut down every supervisor and separately-started worker
>    (`SIGTERM`, then the supervisor's grace/`SIGKILL`). The worker
>    already drains its dispatch loop on `SIGTERM` (`src/worker/main.ts`)
>    instead of claiming new items.
> 2. **Drain:** with no worker alive, confirm no `RUNNING` row holds an
>    unexpired lease; if any does, wait past `lease_expires_at` (leases
>    cannot be extended without a live worker). `RUNNING` rows are still
>    never force-cleared — R-ADR-011 holds.
> 3. **Migrate:** run the pending migrations (`0006`, then `0007`),
>    which now observe a quiesced queue. `0007` performs the §9
>    `QUEUED`→`CANCELLED` step plus the §8 pointer backfill.
> 4. **Start:** boot the new supervisor, which applies migrations
>    before spawning children (`scripts/start.mjs`, `scripts/dev.mjs`).
>    D extends the worker's existing `assertMigrated` startup check to
>    require the v1.2 schema markers (the `generation_requests`
>    table): a new worker never runs against a pre-`0007` database,
>    and fails loudly instead of silently running old logic.
> 5. **Recover:** `RUNNING` rows left by a crash (expired leases, no
>    live owner) follow the existing stale-lease recovery into
>    `QUEUED`, where the new worker's v1-payload guard (§9 step 3)
>    refuses them as un-executable legacy work — they complete as
>    unattached attempts with `STALE_INPUT`, never as attached
>    versions. Crash recovery therefore cannot resurrect generation
>    the user never requested. Refused items always land terminal with
>    an unattached attempt row — never back in `QUEUED` — so the guard
>    cannot wedge the queue.
>
> **Required proof, D9:** separately-started old binaries after migration
> (operator error/downgrade) do not execute new payload guards. D must
> define and verify an enforceable exclusion/claim-and-publication mechanism
> against the old binary, or fail closed before migration. Do not claim
> that new-worker code alone prevents old-worker writes. Record the mechanism
> and its test before accepting this upgrade path.

## 10. Migration ownership and numbering

Verified baseline: `drizzle/0000` … `drizzle/0005` (latest:
`0005_multi_candidate_profiles.sql`). No order re-edits an applied
migration.

| Migration | Owner | Contents |
|---|---|---|
| `0006_*` | `WO-1.2-B` | Profile field inventory, profile/version-owned source metadata + immutable bytes layout, fact-reuse provenance support (including the B6 `Create from existing profile` copy path — no separate migration), historic steering metadata; data migration keeps stored active payloads authoritative and preserves the legacy file as evidence |
| `0007_*` | `WO-1.2-D` (after B completes) | `generation_requests`, `READY`/`DECLINED` `CHECK` extensions, `jobs.selected_resume_version_id` + evidence backfill (§8), `applications.resume_version_id`, `job_analyses` linkage columns/triggers (§6), §9 legacy-queue data upgrade; command/state-machine changes ride the same order |

`WO-1.2-A/C/E/F/G/H/I/J` create no migrations. E versions its
extraction/matching policy inside input lineage, not in schema. F adds
at most immutable companion preview metadata (none expected). G touches
only `.env.local`. Every migration keeps short synchronous transactions,
parameterized statements, and a verified pre-upgrade backup with a
restore rollback procedure.

## 11. Explicitly out of this contract

Deferred per the work orders (still visible, never silently dropped):
Compact Technical / Executive Narrative output templates ([builder scope](work-orders-v1.2.md#2-release-contract), single
standard template stays); arbitrary Markdown/YAML import and DOCX/PDF
parsing ([builder scope](work-orders-v1.2.md#2-release-contract), JSON + structured form + Markdown export instead);
pixel-exact DOCX emulation (WO-1.2-F, labeled content preview + original
access instead). No discovery, scheduling, cloud sync, email, autofill,
or new board columns: the AGENTS.md boundary holds.

## 12. Implementation conformance gates

D9 in [acceptance-v1.2.md](acceptance-v1.2.md#wo-12-d) makes two linkage obligations explicit: omission of both nullable analysis references must not bypass the v2 requirement, and the executing attempt must exist at the required publication point without rewriting an append-only completed attempt. The current proposal that identifies v2 only through a nullable attempt link is not by itself proof of either property. D must finalize the discriminant, constraints and publication order before implementing the migration; keep legacy unknown lineage distinguishable from malformed new records. This clarifies the existing durable-lineage requirement, not a second request store.
