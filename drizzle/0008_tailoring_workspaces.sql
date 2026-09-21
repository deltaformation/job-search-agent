-- Migration: 0008_tailoring_workspaces.sql
-- WO-1.3-B (R-ADR-021, R-ADR-022, R-ADR-023, R-ADR-024): durable
-- mutable workspace drafts with revision CAS, the immutable
-- request-input extension, fenced append-only progress events, and
-- immutable generation-time assessments, plus the v2+v3 queue
-- payload guard and one-live-TAILOR-per-job uniqueness.
--
-- DDL is verbatim from docs/contracts/v1.3-0008.sql (WO-1.3-A
-- specification). Preconditions: migrations 0000..0007 applied;
-- supervised web/worker stopped; zero live TAILOR rows, refused by
-- the upgrade preflight (src/db/migrate.ts) before applying.
-- No existing-row backfill: all new tables start empty and every
-- historical v2 record is unchanged.
--
CREATE UNIQUE INDEX v13_extraction_owner ON job_extractions(id,job_id);
CREATE UNIQUE INDEX v13_profile_version_owner ON candidate_profile_versions(id,profile_id);
CREATE UNIQUE INDEX v13_resume_owner ON resume_versions(id,job_id);
CREATE UNIQUE INDEX v13_request_owner ON generation_requests(id,job_id);
CREATE UNIQUE INDEX v13_attempt_owner ON work_attempts(id,work_item_id);
CREATE UNIQUE INDEX v13_one_version_per_request ON resume_versions(generation_request_id)
 WHERE generation_request_id IS NOT NULL;
CREATE UNIQUE INDEX v13_one_live_tailor ON work_items(job_id)
 WHERE kind='TAILOR' AND state IN ('QUEUED','RUNNING');

CREATE TABLE tailoring_workspaces (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id),
 revision INTEGER NOT NULL CONSTRAINT v13_ws_revision CHECK(revision>=1),
 extraction_id TEXT,
 profile_id TEXT REFERENCES candidate_profiles(id),
 profile_version_id TEXT,
 request_kind TEXT NOT NULL CONSTRAINT v13_ws_kind CHECK(request_kind IN ('INITIAL','NEW_VERSION','REVISION')),
 parent_version_id TEXT,
 revision_note TEXT,
 focus_json TEXT NOT NULL CONSTRAINT v13_ws_focus CHECK(json_valid(focus_json) AND length(CAST(focus_json AS BLOB))<=65536),
 recommendations_json TEXT CONSTRAINT v13_ws_recs CHECK(recommendations_json IS NULL OR (json_valid(recommendations_json) AND length(CAST(recommendations_json AS BLOB))<=262144)),
 recommendation_hash TEXT CONSTRAINT v13_ws_hash CHECK(recommendation_hash IS NULL OR (length(recommendation_hash)=64 AND recommendation_hash NOT GLOB '*[^0-9a-f]*')),
 last_request_id TEXT,
 last_submitted_revision INTEGER CONSTRAINT v13_ws_submitted CHECK(last_submitted_revision>=1 AND last_submitted_revision<=revision),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(extraction_id,job_id) REFERENCES job_extractions(id,job_id),
 FOREIGN KEY(profile_version_id,profile_id) REFERENCES candidate_profile_versions(id,profile_id),
 FOREIGN KEY(parent_version_id,job_id) REFERENCES resume_versions(id,job_id),
 FOREIGN KEY(last_request_id,job_id) REFERENCES generation_requests(id,job_id),
 CONSTRAINT v13_ws_profile CHECK((profile_id IS NULL)=(profile_version_id IS NULL)),
 CONSTRAINT v13_ws_rec_pair CHECK((recommendations_json IS NULL)=(recommendation_hash IS NULL)),
 CONSTRAINT v13_ws_rec_bound CHECK(recommendations_json IS NULL OR (extraction_id IS NOT NULL AND profile_version_id IS NOT NULL)),
 CONSTRAINT v13_ws_last CHECK((last_request_id IS NULL)=(last_submitted_revision IS NULL)),
 CONSTRAINT v13_ws_parent CHECK(
  (request_kind='INITIAL' AND parent_version_id IS NULL AND revision_note IS NULL) OR
  (request_kind='NEW_VERSION' AND parent_version_id IS NOT NULL AND revision_note IS NULL) OR
  (request_kind='REVISION' AND parent_version_id IS NOT NULL AND revision_note IS NOT NULL AND length(trim(revision_note)) BETWEEN 1 AND 4000))
);
CREATE TRIGGER v13_workspace_cas BEFORE UPDATE ON tailoring_workspaces
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'WORKSPACE_REVISION_INVALID'); END;

