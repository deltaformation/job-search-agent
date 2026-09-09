-- Migration: 013_scheduled_briefing_integrity.sql
-- Description: Binds a briefing to its triggering discovery run and freezes audit metadata.

ALTER TABLE job_briefings
    ADD COLUMN IF NOT EXISTS trigger_run_id UUID NULL
        REFERENCES agent_runs(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_briefings_trigger_run
    ON job_briefings(trigger_run_id) WHERE trigger_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_job_briefings_content() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.schedule_name, NEW.trigger_run_id, NEW.window_started_at, NEW.window_ended_at,
           NEW.source_run_ids, NEW.metrics, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.schedule_name, OLD.trigger_run_id, OLD.window_started_at, OLD.window_ended_at,
           OLD.source_run_ids, OLD.metrics, OLD.created_at) THEN
        RAISE EXCEPTION 'job_briefings audit content is immutable; only status may change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
