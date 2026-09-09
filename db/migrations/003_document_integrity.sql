-- Persist exact generation inputs and rendered artifact digests.
ALTER TABLE resume_versions
    ADD COLUMN IF NOT EXISTS profile_snapshot_id UUID REFERENCES candidate_profile_snapshots(id),
    ADD COLUMN IF NOT EXISTS jd_snapshot_id UUID REFERENCES jd_snapshots(id),
    ADD COLUMN IF NOT EXISTS baseline_text TEXT,
    ADD COLUMN IF NOT EXISTS requirements_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS pdf_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS html_hash VARCHAR(64);

-- Input snapshots and resume content are append-only. A new draft is a new row.
CREATE OR REPLACE FUNCTION protect_document_snapshot() RETURNS trigger AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Document input snapshots are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS immutable_profile_snapshot ON candidate_profile_snapshots;
CREATE TRIGGER immutable_profile_snapshot BEFORE UPDATE ON candidate_profile_snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_document_snapshot();
DROP TRIGGER IF EXISTS immutable_jd_snapshot ON jd_snapshots;
CREATE TRIGGER immutable_jd_snapshot BEFORE UPDATE ON jd_snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_document_snapshot();

CREATE OR REPLACE FUNCTION protect_resume_content() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.job_id, NEW.version_number, NEW.parent_version_id, NEW.content_hash,
           NEW.tailored_text, NEW.structured_content, NEW.claim_evidence_map,
           NEW.fact_ids_used, NEW.base_version, NEW.baseline_text, NEW.diff_summary,
           NEW.profile_snapshot_id, NEW.jd_snapshot_id, NEW.requirements_snapshot)
       IS DISTINCT FROM
       ROW(OLD.job_id, OLD.version_number, OLD.parent_version_id, OLD.content_hash,
           OLD.tailored_text, OLD.structured_content, OLD.claim_evidence_map,
           OLD.fact_ids_used, OLD.base_version, OLD.baseline_text, OLD.diff_summary,
           OLD.profile_snapshot_id, OLD.jd_snapshot_id, OLD.requirements_snapshot) THEN
        RAISE EXCEPTION 'Resume content is immutable; create a new version';
    END IF;
    IF OLD.approved_by_human AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Approved resume versions are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS immutable_resume_content ON resume_versions;
CREATE TRIGGER immutable_resume_content BEFORE UPDATE ON resume_versions
    FOR EACH ROW EXECUTE FUNCTION protect_resume_content();