CREATE TABLE tailoring_request_inputs (
 request_id TEXT PRIMARY KEY NOT NULL REFERENCES generation_requests(id),
 workspace_revision INTEGER NOT NULL CONSTRAINT v13_in_revision CHECK(workspace_revision>=1),
 submit_hash TEXT NOT NULL CONSTRAINT v13_in_submit_hash CHECK(length(submit_hash)=64 AND submit_hash NOT GLOB '*[^0-9a-f]*'),
 input_hash TEXT NOT NULL CONSTRAINT v13_in_hash CHECK(length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
 candidate_snapshot_id TEXT NOT NULL REFERENCES candidate_snapshots(id),
 focus_json TEXT NOT NULL CONSTRAINT v13_in_focus CHECK(json_valid(focus_json) AND length(CAST(focus_json AS BLOB))<=65536),
 recommendations_json TEXT NOT NULL CONSTRAINT v13_in_recs CHECK(json_valid(recommendations_json) AND length(CAST(recommendations_json AS BLOB))<=262144),
 master_text TEXT NOT NULL CONSTRAINT v13_in_master CHECK(length(CAST(master_text AS BLOB)) BETWEEN 1 AND 262144),
 master_text_hash TEXT NOT NULL CONSTRAINT v13_in_master_hash CHECK(length(master_text_hash)=64 AND master_text_hash NOT GLOB '*[^0-9a-f]*'),
 projection_version TEXT NOT NULL CONSTRAINT v13_in_projection CHECK(projection_version='master-text/1'),
 created_at TEXT NOT NULL
);
CREATE INDEX v13_inputs_snapshot ON tailoring_request_inputs(candidate_snapshot_id);
CREATE TRIGGER v13_inputs_owner BEFORE INSERT ON tailoring_request_inputs
WHEN NOT EXISTS(SELECT 1 FROM generation_requests r JOIN candidate_snapshots s
 ON s.profile_version_id=r.profile_version_id
 WHERE r.id=NEW.request_id AND s.id=NEW.candidate_snapshot_id)
BEGIN SELECT RAISE(ABORT,'INPUT_PROFILE_MISMATCH'); END;
CREATE TRIGGER v13_inputs_no_update BEFORE UPDATE ON tailoring_request_inputs
BEGIN SELECT RAISE(ABORT,'INPUT_IMMUTABLE'); END;
CREATE TRIGGER v13_inputs_no_delete BEFORE DELETE ON tailoring_request_inputs
BEGIN SELECT RAISE(ABORT,'INPUT_IMMUTABLE'); END;

CREATE TABLE generation_progress_events (
 request_id TEXT NOT NULL REFERENCES generation_requests(id),
 work_item_id TEXT NOT NULL REFERENCES work_items(id),
 attempt_id TEXT NOT NULL,
 seq INTEGER NOT NULL CONSTRAINT v13_progress_seq CHECK(seq BETWEEN 1 AND 5),
 stage TEXT NOT NULL CONSTRAINT v13_progress_stage CHECK(stage IN ('PREPARING_INPUTS','WAITING_FOR_PROVIDER','VALIDATING_PROPOSAL','RENDERING_ARTIFACTS','PUBLISHING_RESULT')),
 source TEXT NOT NULL CONSTRAINT v13_progress_source CHECK(source IN ('provider','cached')),
 lease_token TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(attempt_id,seq),
 CONSTRAINT v13_progress_unique_stage UNIQUE(attempt_id,stage),
 FOREIGN KEY(attempt_id,work_item_id) REFERENCES work_attempts(id,work_item_id)
);
CREATE INDEX v13_progress_request ON generation_progress_events(request_id,attempt_id,seq);
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
CREATE TRIGGER v13_progress_no_update BEFORE UPDATE ON generation_progress_events
BEGIN SELECT RAISE(ABORT,'PROGRESS_IMMUTABLE'); END;
CREATE TRIGGER v13_progress_no_delete BEFORE DELETE ON generation_progress_events
BEGIN SELECT RAISE(ABORT,'PROGRESS_IMMUTABLE'); END;

CREATE TABLE resume_assessments (
 resume_version_id TEXT PRIMARY KEY NOT NULL REFERENCES resume_versions(id),
 request_id TEXT NOT NULL REFERENCES tailoring_request_inputs(request_id),
 policy_version TEXT NOT NULL CONSTRAINT v13_as_policy CHECK(policy_version='assessment/1'),
 master_text_hash TEXT NOT NULL CONSTRAINT v13_as_master CHECK(length(master_text_hash)=64 AND master_text_hash NOT GLOB '*[^0-9a-f]*'),
 tailored_content_hash TEXT NOT NULL CONSTRAINT v13_as_tailored CHECK(length(tailored_content_hash)=64 AND tailored_content_hash NOT GLOB '*[^0-9a-f]*'),
 measures_json TEXT NOT NULL CONSTRAINT v13_as_json CHECK(json_valid(measures_json) AND length(CAST(measures_json AS BLOB))<=262144),
 created_at TEXT NOT NULL
);
CREATE INDEX v13_assessment_request ON resume_assessments(request_id);
CREATE TRIGGER v13_assessment_binding BEFORE INSERT ON resume_assessments
WHEN NOT EXISTS(SELECT 1 FROM resume_versions v
 JOIN tailoring_request_inputs i ON i.request_id=v.generation_request_id
 JOIN job_analyses a ON a.id=v.analysis_id
 WHERE v.id=NEW.resume_version_id AND i.request_id=NEW.request_id
  AND a.candidate_snapshot_id=i.candidate_snapshot_id
  AND i.master_text_hash=NEW.master_text_hash AND v.content_hash=NEW.tailored_content_hash)
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_BINDING_INVALID'); END;
CREATE TRIGGER v13_assessment_no_update BEFORE UPDATE ON resume_assessments
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;
CREATE TRIGGER v13_assessment_no_delete BEFORE DELETE ON resume_assessments
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;

DROP TRIGGER trg_work_items_no_legacy_tailor;
CREATE TRIGGER trg_work_items_no_legacy_tailor BEFORE INSERT ON work_items
WHEN NEW.kind='TAILOR' AND CASE WHEN COALESCE(json_valid(NEW.payload_json),0)=0 THEN 1
 ELSE COALESCE(json_extract(NEW.payload_json,'$.schemaVersion'),'') NOT IN ('tailor-queue/v2','tailor-queue/v3') END
BEGIN SELECT RAISE(ABORT,'UNSUPPORTED_TAILOR_PAYLOAD'); END;
