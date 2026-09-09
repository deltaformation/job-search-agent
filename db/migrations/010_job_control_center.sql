-- Migration: 010_job_control_center.sql
-- Description: Adds preparation_requests table for idempotent orchestration of
-- analysis, tailoring, and review preparations, and adds keyword_coverage to job_scores.

CREATE TABLE IF NOT EXISTS preparation_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    briefing_id UUID NULL,
    requested_by VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN (
            'QUEUED', 'ANALYZING', 'TAILORING', 'READY_FOR_REVIEW',
            'BLOCKED', 'FAILED', 'SUPERSEDED'
        )),
    analysis_id UUID NULL REFERENCES job_analyses(id) ON DELETE SET NULL,
    resume_version_id UUID NULL REFERENCES resume_versions(id) ON DELETE SET NULL,
    error_summary TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_preparation_request_job_idempotency UNIQUE (job_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_preparation_requests_job ON preparation_requests(job_id);
CREATE INDEX IF NOT EXISTS idx_preparation_requests_status ON preparation_requests(status);
CREATE INDEX IF NOT EXISTS idx_preparation_requests_idempotency ON preparation_requests(idempotency_key);

ALTER TABLE job_scores
    ADD COLUMN IF NOT EXISTS keyword_coverage JSONB DEFAULT NULL;
