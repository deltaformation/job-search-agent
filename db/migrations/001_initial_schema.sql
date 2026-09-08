-- Migration: 001_initial_schema.sql
-- Description: Complete local-first relational schema for Candidate Memory, Job Pipeline, Scoring, and Applications

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================================
-- 1. CANDIDATE PROFILE & VERIFIED CAREER FACTS
-- ==========================================================

CREATE TABLE IF NOT EXISTS candidate_profile (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    headline VARCHAR(255),
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    location VARCHAR(255) NOT NULL,
    target_titles JSONB DEFAULT '[]'::jsonb,
    target_locations JSONB DEFAULT '[]'::jsonb,
    summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS work_experience (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    company VARCHAR(255) NOT NULL,
    role VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    start_date DATE NOT NULL,
    end_date DATE,
    is_current BOOLEAN DEFAULT FALSE,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS achievements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fact_id VARCHAR(100) UNIQUE NOT NULL, -- e.g. "fact_001"
    work_experience_id UUID REFERENCES work_experience(id) ON DELETE SET NULL,
    category VARCHAR(100) DEFAULT 'achievement',
    text TEXT NOT NULL,
    technologies JSONB DEFAULT '[]'::jsonb,
    metrics JSONB DEFAULT '[]'::jsonb,
    verification_status VARCHAR(50) DEFAULT 'approved', -- approved, draft, rejected
    source VARCHAR(255) DEFAULT 'candidate_canonical_profile',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    fact_id VARCHAR(100) UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(255),
    description TEXT NOT NULL,
    technologies JSONB DEFAULT '[]'::jsonb,
    url VARCHAR(500),
    metrics JSONB DEFAULT '[]'::jsonb,
    verification_status VARCHAR(50) DEFAULT 'approved',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL, -- product, technical, leadership, domain
    name VARCHAR(150) NOT NULL,
    proficiency_level VARCHAR(50) DEFAULT 'expert', -- expert, proficient, familiar
    years_experience NUMERIC(4, 1),
    verified BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS education (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    degree VARCHAR(255) NOT NULL,
    field_of_study VARCHAR(255) NOT NULL,
    institution VARCHAR(255) NOT NULL,
    start_date DATE,
    end_date DATE,
    gpa VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    issuer VARCHAR(255) NOT NULL,
    issue_date DATE,
    expiry_date DATE,
    credential_id VARCHAR(255),
    url VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_preference_key UNIQUE (candidate_id, key)
);

CREATE TABLE IF NOT EXISTS standard_answers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    question_pattern VARCHAR(500) NOT NULL,
    answer_text TEXT NOT NULL,
    is_sensitive BOOLEAN DEFAULT FALSE,
    requires_human_approval BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================================
-- 2. JOBS, SOURCES, AND DISCOVERY PIPELINE
-- ==========================================================

CREATE TABLE IF NOT EXISTS jobs (
    job_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source VARCHAR(50) NOT NULL,
    source_job_id VARCHAR(255),
    canonical_url TEXT NOT NULL,
    apply_url TEXT,
    company VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    normalized_title VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    remote_type VARCHAR(50) DEFAULT 'unknown', -- remote, hybrid, onsite, unknown
    employment_type VARCHAR(50) DEFAULT 'full_time',
    posted_at TIMESTAMPTZ,
    posted_at_source VARCHAR(100),
    posted_at_confidence NUMERIC(3, 2) DEFAULT 1.0,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    age_hours NUMERIC(6, 1) DEFAULT 0.0,
    freshness_bucket VARCHAR(20) DEFAULT 'HOT', -- HOT (0-24), FRESH (24-48), RECENT (48-72), STALE (>72)
    description TEXT,
    ats_type VARCHAR(100),
    requirements JSONB DEFAULT '[]'::jsonb,
    preferred_requirements JSONB DEFAULT '[]'::jsonb,
    keywords JSONB DEFAULT '[]'::jsonb,
    content_hash VARCHAR(64) NOT NULL,
    status VARCHAR(50) DEFAULT 'NEW',
    min_amount NUMERIC(12, 2),
    max_amount NUMERIC(12, 2),
    currency VARCHAR(10),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_canonical_url UNIQUE (canonical_url)
);

CREATE INDEX IF NOT EXISTS idx_jobs_freshness ON jobs(freshness_bucket);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_company_title ON jobs(company, normalized_title);
CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs(content_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at DESC);

CREATE TABLE IF NOT EXISTS job_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    source_name VARCHAR(100) NOT NULL,
    source_url TEXT NOT NULL,
    source_job_id VARCHAR(255),
    observed_at TIMESTAMPTZ DEFAULT NOW(),
    raw_payload JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_job_sources_job_id ON job_sources(job_id);

CREATE TABLE IF NOT EXISTS job_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    from_status VARCHAR(50),
    to_status VARCHAR(50),
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);

CREATE TABLE IF NOT EXISTS job_requirements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    requirement_type VARCHAR(50) DEFAULT 'required', -- required, preferred
    description TEXT NOT NULL,
    candidate_fact_id VARCHAR(100) REFERENCES achievements(fact_id) ON DELETE SET NULL,
    match_status VARCHAR(50) DEFAULT 'unsupported', -- matched, partial, unsupported, gap
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    overall_score NUMERIC(5, 2) NOT NULL,
    recommendation VARCHAR(50) NOT NULL, -- apply, review, skip
    role_alignment NUMERIC(5, 2) NOT NULL,
    experience_score NUMERIC(5, 2) NOT NULL,
    seniority_score NUMERIC(5, 2) NOT NULL,
    skills_score NUMERIC(5, 2) NOT NULL,
    domain_score NUMERIC(5, 2) NOT NULL,
    location_score NUMERIC(5, 2) NOT NULL,
    comp_score NUMERIC(5, 2) NOT NULL,
    preference_score NUMERIC(5, 2) NOT NULL,
    strengths JSONB DEFAULT '[]'::jsonb,
    gaps JSONB DEFAULT '[]'::jsonb,
    risks JSONB DEFAULT '[]'::jsonb,
    evidence_fact_ids JSONB DEFAULT '[]'::jsonb,
    scored_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_job_score UNIQUE (job_id)
);

