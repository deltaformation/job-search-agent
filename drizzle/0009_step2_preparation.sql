-- Migration: 0009_step2_preparation.sql
-- WO-1.3-S2-B (Step 2 scope; S2-A contracts §3): intake-bound
-- preparation storage — one preparation row per intake-bound job,
-- append-only accepted-plan history, fenced preparation progress
-- events, persisted draft validations, and the immutable edited-plan
-- generation-input extension (written by S2-D) — plus the PREPARE
-- queue kind, its payload guard, and one-live-PREPARE-per-job
-- uniqueness.
--
-- DDL follows docs/contracts/v1.3-step2-contracts.md §3 with the
-- recorded S2-B amendments (lease-token/work-item event columns,
-- byte-length caps, 0008 CHECK phrasing). Preconditions:
-- migrations 0000..0008 applied; supervised web/worker stopped; zero
-- RUNNING work rows of any kind, refused by the upgrade preflight
-- (src/db/migrate.ts) before applying. No existing-row backfill:
-- all new tables start empty, legacy jobs gain no preparation rows,
-- and every historical record is unchanged.
--
-- SQLite cannot alter the work_items kind CHECK, so the table is
-- rebuilt exactly as 0005 rebuilt candidate_profiles: new table,
-- copied rows, drop, rename. CHECK expressions name their columns
-- unqualified on purpose: a table-qualified reference would not
-- survive the rename (see the 0005 header). Dropping the table also
-- drops its four indexes, the one-live-TAILOR index, and its two
-- triggers, all recreated below alongside the new PREPARE index
-- and payload guard. The 0008 v13_progress_fence trigger names
-- work_items from another table, so it is dropped before the
-- rebuild and recreated byte-identical afterwards; the rename
-- cannot run while it exists.

DROP TRIGGER v13_progress_fence;

CREATE TABLE `work_items_new` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`job_id` text,
	`intake_item_id` text,
	`payload_json` text,
	`state` text DEFAULT 'QUEUED' NOT NULL,
	`lease_token` text,
	`leased_at` text,
	`lease_expires_at` text,
	`worker_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_run_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`current_attempt_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intake_item_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_items_kind" CHECK(`kind` IN ('SCRAPE','TAILOR','PREPARE')),
	CONSTRAINT "work_items_state" CHECK(`state` IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
	CONSTRAINT "work_items_lease_iff_running" CHECK((`state` = 'RUNNING') = (`lease_token` IS NOT NULL)),
	CONSTRAINT "work_items_attempt_count" CHECK(`attempt_count` >= 0),
	CONSTRAINT "work_items_max_attempts" CHECK(`max_attempts` >= 1)
);

INSERT INTO `work_items_new` (`id`, `kind`, `idempotency_key`, `job_id`, `intake_item_id`, `payload_json`, `state`, `lease_token`, `leased_at`, `lease_expires_at`, `worker_id`, `attempt_count`, `max_attempts`, `next_run_at`, `created_at`, `updated_at`, `current_attempt_id`)
	SELECT `id`, `kind`, `idempotency_key`, `job_id`, `intake_item_id`, `payload_json`, `state`, `lease_token`, `leased_at`, `lease_expires_at`, `worker_id`, `attempt_count`, `max_attempts`, `next_run_at`, `created_at`, `updated_at`, `current_attempt_id` FROM `work_items`;

DROP TABLE `work_items`;
ALTER TABLE `work_items_new` RENAME TO `work_items`;

CREATE UNIQUE INDEX `work_items_idempotency_key_unique` ON `work_items` (`idempotency_key`);
CREATE INDEX `work_items_state_next_run` ON `work_items` (`state`,`next_run_at`);
CREATE INDEX `work_items_job_id` ON `work_items` (`job_id`);
CREATE INDEX `work_items_intake_item_id` ON `work_items` (`intake_item_id`);
CREATE UNIQUE INDEX v13_one_live_tailor ON work_items(job_id)
 WHERE kind='TAILOR' AND state IN ('QUEUED','RUNNING');
CREATE UNIQUE INDEX v13_one_live_prepare ON work_items(job_id)
 WHERE kind='PREPARE' AND state IN ('QUEUED','RUNNING');
