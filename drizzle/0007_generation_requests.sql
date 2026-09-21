-- Migration: 0007_generation_requests.sql
-- WO-1.2-D (R-ADR-015, R-ADR-017, R-ADR-018, R-ADR-019): explicit
-- generation requests with durable request -> work -> analysis ->
-- resume linkage, READY/DECLINED states, approval-selection pointers,
-- and the v1.2 legacy-queue upgrade.
--
-- Schema (all new objects):
-- - `generation_requests`: one immutable row per explicit human
--   generation command (INITIAL / NEW_VERSION / REVISION) with the
--   pinned profile version, JD snapshot, frozen steering, canonical
--   keywords, directives, revision note, parent version, unique
--   request identity, and payload hash. Only execution bookkeeping
--   (status, work_item_id, started/finished/error, updated_at) may
--   change after insert; everything else is frozen by trigger.
-- - `job_analyses.generation_request_id` (nullable for pre-upgrade
--   rows) + UNIQUE index (one analysis per request; legacy NULLs
--   coexist). A BEFORE INSERT trigger rejects EVERY new row whose
--   linkage is incomplete (either field NULL).
-- - `resume_versions.generation_request_id` + `work_attempt_id`
--   (nullable for pre-upgrade rows). Same INSERT-time completeness
--   trigger as analyses: every version written after this migration
--   names the exact request and attempt that produced it.
-- - `work_items.current_attempt_id`: attempt id minted at claim so the
--   handler can reference its executing attempt before the dispatcher
--   writes the append-only attempt row. No trigger: mutable by design.
-- - `jobs.selected_resume_version_id` + `applications.resume_version_id`
--   (both nullable; §8 pointer semantics), with same-job ownership
--   triggers on the selected pointer.
-- - CHECK extensions: `jobs_tailoring_state` gains READY/DECLINED,
--   `resume_versions_review_state` gains DECLINED, and
--   `resume_reviews_action` gains DECLINED (table rebuilds; SQLite
--   cannot ALTER a CHECK).
--
-- Contract amendment (§12, authorized by D9): the lifecycle draft
-- proposed rejecting NULL linkage only when the attempt references a
-- v2 execution. That discriminant cannot exist at INSERT time: under
-- append-only completion the attempt row is written after publication,
-- so no trigger can observe it. The finalized rule is temporal — new
-- rows must be complete, pre-upgrade NULL rows stay untouched — which
-- also fails old binaries closed: any legacy publish (both fields
-- NULL) aborts loudly instead of attaching unlinked output.
--
-- Data upgrade (§9, deterministic pure SQL):
-- - QUEUED v1 TAILOR items -> CANCELLED, each with one BLOCKED
--   LEGACY_AUTO_CANCELLED attempt row (worker 'upgrade-v1.2') telling
--   the user to start generation explicitly. QUEUED SCRAPE items are
--   untouched; RUNNING rows are never touched (stale-lease recovery
--   plus the new worker's v1-payload guard decide them).
-- - Jobs with an extracted JD and no live tailor work land in READY.
-- - `jobs.selected_resume_version_id` backfill (§8 finding 5a): set
--   only when exactly one human APPROVED review binds one version of
--   the job (content-hash agreement) AND every approval workflow
--   event for the job names that same version; otherwise NULL
--   (honest unknown). `applications.resume_version_id` is never
--   backfilled: unknown legacy associations stay unknown.
--
-- Old-binary exclusion (D9): after this migration, (1) no process can
-- enqueue v1 TAILOR work (BEFORE INSERT trigger), (2) no process can
-- publish an unlinked analysis or resume version (BEFORE INSERT
-- triggers), and (3) the new worker refuses to execute v1 payloads.
-- The upgrade procedure itself (stop/drain/migrate/start) is
-- documented in operations.md.
--
-- Attempt lifecycle (§6): claims INSERT the work_attempts row as
-- RUNNING so mid-run output can reference it; completion and stale
-- recovery UPDATE it to its terminal result exactly once. The 0001
-- append-only UPDATE trigger is replaced by a finish-once guard, and
-- the result CHECK gains RUNNING (table rebuild).

-- ---------------------------------------------------------------------------
-- work_attempts rebuild: result CHECK gains RUNNING for the claim-time
-- row, and the append-only UPDATE trigger becomes a finish-once guard
-- (RUNNING → one terminal result; every other column frozen).
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS `trg_work_attempts_no_update`;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_work_attempts_no_delete`;
--> statement-breakpoint

CREATE TABLE `work_attempts_new` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`worker_id` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`input_hash` text,
	`output_hash` text,
	`result` text NOT NULL,
	`error_code` text,
	`error_detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_attempts_number" CHECK(`attempt_number` >= 1),
	CONSTRAINT "work_attempts_result" CHECK(`result` IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED'))
);
--> statement-breakpoint

INSERT INTO `work_attempts_new` (
	`id`,`work_item_id`,`attempt_number`,`worker_id`,`started_at`,
	`finished_at`,`input_hash`,`output_hash`,`result`,`error_code`,
	`error_detail`,`created_at`
) SELECT
	`id`,`work_item_id`,`attempt_number`,`worker_id`,`started_at`,
	`finished_at`,`input_hash`,`output_hash`,`result`,`error_code`,
	`error_detail`,`created_at`
FROM `work_attempts`;
--> statement-breakpoint

DROP TABLE `work_attempts`;
--> statement-breakpoint

ALTER TABLE `work_attempts_new` RENAME TO `work_attempts`;
--> statement-breakpoint

CREATE INDEX `work_attempts_work_item_id` ON `work_attempts` (`work_item_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `work_attempts_item_number` ON `work_attempts` (`work_item_id`,`attempt_number`);
--> statement-breakpoint

CREATE TRIGGER `trg_work_attempts_finish_once` BEFORE UPDATE ON `work_attempts`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`work_item_id` IS NOT NEW.`work_item_id`
  OR OLD.`attempt_number` IS NOT NEW.`attempt_number`
  OR OLD.`worker_id` IS NOT NEW.`worker_id`
  OR OLD.`started_at` IS NOT NEW.`started_at`
  OR OLD.`created_at` IS NOT NEW.`created_at`
  OR OLD.`result` != 'RUNNING'
  OR NEW.`result` NOT IN ('SUCCEEDED','FAILED','BLOCKED')
BEGIN SELECT RAISE(ABORT, 'work attempts finish RUNNING-to-terminal exactly once'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_work_attempts_no_delete` BEFORE DELETE ON `work_attempts`
BEGIN SELECT RAISE(ABORT, 'work_attempts is append-only'); END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- New linkage columns (additive; no CHECK touched).
-- ---------------------------------------------------------------------------

ALTER TABLE `job_analyses` ADD COLUMN `generation_request_id` text REFERENCES `generation_requests`(`id`);
--> statement-breakpoint

ALTER TABLE `work_items` ADD COLUMN `current_attempt_id` text;
--> statement-breakpoint

ALTER TABLE `applications` ADD COLUMN `resume_version_id` text REFERENCES `resume_versions`(`id`);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- generation_requests: one immutable row per explicit human command.
-- ---------------------------------------------------------------------------

CREATE TABLE `generation_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`request_identity` text NOT NULL UNIQUE,
	`job_id` text NOT NULL REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	`extraction_id` text NOT NULL REFERENCES `job_extractions`(`id`) ON UPDATE no action ON DELETE no action,
	`profile_id` text NOT NULL,
	`profile_version_id` text NOT NULL,
	`jd_snapshot_id` text NOT NULL,
	`parent_version_id` text,
	`request_kind` text NOT NULL,
	`steering_snapshot_json` text NOT NULL,
	`selected_keywords_json` text NOT NULL,
	`directives_text` text,
	`revision_note` text,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`work_item_id` text REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	`error_code` text,
	`error_detail` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "generation_requests_kind" CHECK(`request_kind` IN ('INITIAL','NEW_VERSION','REVISION')),
	CONSTRAINT "generation_requests_kind_parent" CHECK(
		(`request_kind` = 'INITIAL' AND `parent_version_id` IS NULL)
		OR (`request_kind` IN ('NEW_VERSION','REVISION') AND `parent_version_id` IS NOT NULL)
	),
	CONSTRAINT "generation_requests_status" CHECK(`status` IN ('QUEUED','RUNNING','SUCCEEDED','FAILED'))
);
--> statement-breakpoint

CREATE INDEX `generation_requests_job_id` ON `generation_requests` (`job_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `job_analyses_generation_request_id` ON `job_analyses` (`generation_request_id`);
--> statement-breakpoint

-- Only execution bookkeeping may change after insert; the request
-- itself (bindings, guidance, identity, hash) is frozen.
CREATE TRIGGER `trg_generation_requests_frozen_update` BEFORE UPDATE ON `generation_requests`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`request_identity` IS NOT NEW.`request_identity`
  OR OLD.`job_id` IS NOT NEW.`job_id`
  OR OLD.`extraction_id` IS NOT NEW.`extraction_id`
  OR OLD.`profile_id` IS NOT NEW.`profile_id`
  OR OLD.`profile_version_id` IS NOT NEW.`profile_version_id`
  OR OLD.`jd_snapshot_id` IS NOT NEW.`jd_snapshot_id`
  OR OLD.`parent_version_id` IS NOT NEW.`parent_version_id`
  OR OLD.`request_kind` IS NOT NEW.`request_kind`
  OR OLD.`steering_snapshot_json` IS NOT NEW.`steering_snapshot_json`
  OR OLD.`selected_keywords_json` IS NOT NEW.`selected_keywords_json`
  OR OLD.`directives_text` IS NOT NEW.`directives_text`
  OR OLD.`revision_note` IS NOT NEW.`revision_note`
  OR OLD.`payload_hash` IS NOT NEW.`payload_hash`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN SELECT RAISE(ABORT, 'generation request bindings and guidance are immutable; submit a new request'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_generation_requests_no_delete` BEFORE DELETE ON `generation_requests`
BEGIN SELECT RAISE(ABORT, 'generation_requests cannot be deleted'); END;
--> statement-breakpoint

-- Every analysis written after this migration must carry both durable
-- links. Pre-upgrade rows keep their NULLs (the trigger fires on
-- INSERT only); legacy binaries publishing unlinked analyses abort.
CREATE TRIGGER `trg_job_analyses_require_linkage` BEFORE INSERT ON `job_analyses`
WHEN NEW.`generation_request_id` IS NULL OR NEW.`work_attempt_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'new analyses require generation_request_id and work_attempt_id'); END;
--> statement-breakpoint

-- No process may enqueue legacy v1 TAILOR work after this migration:
-- v1 payloads cannot satisfy v1.2 binding, so they are refused at the
-- database boundary (old binaries fail loudly here; new code never
-- emits them). SCRAPE rows are unaffected.
CREATE TRIGGER `trg_work_items_no_legacy_tailor` BEFORE INSERT ON `work_items`
WHEN NEW.`kind` = 'TAILOR' AND json_extract(NEW.`payload_json`, '$.schemaVersion') IS NOT 'tailor-queue/v2'
BEGIN SELECT RAISE(ABORT, 'legacy tailor payloads are disabled; start generation explicitly'); END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- jobs + resume_versions rebuilds: CHECK gains READY/DECLINED (+ the new
-- selected pointer on jobs). RENAME fails while any surviving trigger
-- references the dropped name, so cross-table triggers are dropped
-- first and EVERYTHING is recreated after both tables are restored.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS `trg_resume_claim_facts_check_membership`;
--> statement-breakpoint

CREATE TABLE `jobs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'NEW' NOT NULL,
	`rank` real DEFAULT 0 NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	`title` text,
	`company` text,
	`location` text,
	`arrangement` text,
	`salary_text` text,
	`salary_currency` text,
	`salary_min_minor` integer,
	`salary_max_minor` integer,
	`compensation_highlights_json` text,
	`description_text` text,
	`posted_at` text,
	`scrape_state` text DEFAULT 'QUEUED' NOT NULL,
	`scrape_reason_code` text,
	`tailoring_state` text DEFAULT 'PENDING' NOT NULL,
	`tailoring_reason_code` text,
	`active_extraction_id` text,
	`active_resume_version_id` text,
	`selected_resume_version_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "jobs_status" CHECK(`status` IN ('NEW','TAILORED','APPLIED','INTERVIEWED','REJECTED')),
	CONSTRAINT "jobs_row_version" CHECK(`row_version` >= 1),
	CONSTRAINT "jobs_arrangement" CHECK(`arrangement` IS NULL OR `arrangement` IN ('REMOTE','HYBRID','ONSITE','UNKNOWN')),
	CONSTRAINT "jobs_salary_nonnegative" CHECK((`salary_min_minor` IS NULL OR `salary_min_minor` >= 0) AND (`salary_max_minor` IS NULL OR `salary_max_minor` >= 0)),
	CONSTRAINT "jobs_salary_ordered" CHECK(`salary_min_minor` IS NULL OR `salary_max_minor` IS NULL OR `salary_min_minor` <= `salary_max_minor`),
	CONSTRAINT "jobs_scrape_state" CHECK(`scrape_state` IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED')),
	CONSTRAINT "jobs_tailoring_state" CHECK(`tailoring_state` IN ('PENDING','READY','BLOCKED','RUNNING','AWAITING_REVIEW','APPROVED','REVISION_REQUESTED','DECLINED','FAILED'))
);
--> statement-breakpoint

INSERT INTO `jobs_new` (
	`id`,`status`,`rank`,`row_version`,`title`,`company`,`location`,`arrangement`,
	`salary_text`,`salary_currency`,`salary_min_minor`,`salary_max_minor`,
	`compensation_highlights_json`,
	`description_text`,`posted_at`,`scrape_state`,`scrape_reason_code`,
	`tailoring_state`,`tailoring_reason_code`,`active_extraction_id`,
	`active_resume_version_id`,`created_at`,`updated_at`
) SELECT
	`id`,`status`,`rank`,`row_version`,`title`,`company`,`location`,`arrangement`,
	`salary_text`,`salary_currency`,`salary_min_minor`,`salary_max_minor`,
	`compensation_highlights_json`,
	`description_text`,`posted_at`,`scrape_state`,`scrape_reason_code`,
	`tailoring_state`,`tailoring_reason_code`,`active_extraction_id`,
	`active_resume_version_id`,`created_at`,`updated_at`
FROM `jobs`;
--> statement-breakpoint

DROP TABLE `jobs`;
--> statement-breakpoint

ALTER TABLE `jobs_new` RENAME TO `jobs`;
--> statement-breakpoint

CREATE INDEX `jobs_status_rank` ON `jobs` (`status`,`rank`);
--> statement-breakpoint

-- NOTE: jobs triggers are recreated after BOTH rebuilds (below), because
-- the active-resume ownership triggers reference resume_versions, which
-- is mid-rebuild at this point. Between here and there, no statement
-- writes jobs rows.

-- ---------------------------------------------------------------------------
-- resume_versions rebuild: review_state CHECK gains DECLINED.
-- ---------------------------------------------------------------------------

CREATE TABLE `resume_versions_new` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version_id` text,
	`analysis_id` text NOT NULL,
	`generation_request_id` text REFERENCES `generation_requests`(`id`),
	`work_attempt_id` text REFERENCES `work_attempts`(`id`),
	`template_id` text NOT NULL,
	`template_version` text NOT NULL,
	`template_hash` text NOT NULL,
	`ranker_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`config_version` text NOT NULL,
	`render_schema_version` text NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`review_state` text DEFAULT 'DRAFT' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analysis_id`) REFERENCES `job_analyses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "resume_versions_version" CHECK(`version` >= 1),
	CONSTRAINT "resume_versions_review_state" CHECK(`review_state` IN ('DRAFT','AWAITING_REVIEW','APPROVED','REVISION_REQUESTED','DECLINED','FAILED'))
);
--> statement-breakpoint

INSERT INTO `resume_versions_new` (
	`id`,`job_id`,`version`,`parent_version_id`,`analysis_id`,`template_id`,
	`template_version`,`template_hash`,`ranker_version`,`policy_version`,
	`config_version`,`render_schema_version`,`content_json`,`content_hash`,
	`review_state`,`created_at`,`updated_at`
) SELECT
	`id`,`job_id`,`version`,`parent_version_id`,`analysis_id`,`template_id`,
	`template_version`,`template_hash`,`ranker_version`,`policy_version`,
	`config_version`,`render_schema_version`,`content_json`,`content_hash`,
	`review_state`,`created_at`,`updated_at`
FROM `resume_versions`;
--> statement-breakpoint

DROP TABLE `resume_versions`;
--> statement-breakpoint

ALTER TABLE `resume_versions_new` RENAME TO `resume_versions`;
--> statement-breakpoint

CREATE INDEX `resume_versions_job_id` ON `resume_versions` (`job_id`);
--> statement-breakpoint

CREATE INDEX `resume_versions_analysis_id` ON `resume_versions` (`analysis_id`);
--> statement-breakpoint

CREATE UNIQUE INDEX `resume_versions_job_version` ON `resume_versions` (`job_id`,`version`);
--> statement-breakpoint

CREATE TRIGGER `trg_resume_versions_guard_content` BEFORE UPDATE ON `resume_versions`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`job_id` IS NOT NEW.`job_id`
  OR OLD.`version` IS NOT NEW.`version`
  OR OLD.`parent_version_id` IS NOT NEW.`parent_version_id`
  OR OLD.`analysis_id` IS NOT NEW.`analysis_id`
  OR OLD.`generation_request_id` IS NOT NEW.`generation_request_id`
  OR OLD.`work_attempt_id` IS NOT NEW.`work_attempt_id`
  OR OLD.`template_id` IS NOT NEW.`template_id`
  OR OLD.`template_version` IS NOT NEW.`template_version`
  OR OLD.`template_hash` IS NOT NEW.`template_hash`
  OR OLD.`ranker_version` IS NOT NEW.`ranker_version`
  OR OLD.`policy_version` IS NOT NEW.`policy_version`
  OR OLD.`config_version` IS NOT NEW.`config_version`
  OR OLD.`render_schema_version` IS NOT NEW.`render_schema_version`
  OR OLD.`content_json` IS NOT NEW.`content_json`
  OR OLD.`content_hash` IS NOT NEW.`content_hash`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN SELECT RAISE(ABORT, 'resume content and lineage are immutable; create a new version'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_versions_guard_approved` BEFORE UPDATE ON `resume_versions`
WHEN OLD.`review_state` = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'approved resume versions are immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_versions_guard_declined` BEFORE UPDATE ON `resume_versions`
WHEN OLD.`review_state` = 'DECLINED'
BEGIN SELECT RAISE(ABORT, 'declined resume versions are immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_versions_no_delete` BEFORE DELETE ON `resume_versions`
BEGIN SELECT RAISE(ABORT, 'resume_versions cannot be deleted'); END;
--> statement-breakpoint

-- Every version written after this migration must carry both
-- durable links, exactly like analyses (D9). Pre-upgrade rows keep
-- their NULLs; legacy binaries publishing unlinked versions abort.
CREATE TRIGGER `trg_resume_versions_require_linkage` BEFORE INSERT ON `resume_versions`
WHEN NEW.`generation_request_id` IS NULL OR NEW.`work_attempt_id` IS NULL
BEGIN SELECT RAISE(ABORT, 'new resume versions require generation_request_id and work_attempt_id'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_versions_check_lineage_job` BEFORE INSERT ON `resume_versions`
BEGIN
  SELECT RAISE(ABORT, 'resume analysis must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `job_analyses` a
    WHERE a.`id` = NEW.`analysis_id` AND a.`job_id` = NEW.`job_id`
  );
  SELECT RAISE(ABORT, 'resume parent version must belong to the same job')
  WHERE NEW.`parent_version_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `resume_versions` p
    WHERE p.`id` = NEW.`parent_version_id` AND p.`job_id` = NEW.`job_id`
  );
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- resume_reviews rebuild: action CHECK gains DECLINED for the explicit
-- human decline command (D4). The append-only triggers from 0001 are
-- dropped first (RENAME fails while they reference the table) and
-- recreated verbatim below.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS `trg_resume_reviews_no_update`;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `trg_resume_reviews_no_delete`;
--> statement-breakpoint

CREATE TABLE `resume_reviews_new` (
	`id` text PRIMARY KEY NOT NULL,
	`resume_version_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`note` text,
	`resume_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`artifact_hashes_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`resume_version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "resume_reviews_action" CHECK(`action` IN ('APPROVED','REVISION_REQUESTED','DECLINED'))
);
--> statement-breakpoint

INSERT INTO `resume_reviews_new` (
	`id`,`resume_version_id`,`action`,`actor`,`note`,`resume_hash`,
	`content_hash`,`artifact_hashes_json`,`created_at`
) SELECT
	`id`,`resume_version_id`,`action`,`actor`,`note`,`resume_hash`,
	`content_hash`,`artifact_hashes_json`,`created_at`
FROM `resume_reviews`;
--> statement-breakpoint

DROP TABLE `resume_reviews`;
--> statement-breakpoint

ALTER TABLE `resume_reviews_new` RENAME TO `resume_reviews`;
--> statement-breakpoint

CREATE INDEX `resume_reviews_version_id` ON `resume_reviews` (`resume_version_id`);
--> statement-breakpoint

CREATE TRIGGER `trg_resume_reviews_no_update` BEFORE UPDATE ON `resume_reviews`
BEGIN SELECT RAISE(ABORT, 'resume_reviews is append-only'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_reviews_no_delete` BEFORE DELETE ON `resume_reviews`
BEGIN SELECT RAISE(ABORT, 'resume_reviews is append-only'); END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recreate the jobs triggers dropped by the rebuild (verbatim) plus the
-- two new selected-pointer ownership triggers and the claim-facts
-- membership trigger dropped above. All tables exist again here.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `trg_jobs_no_delete` BEFORE DELETE ON `jobs`
BEGIN SELECT RAISE(ABORT, 'jobs cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_check_active_extraction_insert` BEFORE INSERT ON `jobs`
WHEN NEW.`active_extraction_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'active extraction must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `job_extractions` e
    WHERE e.`id` = NEW.`active_extraction_id` AND e.`job_id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_check_active_extraction_update` BEFORE UPDATE OF `active_extraction_id` ON `jobs`
WHEN NEW.`active_extraction_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'active extraction must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `job_extractions` e
    WHERE e.`id` = NEW.`active_extraction_id` AND e.`job_id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_check_active_resume_insert` BEFORE INSERT ON `jobs`
WHEN NEW.`active_resume_version_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'active resume version must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `resume_versions` v
    WHERE v.`id` = NEW.`active_resume_version_id` AND v.`job_id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_check_active_resume_update` BEFORE UPDATE OF `active_resume_version_id` ON `jobs`
WHEN NEW.`active_resume_version_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'active resume version must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `resume_versions` v
    WHERE v.`id` = NEW.`active_resume_version_id` AND v.`job_id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_check_selected_resume_insert` BEFORE INSERT ON `jobs`
WHEN NEW.`selected_resume_version_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'selected resume version must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `resume_versions` v
    WHERE v.`id` = NEW.`selected_resume_version_id` AND v.`job_id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_check_selected_resume_update` BEFORE UPDATE OF `selected_resume_version_id` ON `jobs`
WHEN NEW.`selected_resume_version_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'selected resume version must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `resume_versions` v
    WHERE v.`id` = NEW.`selected_resume_version_id` AND v.`job_id` = NEW.`id`
  );
END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_claim_facts_check_membership` BEFORE INSERT ON `resume_claim_facts`
BEGIN
  SELECT RAISE(ABORT, 'claim fact is not a member of the bound candidate snapshot')
  WHERE NOT EXISTS (
    SELECT 1 FROM `resume_claims` c
    JOIN `resume_versions` v ON v.`id` = c.`resume_version_id`
    JOIN `job_analyses` a ON a.`id` = v.`analysis_id`
    JOIN `candidate_snapshot_facts` m
      ON m.`snapshot_id` = a.`candidate_snapshot_id`
      AND m.`fact_id` = NEW.`fact_id`
    WHERE c.`id` = NEW.`claim_id`
  );
  SELECT RAISE(ABORT, 'claim fact is not approved')
  WHERE NOT EXISTS (
    SELECT 1 FROM `candidate_facts` f
    WHERE f.`fact_id` = NEW.`fact_id` AND f.`verification` = 'APPROVED'
  );
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §9 legacy-queue upgrade: QUEUED v1 TAILOR items -> CANCELLED with one
-- BLOCKED attempt row each. RUNNING rows are never touched here.
-- ---------------------------------------------------------------------------

INSERT INTO `work_attempts` (
	`id`,`work_item_id`,`attempt_number`,`worker_id`,`started_at`,`finished_at`,
	`result`,`error_code`,`error_detail`,`created_at`
)
SELECT
	lower(hex(randomblob(16))),
	wi.`id`,
	wi.`attempt_count` + 1,
	'upgrade-v1.2',
	strftime('%Y-%m-%dT%H:%M:%fZ','now'),
	strftime('%Y-%m-%dT%H:%M:%fZ','now'),
	'BLOCKED',
	'LEGACY_AUTO_CANCELLED',
	'Legacy auto-queued tailoring was cancelled by the v1.2 upgrade. Open the job and choose Generate resume to start an explicit run.',
	strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `work_items` wi
WHERE wi.`state` = 'QUEUED'
  AND wi.`kind` = 'TAILOR'
  AND wi.`idempotency_key` GLOB 'tailor*:v1:*';
--> statement-breakpoint

UPDATE `work_items`
SET `state` = 'CANCELLED', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `state` = 'QUEUED'
  AND `kind` = 'TAILOR'
  AND `idempotency_key` GLOB 'tailor*:v1:*';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §9.4: jobs with an extracted JD and no live tailor work land in READY.
-- ---------------------------------------------------------------------------

UPDATE `jobs`
SET `tailoring_state` = 'READY', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `tailoring_state` = 'PENDING'
  AND `active_extraction_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `work_items` wi
    WHERE wi.`job_id` = `jobs`.`id`
      AND wi.`kind` = 'TAILOR'
      AND wi.`state` IN ('QUEUED','RUNNING')
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §8 (finding 5a): evidence-based selected-pointer backfill. Set only
-- when exactly one human APPROVED review hash-binds one version of the
-- job AND no approval workflow event names a different (or missing)
-- version. All other cases stay NULL (honest unknown). Status-
-- independent and deterministic. applications.resume_version_id is
-- deliberately never backfilled here.
-- ---------------------------------------------------------------------------

UPDATE `jobs`
SET `selected_resume_version_id` = (
  SELECT r.`resume_version_id`
  FROM `resume_reviews` r
  JOIN `resume_versions` v ON v.`id` = r.`resume_version_id`
  WHERE v.`job_id` = `jobs`.`id`
    AND r.`action` = 'APPROVED'
    AND r.`actor` = 'human'
    AND r.`content_hash` = v.`content_hash`
  GROUP BY r.`resume_version_id`
  HAVING COUNT(*) >= 1
),
`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE (
  SELECT COUNT(DISTINCT r.`resume_version_id`)
  FROM `resume_reviews` r
  JOIN `resume_versions` v ON v.`id` = r.`resume_version_id`
  WHERE v.`job_id` = `jobs`.`id`
    AND r.`action` = 'APPROVED'
    AND r.`actor` = 'human'
    AND r.`content_hash` = v.`content_hash`
) = 1
AND NOT EXISTS (
  SELECT 1 FROM `workflow_events` e
  WHERE e.`job_id` = `jobs`.`id`
    AND e.`reason` = 'approval'
    AND (
      json_extract(e.`metadata_json`, '$.resumeVersionId') IS NULL
      OR json_extract(e.`metadata_json`, '$.resumeVersionId') != (
        SELECT r.`resume_version_id`
        FROM `resume_reviews` r
        JOIN `resume_versions` v ON v.`id` = r.`resume_version_id`
        WHERE v.`job_id` = `jobs`.`id`
          AND r.`action` = 'APPROVED'
          AND r.`actor` = 'human'
          AND r.`content_hash` = v.`content_hash`
        GROUP BY r.`resume_version_id`
        HAVING COUNT(*) >= 1
      )
    )
);
--> statement-breakpoint
