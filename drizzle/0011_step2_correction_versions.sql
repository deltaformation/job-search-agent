-- WO-1.3-S2-CP-B: Step 2 correction version widening (contracts
-- `v1.3-step2-correction-contracts.md` §3). No new tables and no new
-- columns: `step2_plans` and `step2_draft_validations` are rebuilt to
-- widen their version CHECKs so v2 correction rows coexist with v1
-- rows in the same append-only histories, plus a cross-version
-- lineage guard on plans so v1 prompt/proposal/claims travel
-- together and v2 travels together. Every other column,
-- constraint, index, and trigger is byte-identical to 0009. All
-- rows copy byte-identically (guarded by row-count assertions); no
-- backfill, no provider calls, no queue inserts. The upgrade
-- preflight (migrate.ts) refuses to run while any RUNNING work row
-- exists.
--
-- Rebuild mechanics mirror 0009's work_items rebuild: new table,
-- copied rows, drop, rename. Two triggers name the rebuilt tables
-- from OTHER tables (`s2_prep_accepted_forward`,
-- `s2_gen_owner`), so they are dropped before the rebuilds and
-- recreated byte-identically afterwards — the renames cannot run
-- while they exist.

DROP TRIGGER IF EXISTS s2_prep_accepted_forward;
DROP TRIGGER IF EXISTS s2_gen_owner;

CREATE TABLE step2_plans_new (
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
 CONSTRAINT s2_plan_versions CHECK(prompt_version IN ('prepare-prompt/v1','prepare-prompt/v2') AND proposal_schema_version IN ('preparation-proposal/v1','preparation-proposal/v2') AND claims_policy_version IN ('step2-claims/1','step2-claims/2')),
 CONSTRAINT s2_plan_lineage CHECK((prompt_version='prepare-prompt/v1')=(proposal_schema_version='preparation-proposal/v1') AND (prompt_version='prepare-prompt/v1')=(claims_policy_version='step2-claims/1')),
 CONSTRAINT s2_plan_time CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL)
);
INSERT INTO step2_plans_new (
 id,preparation_id,plan_seq,plan_json,plan_hash,provider_id,
 model,prompt_version,proposal_schema_version,claims_policy_version,
 input_hash,proposal_hash,attempt_id,validation_json,
 supersedes_plan_id,created_at
) SELECT
 id,preparation_id,plan_seq,plan_json,plan_hash,provider_id,
 model,prompt_version,proposal_schema_version,claims_policy_version,
 input_hash,proposal_hash,attempt_id,validation_json,
 supersedes_plan_id,created_at
FROM step2_plans;
DROP TABLE step2_plans;
ALTER TABLE step2_plans_new RENAME TO step2_plans;
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

CREATE TABLE step2_draft_validations_new (
 id TEXT PRIMARY KEY NOT NULL,
 job_id TEXT NOT NULL REFERENCES jobs(id),
 plan_id TEXT NOT NULL REFERENCES step2_plans(id),
 workspace_revision INTEGER NOT NULL CONSTRAINT s2_verdict_revision CHECK(workspace_revision>=1),
 draft_hash TEXT NOT NULL CONSTRAINT s2_verdict_hash CHECK(length(draft_hash)=64 AND draft_hash NOT GLOB '*[^0-9a-f]*'),
 verdict_json TEXT NOT NULL CONSTRAINT s2_verdict_bytes CHECK(json_valid(verdict_json) AND length(CAST(verdict_json AS BLOB))<=65536),
 policy_version TEXT NOT NULL CONSTRAINT s2_verdict_policy CHECK(policy_version IN ('step2-claims/1','step2-claims/2')),
 created_at TEXT NOT NULL CONSTRAINT s2_verdict_time CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL)
);
INSERT INTO step2_draft_validations_new (
 id,job_id,plan_id,workspace_revision,draft_hash,verdict_json,
 policy_version,created_at
) SELECT
 id,job_id,plan_id,workspace_revision,draft_hash,verdict_json,
 policy_version,created_at
FROM step2_draft_validations;
DROP TABLE step2_draft_validations;
ALTER TABLE step2_draft_validations_new RENAME TO step2_draft_validations;
CREATE INDEX s2_verdicts_job_hash ON step2_draft_validations(job_id,draft_hash);
CREATE INDEX s2_verdicts_plan_id ON step2_draft_validations(plan_id);
CREATE TRIGGER s2_verdict_no_update BEFORE UPDATE ON step2_draft_validations
BEGIN SELECT RAISE(ABORT,'VERDICT_IMMUTABLE'); END;
CREATE TRIGGER s2_verdict_no_delete BEFORE DELETE ON step2_draft_validations
BEGIN SELECT RAISE(ABORT,'VERDICT_IMMUTABLE'); END;

CREATE TRIGGER s2_prep_accepted_forward BEFORE UPDATE OF accepted_plan_id ON step2_preparations
WHEN NEW.accepted_plan_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM step2_plans n
 WHERE n.id=NEW.accepted_plan_id AND n.preparation_id=NEW.id
  AND (OLD.accepted_plan_id IS NULL OR n.plan_seq>(SELECT plan_seq FROM step2_plans WHERE id=OLD.accepted_plan_id)))
BEGIN SELECT RAISE(ABORT,'PLAN_POINTER_BACKWARD'); END;
CREATE TRIGGER s2_gen_owner BEFORE INSERT ON step2_generation_inputs
WHEN NOT EXISTS(
 SELECT 1 FROM step2_plans pl JOIN step2_preparations p ON p.id=pl.preparation_id
 JOIN generation_requests r ON r.job_id=p.job_id
 JOIN step2_draft_validations v ON v.id=NEW.validation_id
 WHERE r.id=NEW.request_id AND pl.id=NEW.plan_id AND p.job_id IS NOT NULL
  AND v.plan_id=NEW.plan_id AND v.draft_hash=NEW.draft_hash)
BEGIN SELECT RAISE(ABORT,'S2_INPUT_PLAN_MISMATCH'); END;
