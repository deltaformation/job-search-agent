-- Migration: 014_standard_resume_keyword_lineage.sql
-- Description: Persists standard-template and keyword-plan lineage on resume
-- versions and adds the append-only human-approved wording-variant store.
-- New lineage columns stay NULL on historical rows: existing artifacts are
-- never relabeled as mouad_standard_v1 and no historical hashes are fabricated.

ALTER TABLE resume_versions
    ADD COLUMN IF NOT EXISTS template_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS template_version VARCHAR(50),
    ADD COLUMN IF NOT EXISTS template_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS render_schema_version VARCHAR(50) DEFAULT 'v1',
    ADD COLUMN IF NOT EXISTS ranking_policy_version VARCHAR(50),
    ADD COLUMN IF NOT EXISTS keyword_plan JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS keyword_coverage_report JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS summary_derivation JSONB DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS candidate_wording_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    fact_ids JSONB NOT NULL,
    variant_text TEXT NOT NULL,
    normalized_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
    content_hash VARCHAR(64) NOT NULL,
    review_status VARCHAR(50) NOT NULL DEFAULT 'proposed',
    reviewer VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wording_variants_candidate
    ON candidate_wording_variants(candidate_id, review_status);

CREATE OR REPLACE FUNCTION protect_resume_content() RETURNS trigger AS $$
BEGIN
    IF ROW(NEW.job_id, NEW.version_number, NEW.parent_version_id, NEW.content_hash,
           NEW.tailored_text, NEW.structured_content, NEW.claim_evidence_map,
           NEW.fact_ids_used, NEW.base_version, NEW.baseline_text, NEW.diff_summary,
           NEW.profile_snapshot_id, NEW.jd_snapshot_id, NEW.requirements_snapshot,
           NEW.template_id, NEW.template_version, NEW.template_hash,
           NEW.render_schema_version, NEW.ranking_policy_version,
           NEW.keyword_plan, NEW.keyword_coverage_report, NEW.summary_derivation)
       IS DISTINCT FROM
       ROW(OLD.job_id, OLD.version_number, OLD.parent_version_id, OLD.content_hash,
           OLD.tailored_text, OLD.structured_content, OLD.claim_evidence_map,
           OLD.fact_ids_used, OLD.base_version, OLD.baseline_text, OLD.diff_summary,
           OLD.profile_snapshot_id, OLD.jd_snapshot_id, OLD.requirements_snapshot,
           OLD.template_id, OLD.template_version, OLD.template_hash,
           OLD.render_schema_version, OLD.ranking_policy_version,
           OLD.keyword_plan, OLD.keyword_coverage_report, OLD.summary_derivation) THEN
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

-- Wording variants are append-only: approved records can never be edited or
-- deleted through ordinary writes. Only the human review flow transitions
-- review_status, and it never mutates variant text.
CREATE OR REPLACE FUNCTION protect_wording_variant() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.candidate_id, NEW.fact_ids, NEW.variant_text,
               NEW.normalized_keywords, NEW.content_hash, NEW.created_at)
           IS DISTINCT FROM
           ROW(OLD.candidate_id, OLD.fact_ids, OLD.variant_text,
               OLD.normalized_keywords, OLD.content_hash, OLD.created_at) THEN
            RAISE EXCEPTION 'Wording variant content is immutable; propose a new variant';
        END IF;
        IF OLD.review_status = 'approved' AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'Approved wording variants are immutable';
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Wording variants cannot be deleted';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_wording_variant ON candidate_wording_variants;
CREATE TRIGGER immutable_wording_variant BEFORE UPDATE OR DELETE ON candidate_wording_variants
    FOR EACH ROW EXECUTE FUNCTION protect_wording_variant();
