CREATE TABLE `jd_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`extraction_id` text NOT NULL,
	`jd_text` text NOT NULL,
	`canonical_sha256` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extraction_id`) REFERENCES `job_extractions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jd_snapshots_job_id` ON `jd_snapshots` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jd_snapshots_job_hash` ON `jd_snapshots` (`job_id`,`canonical_sha256`);--> statement-breakpoint
CREATE TABLE `job_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`jd_snapshot_id` text NOT NULL,
	`candidate_snapshot_id` text NOT NULL,
	`work_attempt_id` text,
	`requirements_json` text NOT NULL,
	`gaps_json` text NOT NULL,
	`provider` text,
	`model` text,
	`prompt_version` text NOT NULL,
	`proposal_schema_version` text NOT NULL,
	`input_hash` text,
	`proposal_hash` text,
	`rationale` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`jd_snapshot_id`) REFERENCES `jd_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_snapshot_id`) REFERENCES `candidate_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_attempt_id`) REFERENCES `work_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_analyses_job_id` ON `job_analyses` (`job_id`);--> statement-breakpoint
CREATE TABLE `candidate_facts` (
	`fact_id` text PRIMARY KEY NOT NULL,
	`profile_version_id` text NOT NULL,
	`kind` text NOT NULL,
	`statement` text NOT NULL,
	`evidence_json` text,
	`verification` text DEFAULT 'PENDING' NOT NULL,
	`source` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`profile_version_id`) REFERENCES `candidate_profile_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "candidate_facts_verification" CHECK("candidate_facts"."verification" IN ('PENDING','APPROVED','REJECTED'))
);
--> statement-breakpoint
CREATE INDEX `candidate_facts_profile_version_id` ON `candidate_facts` (`profile_version_id`);--> statement-breakpoint
CREATE TABLE `candidate_profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`schema_version` text NOT NULL,
	`activated_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `candidate_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "candidate_profile_versions_version" CHECK("candidate_profile_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `candidate_profile_versions_profile_id` ON `candidate_profile_versions` (`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_profile_versions_profile_version` ON `candidate_profile_versions` (`profile_id`,`version`);--> statement-breakpoint
CREATE TABLE `candidate_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "candidate_profiles_single_row" CHECK("candidate_profiles"."id" = 'local')
);
--> statement-breakpoint
CREATE TABLE `candidate_snapshot_facts` (
	`snapshot_id` text NOT NULL,
	`fact_id` text NOT NULL,
	PRIMARY KEY(`snapshot_id`, `fact_id`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `candidate_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fact_id`) REFERENCES `candidate_facts`(`fact_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `candidate_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_version_id` text NOT NULL,
	`canonical_json` text NOT NULL,
	`schema_version` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`profile_version_id`) REFERENCES `candidate_profile_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `candidate_snapshots_profile_version_id` ON `candidate_snapshots` (`profile_version_id`);--> statement-breakpoint
CREATE INDEX `candidate_snapshots_sha256` ON `candidate_snapshots` (`sha256`);--> statement-breakpoint
CREATE TABLE `intake_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`raw_line_count` integer DEFAULT 0 NOT NULL,
	`enqueued_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`invalid_count` integer DEFAULT 0 NOT NULL,
	`blocked_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "intake_batches_counts_nonnegative" CHECK("intake_batches"."raw_line_count" >= 0 AND "intake_batches"."enqueued_count" >= 0 AND "intake_batches"."duplicate_count" >= 0 AND "intake_batches"."invalid_count" >= 0 AND "intake_batches"."blocked_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `intake_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`raw_input` text NOT NULL,
	`outcome` text DEFAULT 'PENDING' NOT NULL,
	`reason_code` text,
	`canonical_url` text,
	`job_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `intake_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "intake_items_outcome" CHECK("intake_items"."outcome" IN ('PENDING','ENQUEUED','INVALID','DUPLICATE','BLOCKED')),
	CONSTRAINT "intake_items_line_number" CHECK("intake_items"."line_number" >= 1)
);
--> statement-breakpoint
CREATE INDEX `intake_items_batch_id` ON `intake_items` (`batch_id`);--> statement-breakpoint
CREATE INDEX `intake_items_job_id` ON `intake_items` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `intake_items_batch_line` ON `intake_items` (`batch_id`,`line_number`);--> statement-breakpoint
CREATE TABLE `job_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`scrape_attempt_id` text NOT NULL,
	`version` integer NOT NULL,
	`schema_version` text NOT NULL,
	`adapter` text NOT NULL,
	`adapter_version` text,
	`extracted_json` text NOT NULL,
	`confidence` real,
	`missing_fields_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scrape_attempt_id`) REFERENCES `scrape_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_extractions_version" CHECK("job_extractions"."version" >= 1),
	CONSTRAINT "job_extractions_confidence" CHECK("job_extractions"."confidence" IS NULL OR ("job_extractions"."confidence" >= 0 AND "job_extractions"."confidence" <= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_extractions_scrape_attempt_id_unique` ON `job_extractions` (`scrape_attempt_id`);--> statement-breakpoint
CREATE INDEX `job_extractions_job_id` ON `job_extractions` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_extractions_job_version` ON `job_extractions` (`job_id`,`version`);--> statement-breakpoint
CREATE TABLE `job_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`submitted_url` text NOT NULL,
	`canonical_url` text NOT NULL,
	`canonical_key` text NOT NULL,
	`final_url` text,
	`apply_url` text,
	`source_identity` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_sources_canonical_key_unique` ON `job_sources` (`canonical_key`);--> statement-breakpoint
CREATE INDEX `job_sources_job_id` ON `job_sources` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
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
	`description_text` text,
	`posted_at` text,
	`scrape_state` text DEFAULT 'QUEUED' NOT NULL,
	`scrape_reason_code` text,
	`tailoring_state` text DEFAULT 'PENDING' NOT NULL,
	`tailoring_reason_code` text,
	`active_extraction_id` text,
	`active_resume_version_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "jobs_status" CHECK("jobs"."status" IN ('NEW','TAILORED','APPLIED','INTERVIEWED','REJECTED')),
	CONSTRAINT "jobs_row_version" CHECK("jobs"."row_version" >= 1),
	CONSTRAINT "jobs_arrangement" CHECK("jobs"."arrangement" IS NULL OR "jobs"."arrangement" IN ('REMOTE','HYBRID','ONSITE','UNKNOWN')),
	CONSTRAINT "jobs_salary_nonnegative" CHECK(("jobs"."salary_min_minor" IS NULL OR "jobs"."salary_min_minor" >= 0) AND ("jobs"."salary_max_minor" IS NULL OR "jobs"."salary_max_minor" >= 0)),
	CONSTRAINT "jobs_salary_ordered" CHECK("jobs"."salary_min_minor" IS NULL OR "jobs"."salary_max_minor" IS NULL OR "jobs"."salary_min_minor" <= "jobs"."salary_max_minor"),
	CONSTRAINT "jobs_scrape_state" CHECK("jobs"."scrape_state" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED')),
	CONSTRAINT "jobs_tailoring_state" CHECK("jobs"."tailoring_state" IN ('PENDING','BLOCKED','RUNNING','AWAITING_REVIEW','APPROVED','REVISION_REQUESTED','FAILED'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_rank` ON `jobs` (`status`,`rank`);--> statement-breakpoint
CREATE TABLE `scrape_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`intake_item_id` text,
	`job_id` text,
	`canonical_url` text NOT NULL,
	`adapter` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text NOT NULL,
	`reason_code` text,
	`error_detail` text,
	`worker_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`intake_item_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scrape_attempts_outcome" CHECK("scrape_attempts"."outcome" IN ('SUCCEEDED','FAILED','BLOCKED'))
);
--> statement-breakpoint
CREATE INDEX `scrape_attempts_intake_item_id` ON `scrape_attempts` (`intake_item_id`);--> statement-breakpoint
CREATE INDEX `scrape_attempts_job_id` ON `scrape_attempts` (`job_id`);--> statement-breakpoint
CREATE TABLE `source_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`scrape_attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`scrape_attempt_id`) REFERENCES `scrape_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_artifacts_kind" CHECK("source_artifacts"."kind" IN ('HTML','TEXT','JSONLD')),
	CONSTRAINT "source_artifacts_byte_size" CHECK("source_artifacts"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `source_artifacts_attempt_id` ON `source_artifacts` (`scrape_attempt_id`);--> statement-breakpoint
CREATE INDEX `source_artifacts_sha256` ON `source_artifacts` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_artifacts_attempt_kind` ON `source_artifacts` (`scrape_attempt_id`,`kind`);--> statement-breakpoint
CREATE TABLE `work_attempts` (
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
	CONSTRAINT "work_attempts_number" CHECK("work_attempts"."attempt_number" >= 1),
	CONSTRAINT "work_attempts_result" CHECK("work_attempts"."result" IN ('SUCCEEDED','FAILED','BLOCKED'))
);
--> statement-breakpoint
CREATE INDEX `work_attempts_work_item_id` ON `work_attempts` (`work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_attempts_item_number` ON `work_attempts` (`work_item_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `work_items` (
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
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intake_item_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_items_kind" CHECK("work_items"."kind" IN ('SCRAPE','TAILOR')),
	CONSTRAINT "work_items_state" CHECK("work_items"."state" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
	CONSTRAINT "work_items_lease_iff_running" CHECK(("work_items"."state" = 'RUNNING') = ("work_items"."lease_token" IS NOT NULL)),
	CONSTRAINT "work_items_attempt_count" CHECK("work_items"."attempt_count" >= 0),
	CONSTRAINT "work_items_max_attempts" CHECK("work_items"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_idempotency_key_unique` ON `work_items` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `work_items_state_next_run` ON `work_items` (`state`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `work_items_job_id` ON `work_items` (`job_id`);--> statement-breakpoint
CREATE INDEX `work_items_intake_item_id` ON `work_items` (`intake_item_id`);--> statement-breakpoint
CREATE TABLE `resume_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`resume_version_id` text NOT NULL,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`resume_version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "resume_artifacts_kind" CHECK("resume_artifacts"."kind" IN ('MARKDOWN','DOCX','PDF')),
	CONSTRAINT "resume_artifacts_byte_size" CHECK("resume_artifacts"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `resume_artifacts_version_id` ON `resume_artifacts` (`resume_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resume_artifacts_version_kind` ON `resume_artifacts` (`resume_version_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `resume_artifacts_version_sha` ON `resume_artifacts` (`resume_version_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `resume_claim_facts` (
	`claim_id` text NOT NULL,
	`fact_id` text NOT NULL,
	PRIMARY KEY(`claim_id`, `fact_id`),
	FOREIGN KEY (`claim_id`) REFERENCES `resume_claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fact_id`) REFERENCES `candidate_facts`(`fact_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resume_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`resume_version_id` text NOT NULL,
	`claim_text` text NOT NULL,
	`requirement_ref` text,
	`derivation_kind` text,
	`derivation_payload` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`resume_version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `resume_claims_version_id` ON `resume_claims` (`resume_version_id`);--> statement-breakpoint
CREATE TABLE `resume_reviews` (
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
	CONSTRAINT "resume_reviews_action" CHECK("resume_reviews"."action" IN ('APPROVED','REVISION_REQUESTED'))
);
--> statement-breakpoint
CREATE INDEX `resume_reviews_version_id` ON `resume_reviews` (`resume_version_id`);--> statement-breakpoint
CREATE TABLE `resume_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version_id` text,
	`analysis_id` text NOT NULL,
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
	CONSTRAINT "resume_versions_version" CHECK("resume_versions"."version" >= 1),
	CONSTRAINT "resume_versions_review_state" CHECK("resume_versions"."review_state" IN ('DRAFT','AWAITING_REVIEW','APPROVED','REVISION_REQUESTED','FAILED'))
);
--> statement-breakpoint
CREATE INDEX `resume_versions_job_id` ON `resume_versions` (`job_id`);--> statement-breakpoint
CREATE INDEX `resume_versions_analysis_id` ON `resume_versions` (`analysis_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resume_versions_job_version` ON `resume_versions` (`job_id`,`version`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`recorded_by` text DEFAULT 'human' NOT NULL,
	`applied_at` text NOT NULL,
	`confirmation_number` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "applications_recorded_by" CHECK("applications"."recorded_by" IN ('human'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_job_id_unique` ON `applications` (`job_id`);--> statement-breakpoint
CREATE TABLE `job_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_notes_job_id` ON `job_notes` (`job_id`);--> statement-breakpoint
CREATE TABLE `workflow_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`actor` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`rank` real,
	`row_version` integer NOT NULL,
	`reason` text,
	`metadata_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_events_from_status" CHECK("workflow_events"."from_status" IS NULL OR "workflow_events"."from_status" IN ('NEW','TAILORED','APPLIED','INTERVIEWED','REJECTED')),
	CONSTRAINT "workflow_events_to_status" CHECK("workflow_events"."to_status" IN ('NEW','TAILORED','APPLIED','INTERVIEWED','REJECTED')),
	CONSTRAINT "workflow_events_row_version" CHECK("workflow_events"."row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `workflow_events_job_id` ON `workflow_events` (`job_id`);