-- ==========================================================
-- 3. APPLICATIONS, DOCUMENTS, AND AUDIT TRAIL
-- ==========================================================

CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'APPLICATION_STARTED',
    applied_at TIMESTAMPTZ,
    submission_mode VARCHAR(50) DEFAULT 'manual', -- manual, human_approved_autofill
    ats_detected VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_application_job UNIQUE (job_id)
);

CREATE TABLE IF NOT EXISTS application_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS screening_answers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    confidence NUMERIC(3, 2) DEFAULT 1.0,
    human_approved BOOLEAN DEFAULT FALSE,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resume_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
    job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    base_version VARCHAR(100) DEFAULT 'canonical_v1',
    tailored_text TEXT NOT NULL,
    pdf_path TEXT,
    fact_ids_used JSONB DEFAULT '[]'::jsonb,
    diff_summary TEXT,
    approved_by_human BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
    doc_type VARCHAR(50) NOT NULL, -- cover_letter, portfolio, other
    file_path TEXT,
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(50) NOT NULL, -- job, resume, screening_answer, submission
    entity_id UUID NOT NULL,
    decision VARCHAR(50) NOT NULL, -- approved, rejected, revision_requested
    notes TEXT,
    reviewer VARCHAR(100) DEFAULT 'human',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_type VARCHAR(50) NOT NULL, -- morning_scan, evening_scan, manual, triage, apply
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    sources_used JSONB DEFAULT '[]'::jsonb,
    jobs_found INT DEFAULT 0,
    jobs_new INT DEFAULT 0,
    jobs_duplicate INT DEFAULT 0,
    jobs_stale INT DEFAULT 0,
    jobs_scored INT DEFAULT 0,
    jobs_qualified INT DEFAULT 0,
    documents_generated INT DEFAULT 0,
    errors JSONB DEFAULT '[]'::jsonb,
    summary JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
