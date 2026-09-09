-- Close concurrency and input-integrity gaps found during the radar review.

-- Repair any duplicate active reservations created before atomic reservation
-- enforcement. The oldest reservation remains active for delivery.
WITH ranked AS (
    SELECT reservation_id,
           ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY reserved_at, reservation_id) AS position
    FROM shortlist_reservations
    WHERE status = 'RESERVED'
)
UPDATE shortlist_reservations AS reservation
SET status = 'EXPIRED'
FROM ranked
WHERE reservation.reservation_id = ranked.reservation_id
  AND ranked.position > 1;

UPDATE shortlist_reservations
SET status = 'EXPIRED'
WHERE status = 'RESERVED' AND expires_at <= NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uq_shortlist_active_reservation
    ON shortlist_reservations(job_id)
    WHERE status = 'RESERVED';

ALTER TABLE shortlist_reservations
    DROP CONSTRAINT IF EXISTS shortlist_reservations_status_check,
    ADD CONSTRAINT shortlist_reservations_status_check
        CHECK (status IN ('RESERVED', 'ACKNOWLEDGED', 'EXPIRED'));

ALTER TABLE review_decisions
    DROP CONSTRAINT IF EXISTS review_decisions_decision_check,
    ADD CONSTRAINT review_decisions_decision_check
        CHECK (decision IN ('reviewed', 'tailoring', 'skipped', 'deferred')),
    DROP CONSTRAINT IF EXISTS review_decisions_skip_reason_check,
    ADD CONSTRAINT review_decisions_skip_reason_check
        CHECK (decision <> 'skipped' OR NULLIF(BTRIM(skip_reason), '') IS NOT NULL),
    DROP CONSTRAINT IF EXISTS review_decisions_deferred_until_check,
    ADD CONSTRAINT review_decisions_deferred_until_check
        CHECK (decision <> 'deferred' OR deferred_until IS NOT NULL);

-- Keep the current score in job_scores for efficient reads while preserving
-- every scoring input and its analysis lineage for audit and reproduction.
CREATE TABLE IF NOT EXISTS job_score_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    analysis_id UUID REFERENCES job_analyses(id) ON DELETE SET NULL,
    score_data JSONB NOT NULL,
    scoring_version VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_job_score_version UNIQUE (job_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_job_score_versions_job
    ON job_score_versions(job_id, version_number DESC);

CREATE OR REPLACE FUNCTION protect_job_score_version() RETURNS trigger AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Job score versions are immutable; create a new version';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_job_score_version ON job_score_versions;
CREATE TRIGGER immutable_job_score_version BEFORE UPDATE ON job_score_versions
    FOR EACH ROW EXECUTE FUNCTION protect_job_score_version();