CREATE TRIGGER `trg_work_items_no_delete` BEFORE DELETE ON `work_items`
BEGIN SELECT RAISE(ABORT, 'work_items cannot be deleted'); END;
CREATE TRIGGER trg_work_items_no_legacy_tailor BEFORE INSERT ON work_items
WHEN NEW.kind='TAILOR' AND CASE WHEN COALESCE(json_valid(NEW.payload_json),0)=0 THEN 1
ELSE COALESCE(json_extract(NEW.payload_json,'$.schemaVersion'),'') NOT IN ('tailor-queue/v2','tailor-queue/v3') END
BEGIN SELECT RAISE(ABORT,'UNSUPPORTED_TAILOR_PAYLOAD'); END;
CREATE TRIGGER trg_work_items_no_legacy_prepare BEFORE INSERT ON work_items
WHEN NEW.kind='PREPARE' AND CASE WHEN COALESCE(json_valid(NEW.payload_json),0)=0 THEN 1
ELSE COALESCE(json_extract(NEW.payload_json,'$.schemaVersion'),'') NOT IN ('prepare-queue/v1') END
BEGIN SELECT RAISE(ABORT,'PREPARE_PAYLOAD_VERSION'); END;
CREATE TRIGGER v13_progress_fence BEFORE INSERT ON generation_progress_events
BEGIN
 SELECT RAISE(ABORT,'LEASE_LOST') WHERE NOT EXISTS(
  SELECT 1 FROM work_items w JOIN work_attempts a ON a.id=w.current_attempt_id
  JOIN generation_requests r ON r.work_item_id=w.id
  WHERE r.id=NEW.request_id AND w.id=NEW.work_item_id AND w.kind='TAILOR'
   AND w.state='RUNNING' AND a.id=NEW.attempt_id AND a.result='RUNNING'
   AND w.lease_token=NEW.lease_token AND r.status='RUNNING'
   AND julianday(w.lease_expires_at)>julianday(NEW.recorded_at)
   AND julianday(NEW.recorded_at)>=julianday(a.started_at));
 SELECT RAISE(ABORT,'PROGRESS_SEQUENCE_INVALID') WHERE NEW.seq!=1+COALESCE(
  (SELECT MAX(seq) FROM generation_progress_events WHERE attempt_id=NEW.attempt_id),0);
 SELECT RAISE(ABORT,'PROGRESS_STAGE_INVALID') WHERE NEW.seq!=CASE NEW.stage
  WHEN 'PREPARING_INPUTS' THEN 1 WHEN 'WAITING_FOR_PROVIDER' THEN 2
  WHEN 'VALIDATING_PROPOSAL' THEN 3 WHEN 'RENDERING_ARTIFACTS' THEN 4
  WHEN 'PUBLISHING_RESULT' THEN 5 END;
 SELECT RAISE(ABORT,'PROGRESS_TIME_INVALID') WHERE julianday(NEW.recorded_at)<COALESCE(
  (SELECT MAX(julianday(recorded_at)) FROM generation_progress_events WHERE attempt_id=NEW.attempt_id),julianday(NEW.recorded_at));
 SELECT RAISE(ABORT,'PROGRESS_SOURCE_INVALID') WHERE EXISTS(
  SELECT 1 FROM generation_progress_events WHERE attempt_id=NEW.attempt_id AND source!=NEW.source);
END;

