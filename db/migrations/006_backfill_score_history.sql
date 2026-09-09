-- Preserve the current score from installations upgraded before score history
-- existed. Historical scores that were already overwritten cannot be recovered.

INSERT INTO job_score_versions (
    job_id, version_number, analysis_id, score_data, scoring_version, created_at
)
SELECT
    score.job_id,
    1,
    score.analysis_id,
    jsonb_build_object(
        'overall_score', score.overall_score,
        'recommendation', score.recommendation,
        'role_alignment', score.role_alignment,
        'experience_score', score.experience_score,
        'seniority_score', score.seniority_score,
        'skills_score', score.skills_score,
        'domain_score', score.domain_score,
        'location_score', score.location_score,
        'comp_score', score.comp_score,
        'preference_score', score.preference_score,
        'strengths', score.strengths,
        'gaps', score.gaps,
        'risks', score.risks,
        'evidence_fact_ids', score.evidence_fact_ids,
        'analysis_id', score.analysis_id,
        'is_provisional', score.is_provisional,
        'evidence_coverage', score.evidence_coverage,
        'score_band', score.score_band,
        'factor_breakdown', score.factor_breakdown,
        'uncertainties', score.uncertainties,
        'scoring_version', score.scoring_version
    ),
    COALESCE(score.scoring_version, 'legacy'),
    score.scored_at
FROM job_scores AS score
WHERE NOT EXISTS (
    SELECT 1
    FROM job_score_versions AS history
    WHERE history.job_id = score.job_id
);
