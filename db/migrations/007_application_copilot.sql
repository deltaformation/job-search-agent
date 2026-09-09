-- Migration: 007_application_copilot.sql
-- Description: Adds application session state, browser attempts, form snapshots,
-- field plans, fill audit logs, pre-submit checkpoints, and immutable audit triggers.

-- 1. Upgrade applications table
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS resume_version_id UUID REFERENCES resume_versions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resume_content_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS resume_pdf_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES job_analyses(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS application_url TEXT;

ALTER TABLE applications
    ALTER COLUMN status SET DEFAULT 'DRAFT';

ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_status_check,
    ADD CONSTRAINT applications_status_check
        CHECK (status IN (
            'DRAFT', 'PREPARING', 'NEEDS_HUMAN_INPUT', 'READY_FOR_HUMAN_REVIEW',
            'HUMAN_COMPLETING', 'SUBMITTED_CONFIRMED', 'ABANDONED', 'FAILED',
            'APPLICATION_STARTED'
        ));

-- 2. Append-Only Application Attempts
CREATE TABLE IF NOT EXISTS application_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL,
    idempotency_key VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED'
        CHECK (status IN (
            'CREATED', 'INSPECTING', 'PLANNED', 'FILLING', 'CHECKPOINTED',
            'INTERRUPTED', 'COMPLETED_WITHOUT_SUBMISSION', 'FAILED'
        )),
    stage_label VARCHAR(100) DEFAULT 'initial',
    current_page_url TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    error_summary TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_attempt_number UNIQUE (application_id, attempt_number),
    CONSTRAINT uq_app_attempt_idempotency UNIQUE (application_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_app_attempts_app ON application_attempts(application_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS idx_app_attempts_status ON application_attempts(status);

-- 3. Immutable Form Snapshots
CREATE TABLE IF NOT EXISTS form_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    attempt_id UUID NOT NULL REFERENCES application_attempts(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    form_fingerprint VARCHAR(64) NOT NULL,
    fields_metadata JSONB NOT NULL DEFAULT '[]'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_snapshots_attempt ON form_snapshots(attempt_id);

-- 4. Validated Field Plans
CREATE TABLE IF NOT EXISTS field_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    attempt_id UUID NOT NULL REFERENCES application_attempts(id) ON DELETE CASCADE,
    form_snapshot_id UUID NOT NULL REFERENCES form_snapshots(id) ON DELETE CASCADE,
    fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    validation_status VARCHAR(30) NOT NULL DEFAULT 'VALIDATED'
        CHECK (validation_status IN ('VALIDATED', 'REJECTED')),
    validation_errors JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_plans_attempt ON field_plans(attempt_id);
CREATE INDEX IF NOT EXISTS idx_field_plans_snapshot ON field_plans(form_snapshot_id);

-- 5. Fill and Upload Action Audit Log
CREATE TABLE IF NOT EXISTS application_fill_actions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    attempt_id UUID NOT NULL REFERENCES application_attempts(id) ON DELETE CASCADE,
    form_snapshot_id UUID NOT NULL REFERENCES form_snapshots(id) ON DELETE CASCADE,
    field_key VARCHAR(100) NOT NULL,
    action_type VARCHAR(30) NOT NULL
        CHECK (action_type IN ('FILL', 'SELECT', 'UPLOAD', 'SKIP')),
    value_hash VARCHAR(64),
    redacted_value TEXT,
    status VARCHAR(30) NOT NULL
        CHECK (status IN ('SUCCESS', 'FAILED', 'BLOCKED')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_fill_actions_attempt ON application_fill_actions(attempt_id);

-- 6. Pre-Submit Checkpoints
CREATE TABLE IF NOT EXISTS application_checkpoints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    attempt_id UUID NOT NULL REFERENCES application_attempts(id) ON DELETE CASCADE,
    stage VARCHAR(100) NOT NULL,
    page_url TEXT NOT NULL,
    blockers JSONB DEFAULT '[]'::jsonb,
    next_action VARCHAR(100) NOT NULL,
    human_checklist JSONB DEFAULT '[]'::jsonb,
    snapshot_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_checkpoints_app ON application_checkpoints(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_checkpoints_attempt ON application_checkpoints(attempt_id);

-- 7. Enhanced Application Events
ALTER TABLE application_events
    ADD COLUMN IF NOT EXISTS attempt_id UUID REFERENCES application_attempts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS from_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS to_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS actor VARCHAR(100) DEFAULT 'copilot',
    ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE INDEX IF NOT EXISTS idx_application_events_attempt ON application_events(attempt_id);

-- 8. Immutability Triggers
CREATE OR REPLACE FUNCTION protect_form_snapshot() RETURNS trigger AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Form snapshots are immutable; capture a new snapshot';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_form_snapshot ON form_snapshots;
CREATE TRIGGER immutable_form_snapshot BEFORE UPDATE ON form_snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_form_snapshot();

CREATE OR REPLACE FUNCTION protect_field_plan() RETURNS trigger AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Field plans are immutable; submit a new plan';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_field_plan ON field_plans;
CREATE TRIGGER immutable_field_plan BEFORE UPDATE ON field_plans
    FOR EACH ROW EXECUTE FUNCTION protect_field_plan();
