-- Migration: 004_job_radar_intelligence.sql
-- Description: Adds discovery audit observations, schedule locks, assessment status,
-- immutable analysis versions, review decisions, and shortlist reservations.

-- 1. Discovery Observations & Run Enhancements
ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS schedule_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'COMPLETED',
    ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS discovery_observations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
    source_name VARCHAR(50) NOT NULL,
    query JSONB NOT NULL,
    status VARCHAR(20) NOT NULL, -- success, partial, failed
    records_received INT DEFAULT 0,
    records_normalized INT DEFAULT 0,
    records_rejected INT DEFAULT 0,
    errors JSONB DEFAULT '[]'::jsonb,
    duration_ms INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_obs_run ON discovery_observations(run_id);
CREATE INDEX IF NOT EXISTS idx_discovery_obs_source ON discovery_observations(source_name);

-- 2. Schedule Locks for Concurrency Prevention
CREATE TABLE IF NOT EXISTS schedule_locks (
    schedule_name VARCHAR(100) PRIMARY KEY,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by UUID NOT NULL, -- run_id
    expires_at TIMESTAMPTZ NOT NULL
);

-- 3. Job Timestamp Provenance and Assessment State
ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS is_observation_age BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS date_inconsistent BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS assessment_status VARCHAR(50) DEFAULT 'ANALYSIS_PENDING';

CREATE INDEX IF NOT EXISTS idx_jobs_assessment_status ON jobs(assessment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen_at ON jobs(first_seen_at);

-- 4. Immutable Job Analysis Versions
CREATE TABLE IF NOT EXISTS job_analyses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    version_number INT NOT NULL DEFAULT 1,
    jd_snapshot_id UUID NOT NULL REFERENCES jd_snapshots(id),
    candidate_snapshot_id UUID NOT NULL REFERENCES candidate_profile_snapshots(id),
    requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes TEXT,
    created_by VARCHAR(50) DEFAULT 'antigravity',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_job_analysis_version UNIQUE (job_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_job_analyses_job ON job_analyses(job_id);

CREATE OR REPLACE FUNCTION protect_job_analysis() RETURNS trigger AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Job analysis versions are immutable; create a new version';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_job_analysis ON job_analyses;
CREATE TRIGGER immutable_job_analysis BEFORE UPDATE ON job_analyses
    FOR EACH ROW EXECUTE FUNCTION protect_job_analysis();

-- 5. Enhanced Job Scores with Analysis Lineage and Uncertainty
ALTER TABLE job_scores
    ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES job_analyses(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_provisional BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS evidence_coverage NUMERIC(5, 2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS score_band VARCHAR(50) DEFAULT 'review',
    ADD COLUMN IF NOT EXISTS factor_breakdown JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS uncertainties JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS scoring_version VARCHAR(50) DEFAULT 'v2';

-- 6. Persistent Review Queue Decisions
CREATE TABLE IF NOT EXISTS review_decisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    decision VARCHAR(50) NOT NULL, -- reviewed, tailoring, skipped, deferred
    skip_reason VARCHAR(100),
    notes TEXT,
    deferred_until TIMESTAMPTZ,
    reviewer VARCHAR(100) DEFAULT 'human',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_decisions_job ON review_decisions(job_id);
CREATE INDEX IF NOT EXISTS idx_review_decisions_decision ON review_decisions(decision);

-- 7. Shortlist Reservations and Delivery Acknowledgement
CREATE TABLE IF NOT EXISTS shortlist_reservations (
    reservation_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    batch_id UUID NOT NULL,
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    acknowledged_at TIMESTAMPTZ,
    status VARCHAR(30) NOT NULL DEFAULT 'RESERVED' -- RESERVED, ACKNOWLEDGED, EXPIRED
);

CREATE INDEX IF NOT EXISTS idx_shortlist_res_batch ON shortlist_reservations(batch_id);
CREATE INDEX IF NOT EXISTS idx_shortlist_res_job_status ON shortlist_reservations(job_id, status);
