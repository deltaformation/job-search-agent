-- Bind generated resume versions to the exact job analysis used as input.

ALTER TABLE resume_versions
    ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES job_analyses(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_resume_versions_analysis
    ON resume_versions(analysis_id);

-- Backfill only when one analysis version exactly matches the persisted
-- requirements snapshot. Ambiguous or unmatched historical rows remain NULL
-- and must be regenerated before guarded application preparation.
UPDATE resume_versions AS resume
SET analysis_id = (
    SELECT analysis.id
    FROM job_analyses AS analysis
    WHERE analysis.job_id = resume.job_id
      AND analysis.requirements = resume.requirements_snapshot
    ORDER BY analysis.version_number DESC
    LIMIT 1
)
WHERE resume.analysis_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM job_analyses AS analysis
      WHERE analysis.job_id = resume.job_id
        AND analysis.requirements = resume.requirements_snapshot
  );

CREATE OR REPLACE FUNCTION protect_resume_content() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.job_id, NEW.version_number, NEW.parent_version_id, NEW.content_hash,
           NEW.tailored_text, NEW.structured_content, NEW.claim_evidence_map,
           NEW.fact_ids_used, NEW.base_version, NEW.baseline_text, NEW.diff_summary,
           NEW.profile_snapshot_id, NEW.jd_snapshot_id, NEW.requirements_snapshot,
           NEW.analysis_id)
       IS DISTINCT FROM
       ROW(OLD.job_id, OLD.version_number, OLD.parent_version_id, OLD.content_hash,
           OLD.tailored_text, OLD.structured_content, OLD.claim_evidence_map,
           OLD.fact_ids_used, OLD.base_version, OLD.baseline_text, OLD.diff_summary,
           OLD.profile_snapshot_id, OLD.jd_snapshot_id, OLD.requirements_snapshot,
           OLD.analysis_id) THEN
        RAISE EXCEPTION 'Resume content is immutable; create a new version';
    END IF;
    IF OLD.approved_by_human AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Approved resume versions are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
