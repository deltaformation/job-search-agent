-- Seed: 001_candidate_seed.sql
-- Description: Canonical verified candidate profile with strict Fact-ID provenance

DO $$
DECLARE
    v_candidate_id UUID;
    v_exp_1 UUID;
    v_exp_2 UUID;
    v_exp_3 UUID;
BEGIN
    -- Check if candidate already exists
    IF NOT EXISTS (SELECT 1 FROM candidate_profile WHERE email = 'mouad.atfi@example.com') THEN
        
        -- 1. Insert Candidate Profile
        INSERT INTO candidate_profile (
            full_name, headline, email, phone, location, target_titles, target_locations, summary
        ) VALUES (
            'Mouad Atfi',
            'Senior / Technical Product Manager | Cloud, Platform & Data Systems',
            'mouad.atfi@example.com',
            '+1-647-000-0000',
            'Toronto, ON, Canada',
            '["Senior Product Manager", "Technical Product Manager", "Product Manager, Technical", "Lead Product Manager"]'::jsonb,
            '["Toronto, ON", "Ontario", "Remote Canada"]'::jsonb,
            'Experienced Technical Product Manager with 8+ years leading cross-functional engineering, data, and design teams to build scalable cloud architectures, developer platforms, and enterprise data solutions.'
        ) RETURNING id INTO v_candidate_id;

        -- 2. Insert Work Experiences
        INSERT INTO work_experience (
            candidate_id, company, role, location, start_date, end_date, is_current, description
        ) VALUES (
            v_candidate_id,
            'FinTech Cloud Solutions',
            'Senior Technical Product Manager',
            'Toronto, ON',
            '2021-03-01',
            NULL,
            TRUE,
            'Leading core platform infrastructure and developer experience APIs serving Tier-1 financial institutions.'
        ) RETURNING id INTO v_exp_1;

        INSERT INTO work_experience (
            candidate_id, company, role, location, start_date, end_date, is_current, description
        ) VALUES (
            v_candidate_id,
            'Enterprise SaaS Inc.',
            'Product Manager, Technical',
            'Toronto, ON',
            '2018-06-01',
            '2021-02-28',
            FALSE,
            'Managed high-throughput distributed event streaming and analytics pipelines.'
        ) RETURNING id INTO v_exp_2;

        INSERT INTO work_experience (
            candidate_id, company, role, location, start_date, end_date, is_current, description
        ) VALUES (
            v_candidate_id,
            'OmniTech Digital',
            'Software Engineer & Technical Lead',
            'Toronto, ON',
            '2016-01-01',
            '2018-05-31',
            FALSE,
            'Built backend microservices and modernized legacy monolithic systems to AWS cloud.'
        ) RETURNING id INTO v_exp_3;

        -- 3. Insert Verified Achievements (Immutable Career Fact IDs)
        INSERT INTO achievements (
            fact_id, work_experience_id, category, text, technologies, metrics, verification_status, source
        ) VALUES
        (
            'fact_001',
            v_exp_1,
            'platform_scale',
            'Architected and launched a distributed multi-region API platform reducing p99 latency by 42% while scaling to 50M+ daily requests.',
            '["AWS", "PostgreSQL", "Kafka", "REST APIs", "Kubernetes"]'::jsonb,
            '["42% latency reduction", "50M daily requests"]'::jsonb,
            'approved',
            'performance_review_2023'
        ),
        (
            'fact_002',
            v_exp_1,
            'revenue_growth',
            'Spearheaded enterprise developer portal monetization strategy, driving $3.2M ARR in new customer contract value within 14 months of release.',
            '["Stripe API", "GraphQL", "OAuth2", "Data Analytics"]'::jsonb,
            '["$3.2M ARR", "14 months"]'::jsonb,
            'approved',
            'annual_report_2023'
        ),
        (
            'fact_003',
            v_exp_1,
            'team_leadership',
            'Led cross-functional agile squad of 14 senior software engineers, QA leads, and product designers with consistent 95%+ sprint commitment reliability.',
            '["Jira", "Scrum", "Roadmapping", "OKRs"]'::jsonb,
            '["14 engineers/designers", "95% sprint reliability"]'::jsonb,
            'approved',
            'engineering_review'
        ),
        (
            'fact_004',
            v_exp_2,
            'data_infrastructure',
            'Designed self-serve data ingestion engine migrating 120TB+ legacy SQL data to event-driven pipeline, cutting ingestion pipeline failures by 80%.',
            '["PostgreSQL", "Apache Kafka", "Docker", "Python", "Airflow"]'::jsonb,
            '["120TB data migrated", "80% failure reduction"]'::jsonb,
            'approved',
            'platform_architecture_review'
        ),
        (
            'fact_005',
            v_exp_2,
            'customer_adoption',
            'Delivered enterprise RBAC and SOC2 compliance automation, unblocking sales cycles for 28 Fortune 500 accounts.',
            '["SOC2", "RBAC", "Security Audits", "SAML"]'::jsonb,
            '["28 Fortune 500 accounts unblocked"]'::jsonb,
            'approved',
            'sales_enablement_audit'
        ),
        (
            'fact_006',
            v_exp_3,
            'engineering_modernization',
            'Migrated core billing monolith into 6 decoupled microservices deployed via automated CI/CD pipelines, lowering deployment lead time from 14 days to 2 hours.',
            '["Node.js", "Docker", "GitHub Actions", "Terraform", "PostgreSQL"]'::jsonb,
            '["14 days to 2 hours deployment time"]'::jsonb,
            'approved',
            'cto_quarterly_review'
        );

        -- 4. Insert Verified Skills
        INSERT INTO skills (candidate_id, category, name, proficiency_level, years_experience, verified) VALUES
        (v_candidate_id, 'product', 'Technical Product Management', 'expert', 6.0, TRUE),
        (v_candidate_id, 'product', 'Product Roadmapping & Strategy', 'expert', 7.0, TRUE),
        (v_candidate_id, 'product', 'Cross-functional Agile / Scrum', 'expert', 8.0, TRUE),
        (v_candidate_id, 'technical', 'Cloud Architecture (AWS / GCP)', 'expert', 7.0, TRUE),
        (v_candidate_id, 'technical', 'PostgreSQL & Relational Data Modeling', 'expert', 8.0, TRUE),
        (v_candidate_id, 'technical', 'System Architecture & REST / GraphQL APIs', 'expert', 8.0, TRUE),
        (v_candidate_id, 'technical', 'Distributed Systems & Event-Driven Pipelines (Kafka)', 'proficient', 5.0, TRUE),
        (v_candidate_id, 'leadership', 'Team Mentorship & Stakeholder Management', 'expert', 6.0, TRUE);

        -- 5. Insert Education
        INSERT INTO education (candidate_id, degree, field_of_study, institution, start_date, end_date) VALUES
        (v_candidate_id, 'Bachelor of Science', 'Computer Science & Software Engineering', 'University of Toronto', '2011-09-01', '2015-06-30');

        -- 6. Insert Preferences
        INSERT INTO preferences (candidate_id, key, value) VALUES
        (v_candidate_id, 'work_authorization', '{"status": "Citizen / Permanent Resident", "country": "Canada", "visa_sponsorship_needed": false}'::jsonb),
        (v_candidate_id, 'target_locations', '["Toronto, ON", "Greater Toronto Area", "Remote Canada"]'::jsonb),
        (v_candidate_id, 'min_compensation_cad', '{"base": 150000, "currency": "CAD"}'::jsonb);

        -- 7. Insert Standard Answers (with sensitivity & human approval flags)
        INSERT INTO standard_answers (candidate_id, category, question_pattern, answer_text, is_sensitive, requires_human_approval) VALUES
        (v_candidate_id, 'work_auth', 'Are you legally authorized to work in Canada?', 'Yes', FALSE, FALSE),
        (v_candidate_id, 'sponsorship', 'Will you now or in the future require visa sponsorship?', 'No', FALSE, FALSE),
        (v_candidate_id, 'location', 'Where are you currently located?', 'Toronto, Ontario, Canada', FALSE, FALSE),
        (v_candidate_id, 'salary', 'What are your salary expectations?', 'Competitive for Senior Product Manager roles in Canada (approx $160,000 - $190,000 CAD base)', TRUE, TRUE),
        (v_candidate_id, 'notice_period', 'What is your notice period?', '2 to 3 weeks', FALSE, FALSE);

    END IF;
END $$;
