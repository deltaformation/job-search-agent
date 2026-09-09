-- Close application-copilot ownership, idempotency, and audit-integrity gaps.

ALTER TABLE application_fill_actions
    ADD COLUMN IF NOT EXISTS field_plan_id UUID REFERENCES field_plans(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);

UPDATE application_fill_actions AS action
SET field_plan_id = (
    SELECT plan.id
    FROM field_plans AS plan
    WHERE plan.attempt_id = action.attempt_id
      AND plan.form_snapshot_id = action.form_snapshot_id
      AND plan.validation_status = 'VALIDATED'
    ORDER BY plan.created_at DESC, plan.id DESC
    LIMIT 1
)
WHERE action.field_plan_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM field_plans AS plan
      WHERE plan.attempt_id = action.attempt_id
        AND plan.form_snapshot_id = action.form_snapshot_id
        AND plan.validation_status = 'VALIDATED'
  );

UPDATE application_fill_actions
SET idempotency_key = 'legacy_' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE application_fill_actions
    ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_application_fill_action_idempotency
    ON application_fill_actions(attempt_id, idempotency_key);

ALTER TABLE application_checkpoints
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100);

UPDATE application_checkpoints
SET idempotency_key = 'legacy_' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE application_checkpoints
    ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_application_checkpoint_idempotency
    ON application_checkpoints(application_id, idempotency_key);

CREATE OR REPLACE FUNCTION protect_application_audit_record() RETURNS trigger AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Application audit records are immutable; append a new record';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_application_fill_action ON application_fill_actions;
CREATE TRIGGER immutable_application_fill_action BEFORE UPDATE ON application_fill_actions
    FOR EACH ROW EXECUTE FUNCTION protect_application_audit_record();

DROP TRIGGER IF EXISTS immutable_application_checkpoint ON application_checkpoints;
CREATE TRIGGER immutable_application_checkpoint BEFORE UPDATE ON application_checkpoints
    FOR EACH ROW EXECUTE FUNCTION protect_application_audit_record();

DROP TRIGGER IF EXISTS immutable_application_event ON application_events;
CREATE TRIGGER immutable_application_event BEFORE UPDATE ON application_events
    FOR EACH ROW EXECUTE FUNCTION protect_application_audit_record();

CREATE OR REPLACE FUNCTION protect_application_binding() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.job_id, NEW.resume_version_id, NEW.resume_content_hash,
           NEW.resume_pdf_hash, NEW.analysis_id, NEW.application_url)
       IS DISTINCT FROM
       ROW(OLD.job_id, OLD.resume_version_id, OLD.resume_content_hash,
           OLD.resume_pdf_hash, OLD.analysis_id, OLD.application_url) THEN
        RAISE EXCEPTION 'Application binding is immutable; create a new application record';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_application_binding ON applications;
CREATE TRIGGER immutable_application_binding BEFORE UPDATE ON applications
    FOR EACH ROW EXECUTE FUNCTION protect_application_binding();