CREATE TABLE step2_preparations (
 id TEXT PRIMARY KEY NOT NULL,
 intake_item_id TEXT UNIQUE REFERENCES intake_items(id),
 job_id TEXT UNIQUE REFERENCES jobs(id),
 batch_id TEXT REFERENCES intake_batches(id),
 profile_id TEXT NOT NULL REFERENCES candidate_profiles(id),
 profile_version_id TEXT NOT NULL REFERENCES candidate_profile_versions(id),
 extraction_id TEXT REFERENCES job_extractions(id),
 profile_payload_hash TEXT NOT NULL CONSTRAINT s2_prep_payload_hash CHECK(length(profile_payload_hash)=64 AND profile_payload_hash NOT GLOB '*[^0-9a-f]*'),
 evidence_hash TEXT NOT NULL CONSTRAINT s2_prep_evidence_hash CHECK(length(evidence_hash)=64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
 master_source_id TEXT REFERENCES candidate_sources(id),
 binding_json TEXT NOT NULL CONSTRAINT s2_prep_binding_bytes CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=8192),
 state TEXT NOT NULL DEFAULT 'PENDING' CONSTRAINT s2_prep_state CHECK(state IN ('PENDING','QUEUED','RUNNING','SUCCEEDED','FAILED')),
 work_item_id TEXT UNIQUE REFERENCES work_items(id),
 accepted_plan_id TEXT REFERENCES step2_plans(id),
 last_operation_id TEXT,
 last_operation_hash TEXT CONSTRAINT s2_prep_op_hash CHECK(last_operation_hash IS NULL OR (length(last_operation_hash)=64 AND last_operation_hash NOT GLOB '*[^0-9a-f]*')),
 failure_json TEXT CONSTRAINT s2_prep_failure_bytes CHECK(failure_json IS NULL OR (json_valid(failure_json) AND length(CAST(failure_json AS BLOB))<=8192)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CONSTRAINT s2_prep_op_pair CHECK((last_operation_id IS NULL)=(last_operation_hash IS NULL)),
 CONSTRAINT s2_prep_accepted_state CHECK(accepted_plan_id IS NULL OR state IN ('SUCCEEDED','QUEUED','RUNNING','FAILED')),
 CONSTRAINT s2_prep_times CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL)
);
CREATE INDEX s2_preparations_job_id ON step2_preparations(job_id);
CREATE INDEX s2_preparations_batch_id ON step2_preparations(batch_id);
CREATE INDEX s2_preparations_state ON step2_preparations(state);
CREATE TRIGGER s2_prep_no_delete BEFORE DELETE ON step2_preparations
BEGIN SELECT RAISE(ABORT,'PREPARATION_IMMUTABLE'); END;
CREATE TRIGGER s2_prep_accepted_forward BEFORE UPDATE OF accepted_plan_id ON step2_preparations
WHEN NEW.accepted_plan_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM step2_plans n
 WHERE n.id=NEW.accepted_plan_id AND n.preparation_id=NEW.id
  AND (OLD.accepted_plan_id IS NULL OR n.plan_seq>(SELECT plan_seq FROM step2_plans WHERE id=OLD.accepted_plan_id)))
BEGIN SELECT RAISE(ABORT,'PLAN_POINTER_BACKWARD'); END;
CREATE TRIGGER s2_prep_binding_locked BEFORE UPDATE OF intake_item_id,batch_id,profile_id,profile_version_id,profile_payload_hash,evidence_hash,master_source_id,binding_json ON step2_preparations
BEGIN SELECT RAISE(ABORT,'BINDING_IMMUTABLE'); END;

CREATE TABLE step2_plans (
 id TEXT PRIMARY KEY NOT NULL,
 preparation_id TEXT NOT NULL REFERENCES step2_preparations(id),
 plan_seq INTEGER NOT NULL CONSTRAINT s2_plan_seq CHECK(plan_seq>=1),
 plan_json TEXT NOT NULL CONSTRAINT s2_plan_bytes CHECK(json_valid(plan_json) AND length(CAST(plan_json AS BLOB))<=65536),
 plan_hash TEXT NOT NULL CONSTRAINT s2_plan_hash CHECK(length(plan_hash)=64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
 provider_id TEXT NOT NULL,
 model TEXT,
 prompt_version TEXT NOT NULL,
 proposal_schema_version TEXT NOT NULL,
 claims_policy_version TEXT NOT NULL,
 input_hash TEXT NOT NULL CONSTRAINT s2_plan_input_hash CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
 proposal_hash TEXT NOT NULL CONSTRAINT s2_plan_proposal_hash CHECK(length(proposal_hash)=64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'),
 attempt_id TEXT NOT NULL,
 validation_json TEXT NOT NULL CONSTRAINT s2_plan_validation_bytes CHECK(json_valid(validation_json) AND length(CAST(validation_json AS BLOB))<=65536),
 supersedes_plan_id TEXT REFERENCES step2_plans(id),
 created_at TEXT NOT NULL,
 UNIQUE(preparation_id,plan_seq),
 FOREIGN KEY(attempt_id) REFERENCES work_attempts(id),
 CONSTRAINT s2_plan_versions CHECK(prompt_version='prepare-prompt/v1' AND proposal_schema_version='preparation-proposal/v1' AND claims_policy_version='step2-claims/1'),
 CONSTRAINT s2_plan_time CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL)
);
CREATE INDEX s2_plans_preparation_id ON step2_plans(preparation_id);
CREATE UNIQUE INDEX s2_plans_hash ON step2_plans(preparation_id,plan_hash);
CREATE TRIGGER s2_plan_no_update BEFORE UPDATE ON step2_plans
BEGIN SELECT RAISE(ABORT,'PLAN_IMMUTABLE'); END;
CREATE TRIGGER s2_plan_no_delete BEFORE DELETE ON step2_plans
BEGIN SELECT RAISE(ABORT,'PLAN_IMMUTABLE'); END;
CREATE TRIGGER s2_plan_owner BEFORE INSERT ON step2_plans
WHEN NEW.supersedes_plan_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM step2_plans s
 WHERE s.id=NEW.supersedes_plan_id AND s.preparation_id=NEW.preparation_id AND s.plan_seq<NEW.plan_seq)
