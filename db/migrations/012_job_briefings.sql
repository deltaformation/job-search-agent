-- Migration: 012_job_briefings.sql
-- Description: Adds job_briefings and job_briefing_items tables for morning job dashboard with snapshot freezing and audit immutability triggers.

CREATE TABLE IF NOT EXISTS job_briefings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    schedule_name VARCHAR(100) NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    window_ended_at TIMESTAMPTZ NOT NULL,
    source_run_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'SUPERSEDED')),
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_briefing_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    briefing_id UUID NOT NULL REFERENCES job_briefings(id) ON DELETE RESTRICT,
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
    rank INT NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_briefing_item_briefing_job UNIQUE (briefing_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_briefings_schedule_created ON job_briefings(schedule_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_briefings_status ON job_briefings(status);
CREATE INDEX IF NOT EXISTS idx_job_briefing_items_briefing_rank ON job_briefing_items(briefing_id, rank);
CREATE INDEX IF NOT EXISTS idx_job_briefing_items_job ON job_briefing_items(job_id);

-- Foreign key linking preparation_requests to job_briefings if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_prep_requests_briefing'
    ) THEN
        ALTER TABLE preparation_requests
            ADD CONSTRAINT fk_prep_requests_briefing
            FOREIGN KEY (briefing_id) REFERENCES job_briefings(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Immutability Triggers
-- 1. Protect job_briefing_items: strictly immutable once inserted
CREATE OR REPLACE FUNCTION protect_job_briefing_items() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'job_briefing_items is strictly append-only and frozen; modifying or deleting items is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_job_briefing_items_update ON job_briefing_items;
CREATE TRIGGER trg_protect_job_briefing_items_update BEFORE UPDATE OR DELETE ON job_briefing_items
    FOR EACH ROW EXECUTE FUNCTION protect_job_briefing_items();

-- 2. Protect job_briefings: can update status (e.g. ACKNOWLEDGED, SUPERSEDED), but window and schedule are immutable
CREATE OR REPLACE FUNCTION protect_job_briefings_content() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.schedule_name, NEW.window_started_at, NEW.window_ended_at, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.schedule_name, OLD.window_started_at, OLD.window_ended_at, OLD.created_at) THEN
        RAISE EXCEPTION 'job_briefings window and schedule are immutable; cannot alter historical briefing parameters';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_job_briefings_content ON job_briefings;
CREATE TRIGGER trg_protect_job_briefings_content BEFORE UPDATE ON job_briefings
    FOR EACH ROW EXECUTE FUNCTION protect_job_briefings_content();
