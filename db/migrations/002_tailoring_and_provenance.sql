-- Migration: 002_tailoring_and_provenance.sql
-- Description: Adds snapshots, structured claim-level provenance, requirement extraction, and tamper-proof approval tracking

-- 1. Immutable Baseline Profile Snapshots
CREATE TABLE IF NOT EXISTS candidate_profile_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    snapshot_hash VARCHAR(64) NOT NULL,
    profile_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_snapshots_candidate ON candidate_profile_snapshots(candidate_id);

-- 2. Immutable Job Description Snapshots
CREATE TABLE IF NOT EXISTS jd_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    content_hash VARCHAR(64) NOT NULL,
    raw_text TEXT NOT NULL,
    cleaned_text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_job_jd_snapshot UNIQUE (job_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_jd_snapshots_job ON jd_snapshots(job_id);

-- 3. Enhance job_requirements with Structured Extraction & Provenance Fields
ALTER TABLE job_requirements
    ADD COLUMN IF NOT EXISTS requirement_id VARCHAR(50),
    ADD COLUMN IF NOT EXISTS jd_quote TEXT,
    ADD COLUMN IF NOT EXISTS classification VARCHAR(50) DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS is_required BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS matched_fact_ids JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS omitted_from_base_resume BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS analysis_notes TEXT;

-- 4. Enhance resume_versions with Lineage, Claim Mapping & Hashing
ALTER TABLE resume_versions
    ADD COLUMN IF NOT EXISTS version_number INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS parent_version_id UUID REFERENCES resume_versions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS structured_content JSONB,
    ADD COLUMN IF NOT EXISTS claim_evidence_map JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS validation_status VARCHAR(30) DEFAULT 'DRAFT',
    ADD COLUMN IF NOT EXISTS validation_report JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS html_path TEXT,
    ADD COLUMN IF NOT EXISTS human_approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS human_reviewer VARCHAR(255),
    ADD COLUMN IF NOT EXISTS approval_signature VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_resume_versions_job_status ON resume_versions(job_id, validation_status);

-- 5. Enhance document_versions (Cover Letters & Supporting Docs)
ALTER TABLE document_versions
    ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(job_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS version_number INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS structured_content JSONB,
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'DRAFT';