BEGIN SELECT RAISE(ABORT,'PLAN_PREPARATION_MISMATCH'); END;

CREATE TABLE step2_preparation_events (
 attempt_id TEXT NOT NULL,
 seq INTEGER NOT NULL CONSTRAINT s2_event_seq CHECK(seq BETWEEN 1 AND 5),
 preparation_id TEXT NOT NULL REFERENCES step2_preparations(id),
 work_item_id TEXT NOT NULL REFERENCES work_items(id),
 stage TEXT NOT NULL CONSTRAINT s2_event_stage CHECK(stage IN ('LOADING_INPUTS','WAITING_FOR_PROVIDER','VALIDATING_PROPOSAL','STORING_PLAN','PUBLISHING_PLAN')),
 source TEXT NOT NULL CONSTRAINT s2_event_source CHECK(source IN ('provider','cached')),
 lease_token TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(attempt_id,seq),
 CONSTRAINT s2_event_unique_stage UNIQUE(attempt_id,stage),
 FOREIGN KEY(attempt_id,work_item_id) REFERENCES work_attempts(id,work_item_id),
 CONSTRAINT s2_event_time CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS NOT NULL)
);
CREATE INDEX s2_events_preparation_id ON step2_preparation_events(preparation_id);
CREATE TRIGGER s2_event_fence BEFORE INSERT ON step2_preparation_events
BEGIN
 SELECT RAISE(ABORT,'LEASE_LOST') WHERE NOT EXISTS(
  SELECT 1 FROM work_items w JOIN work_attempts a ON a.id=w.current_attempt_id
  JOIN step2_preparations p ON p.work_item_id=w.id
  WHERE p.id=NEW.preparation_id AND w.id=NEW.work_item_id AND w.kind='PREPARE'
   AND w.state='RUNNING' AND a.id=NEW.attempt_id AND a.result='RUNNING'
   AND w.lease_token=NEW.lease_token AND p.state='RUNNING'
   AND julianday(w.lease_expires_at)>julianday(NEW.recorded_at)
   AND julianday(NEW.recorded_at)>=julianday(a.started_at));
 SELECT RAISE(ABORT,'PREP_PROGRESS_SEQUENCE') WHERE NEW.seq!=1+COALESCE(
  (SELECT MAX(seq) FROM step2_preparation_events WHERE attempt_id=NEW.attempt_id),0);
 SELECT RAISE(ABORT,'PREP_PROGRESS_STAGE') WHERE NEW.seq!=CASE NEW.stage
  WHEN 'LOADING_INPUTS' THEN 1 WHEN 'WAITING_FOR_PROVIDER' THEN 2
  WHEN 'VALIDATING_PROPOSAL' THEN 3 WHEN 'STORING_PLAN' THEN 4
  WHEN 'PUBLISHING_PLAN' THEN 5 END;
 SELECT RAISE(ABORT,'PREP_PROGRESS_TIME') WHERE julianday(NEW.recorded_at)<COALESCE(
  (SELECT MAX(julianday(recorded_at)) FROM step2_preparation_events WHERE attempt_id=NEW.attempt_id),julianday(NEW.recorded_at));
 SELECT RAISE(ABORT,'PREP_PROGRESS_SOURCE') WHERE EXISTS(
  SELECT 1 FROM step2_preparation_events WHERE attempt_id=NEW.attempt_id AND source!=NEW.source);
