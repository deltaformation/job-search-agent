-- Migration: 0001_trigger_guards.sql
-- Hand-reviewed companion to the generated 0000 baseline. SQLite cannot express
-- immutability, append-only logs, or cross-row ownership in CHECK constraints,
-- so this file adds the trigger guards plus one partial unique index. It must
-- keep sorting after 0000_* and before any future generated migration; see
-- drizzle/README.md for the ordering rule.

-- One explicitly activated profile version per profile.
CREATE UNIQUE INDEX `candidate_profile_versions_one_active`
  ON `candidate_profile_versions` (`profile_id`)
  WHERE `activated_at` IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Full immutability: these rows are evidence or versioned content and must
-- never change after insert. New observations are new rows.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `trg_scrape_attempts_no_update` BEFORE UPDATE ON `scrape_attempts`
BEGIN SELECT RAISE(ABORT, 'scrape_attempts is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_scrape_attempts_no_delete` BEFORE DELETE ON `scrape_attempts`
BEGIN SELECT RAISE(ABORT, 'scrape_attempts is append-only'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_source_artifacts_no_update` BEFORE UPDATE ON `source_artifacts`
BEGIN SELECT RAISE(ABORT, 'source_artifacts is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_source_artifacts_no_delete` BEFORE DELETE ON `source_artifacts`
BEGIN SELECT RAISE(ABORT, 'source_artifacts is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_job_extractions_no_update` BEFORE UPDATE ON `job_extractions`
BEGIN SELECT RAISE(ABORT, 'job_extractions is immutable; add a new version'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_job_extractions_no_delete` BEFORE DELETE ON `job_extractions`
BEGIN SELECT RAISE(ABORT, 'job_extractions is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_work_attempts_no_update` BEFORE UPDATE ON `work_attempts`
BEGIN SELECT RAISE(ABORT, 'work_attempts is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_work_attempts_no_delete` BEFORE DELETE ON `work_attempts`
BEGIN SELECT RAISE(ABORT, 'work_attempts is append-only'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_workflow_events_no_update` BEFORE UPDATE ON `workflow_events`
BEGIN SELECT RAISE(ABORT, 'workflow_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_workflow_events_no_delete` BEFORE DELETE ON `workflow_events`
BEGIN SELECT RAISE(ABORT, 'workflow_events is append-only'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_candidate_profiles_no_update` BEFORE UPDATE ON `candidate_profiles`
BEGIN SELECT RAISE(ABORT, 'candidate_profiles root is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_profiles_no_delete` BEFORE DELETE ON `candidate_profiles`
BEGIN SELECT RAISE(ABORT, 'candidate_profiles root cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_candidate_snapshots_no_update` BEFORE UPDATE ON `candidate_snapshots`
BEGIN SELECT RAISE(ABORT, 'candidate_snapshots is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_snapshots_no_delete` BEFORE DELETE ON `candidate_snapshots`
BEGIN SELECT RAISE(ABORT, 'candidate_snapshots is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_candidate_snapshot_facts_no_update` BEFORE UPDATE ON `candidate_snapshot_facts`
BEGIN SELECT RAISE(ABORT, 'candidate_snapshot_facts is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_snapshot_facts_no_delete` BEFORE DELETE ON `candidate_snapshot_facts`
BEGIN SELECT RAISE(ABORT, 'candidate_snapshot_facts is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_jd_snapshots_no_update` BEFORE UPDATE ON `jd_snapshots`
BEGIN SELECT RAISE(ABORT, 'jd_snapshots is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_jd_snapshots_no_delete` BEFORE DELETE ON `jd_snapshots`
BEGIN SELECT RAISE(ABORT, 'jd_snapshots is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_job_analyses_no_update` BEFORE UPDATE ON `job_analyses`
BEGIN SELECT RAISE(ABORT, 'job_analyses is immutable; create a new analysis'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_job_analyses_no_delete` BEFORE DELETE ON `job_analyses`
BEGIN SELECT RAISE(ABORT, 'job_analyses is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_claims_no_update` BEFORE UPDATE ON `resume_claims`
BEGIN SELECT RAISE(ABORT, 'resume_claims is immutable; create a new version'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_resume_claims_no_delete` BEFORE DELETE ON `resume_claims`
BEGIN SELECT RAISE(ABORT, 'resume_claims is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_claim_facts_no_update` BEFORE UPDATE ON `resume_claim_facts`
BEGIN SELECT RAISE(ABORT, 'resume_claim_facts is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_resume_claim_facts_no_delete` BEFORE DELETE ON `resume_claim_facts`
BEGIN SELECT RAISE(ABORT, 'resume_claim_facts is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_artifacts_no_update` BEFORE UPDATE ON `resume_artifacts`
BEGIN SELECT RAISE(ABORT, 'resume_artifacts is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_resume_artifacts_no_delete` BEFORE DELETE ON `resume_artifacts`
BEGIN SELECT RAISE(ABORT, 'resume_artifacts is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_resume_reviews_no_update` BEFORE UPDATE ON `resume_reviews`
BEGIN SELECT RAISE(ABORT, 'resume_reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_resume_reviews_no_delete` BEFORE DELETE ON `resume_reviews`
BEGIN SELECT RAISE(ABORT, 'resume_reviews is append-only'); END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Delete-only blocks: these rows evolve through UPDATE but history must never
-- lose them. Merges keep every intake item, source, and attempt.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `trg_intake_batches_no_delete` BEFORE DELETE ON `intake_batches`
BEGIN SELECT RAISE(ABORT, 'intake_batches cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_intake_items_no_delete` BEFORE DELETE ON `intake_items`
BEGIN SELECT RAISE(ABORT, 'intake_items cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_jobs_no_delete` BEFORE DELETE ON `jobs`
BEGIN SELECT RAISE(ABORT, 'jobs cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_job_sources_no_delete` BEFORE DELETE ON `job_sources`
BEGIN SELECT RAISE(ABORT, 'job_sources cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_work_items_no_delete` BEFORE DELETE ON `work_items`
BEGIN SELECT RAISE(ABORT, 'work_items cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER `trg_applications_no_delete` BEFORE DELETE ON `applications`
BEGIN SELECT RAISE(ABORT, 'applications cannot be deleted'); END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Conditional immutability.
-- ---------------------------------------------------------------------------

-- Profile version payloads are immutable; only activation may change.
CREATE TRIGGER `trg_candidate_profile_versions_guard_update` BEFORE UPDATE ON `candidate_profile_versions`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`profile_id` IS NOT NEW.`profile_id`
  OR OLD.`version` IS NOT NEW.`version`
  OR OLD.`payload_json` IS NOT NEW.`payload_json`
  OR OLD.`payload_hash` IS NOT NEW.`payload_hash`
  OR OLD.`schema_version` IS NOT NEW.`schema_version`
  OR OLD.`created_at` IS NOT NEW.`created_at`
BEGIN SELECT RAISE(ABORT, 'candidate profile version payload is immutable; create a new version'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_profile_versions_no_delete` BEFORE DELETE ON `candidate_profile_versions`
BEGIN SELECT RAISE(ABORT, 'candidate_profile_versions cannot be deleted'); END;
--> statement-breakpoint

-- Approved facts are frozen; drafts may still be edited or discarded.
CREATE TRIGGER `trg_candidate_facts_guard_approved_update` BEFORE UPDATE ON `candidate_facts`
WHEN OLD.`verification` = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'approved candidate facts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `trg_candidate_facts_guard_approved_delete` BEFORE DELETE ON `candidate_facts`
WHEN OLD.`verification` = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'approved candidate facts cannot be deleted'); END;
--> statement-breakpoint

-- Resume content and lineage are immutable; only review_state transitions, and
-- approved versions are fully frozen (a revision is a new version row).
CREATE TRIGGER `trg_resume_versions_guard_content` BEFORE UPDATE ON `resume_versions`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`job_id` IS NOT NEW.`job_id`
  OR OLD.`version` IS NOT NEW.`version`
  OR OLD.`parent_version_id` IS NOT NEW.`parent_version_id`
  OR OLD.`analysis_id` IS NOT NEW.`analysis_id`
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
CREATE TRIGGER `trg_resume_versions_no_delete` BEFORE DELETE ON `resume_versions`
BEGIN SELECT RAISE(ABORT, 'resume_versions cannot be deleted'); END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Ownership and lineage validation that CHECK constraints cannot express.
-- ---------------------------------------------------------------------------

-- Active pointers must reference rows belonging to the same job.
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

-- A JD snapshot must cite an extraction from the same job.
CREATE TRIGGER `trg_jd_snapshots_check_extraction_job` BEFORE INSERT ON `jd_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'jd snapshot extraction must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `job_extractions` e
    WHERE e.`id` = NEW.`extraction_id` AND e.`job_id` = NEW.`job_id`
  );
END;
--> statement-breakpoint

-- An analysis must cite a JD snapshot from the same job.
CREATE TRIGGER `trg_job_analyses_check_jd_job` BEFORE INSERT ON `job_analyses`
BEGIN
  SELECT RAISE(ABORT, 'analysis jd snapshot must belong to the same job')
  WHERE NOT EXISTS (
    SELECT 1 FROM `jd_snapshots` s
    WHERE s.`id` = NEW.`jd_snapshot_id` AND s.`job_id` = NEW.`job_id`
  );
END;
--> statement-breakpoint

-- A resume version must cite an analysis and parent from the same job.
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

-- Snapshot membership only admits facts from the snapshot's own profile version.
CREATE TRIGGER `trg_candidate_snapshot_facts_check_version` BEFORE INSERT ON `candidate_snapshot_facts`
BEGIN
  SELECT RAISE(ABORT, 'snapshot member fact must come from the snapshot profile version')
  WHERE NOT EXISTS (
    SELECT 1 FROM `candidate_snapshots` s
    JOIN `candidate_facts` f ON f.`fact_id` = NEW.`fact_id`
    WHERE s.`id` = NEW.`snapshot_id`
      AND f.`profile_version_id` = s.`profile_version_id`
  );
END;
--> statement-breakpoint

-- Claim citations must be members of the exact bound candidate snapshot and
-- must be approved. (Minimum-one-fact and derivation-exclusivity rules are
-- enforced by the R4 deterministic validator, which sees the full version.)
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