END;
CREATE TRIGGER s2_event_no_update BEFORE UPDATE ON step2_preparation_events
BEGIN SELECT RAISE(ABORT,'PREP_PROGRESS_IMMUTABLE'); END;
CREATE TRIGGER s2_event_no_delete BEFORE DELETE ON step2_preparation_events
BEGIN SELECT RAISE(ABORT,'PREP_PROGRESS_IMMUTABLE'); END;

CREATE TABLE step2_draft_validations (
 id TEXT PRIMARY KEY NOT NULL,
 job_id TEXT NOT NULL REFERENCES jobs(id),
 plan_id TEXT NOT NULL REFERENCES step2_plans(id),
 workspace_revision INTEGER NOT NULL CONSTRAINT s2_verdict_revision CHECK(workspace_revision>=1),
 draft_hash TEXT NOT NULL CONSTRAINT s2_verdict_hash CHECK(length(draft_hash)=64 AND draft_hash NOT GLOB '*[^0-9a-f]*'),
 verdict_json TEXT NOT NULL CONSTRAINT s2_verdict_bytes CHECK(json_valid(verdict_json) AND length(CAST(verdict_json AS BLOB))<=65536),
 policy_version TEXT NOT NULL CONSTRAINT s2_verdict_policy CHECK(policy_version='step2-claims/1'),
 created_at TEXT NOT NULL CONSTRAINT s2_verdict_time CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL)
);
CREATE INDEX s2_verdicts_job_hash ON step2_draft_validations(job_id,draft_hash);
CREATE INDEX s2_verdicts_plan_id ON step2_draft_validations(plan_id);
CREATE TRIGGER s2_verdict_no_update BEFORE UPDATE ON step2_draft_validations
BEGIN SELECT RAISE(ABORT,'VERDICT_IMMUTABLE'); END;
CREATE TRIGGER s2_verdict_no_delete BEFORE DELETE ON step2_draft_validations
BEGIN SELECT RAISE(ABORT,'VERDICT_IMMUTABLE'); END;

CREATE TABLE step2_generation_inputs (
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES generation_requests(id),
 plan_id TEXT NOT NULL REFERENCES step2_plans(id),
 plan_hash TEXT NOT NULL CONSTRAINT s2_gen_plan_hash CHECK(length(plan_hash)=64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
 draft_hash TEXT NOT NULL CONSTRAINT s2_gen_draft_hash CHECK(length(draft_hash)=64 AND draft_hash NOT GLOB '*[^0-9a-f]*'),
 validation_id TEXT NOT NULL REFERENCES step2_draft_validations(id),
 edited_inputs_json TEXT NOT NULL CONSTRAINT s2_gen_inputs_bytes CHECK(json_valid(edited_inputs_json) AND length(CAST(edited_inputs_json AS BLOB))<=65536),
 policy_versions_json TEXT NOT NULL CONSTRAINT s2_gen_policy_bytes CHECK(json_valid(policy_versions_json) AND length(CAST(policy_versions_json AS BLOB))<=2048),
 created_at TEXT NOT NULL CONSTRAINT s2_gen_time CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL)
);
CREATE TRIGGER s2_gen_no_update BEFORE UPDATE ON step2_generation_inputs
BEGIN SELECT RAISE(ABORT,'S2_INPUT_IMMUTABLE'); END;
CREATE TRIGGER s2_gen_no_delete BEFORE DELETE ON step2_generation_inputs
BEGIN SELECT RAISE(ABORT,'S2_INPUT_IMMUTABLE'); END;
CREATE TRIGGER s2_gen_owner BEFORE INSERT ON step2_generation_inputs
WHEN NOT EXISTS(
 SELECT 1 FROM step2_plans pl JOIN step2_preparations p ON p.id=pl.preparation_id
 JOIN generation_requests r ON r.job_id=p.job_id
 JOIN step2_draft_validations v ON v.id=NEW.validation_id
 WHERE r.id=NEW.request_id AND pl.id=NEW.plan_id AND p.job_id IS NOT NULL
  AND v.plan_id=NEW.plan_id AND v.draft_hash=NEW.draft_hash)
BEGIN SELECT RAISE(ABORT,'S2_INPUT_PLAN_MISMATCH'); END;
