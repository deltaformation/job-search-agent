from services.intelligence.scorer import FitScorer

def test_scorer_strong_match():
    scorer = FitScorer()
    candidate_profile = {
        "target_titles": ["Senior Product Manager", "Technical Product Manager"],
        "verified_facts": [
            {
                "fact_id": "fact_001",
                "text": "Architected distributed API platform scaling to 50M daily requests.",
                "technologies": ["AWS", "PostgreSQL", "Kafka", "REST APIs"]
            },
            {
                "fact_id": "fact_002",
                "text": "Enterprise developer portal monetization driving $3.2M ARR.",
                "technologies": ["GraphQL", "Stripe API"]
            }
        ],
        "skills": [
            {"name": "Technical Product Management", "years_experience": 6.0},
            {"name": "Cloud Architecture (AWS / GCP)", "years_experience": 7.0},
            {"name": "PostgreSQL & Relational Data Modeling", "years_experience": 8.0}
        ]
    }

    job = {
        "title": "Senior Technical Product Manager - Cloud & APIs",
        "normalized_title": "Senior Technical Product Manager",
        "description": "Looking for a Senior Technical Product Manager with 5+ years building AWS cloud APIs and Kafka distributed pipelines. Toronto based or remote Canada.",
        "location": "Toronto, ON, Canada",
        "remote_type": "remote",
        "max_amount": 175000
    }

    result = scorer.score_job(job, candidate_profile)
    assert result["overall_score"] >= 85.0
    assert result["recommendation"] == "apply"
    assert "fact_001" in result["evidence_fact_ids"]
    assert len(result["strengths"]) >= 3

def test_scorer_weak_match():
    scorer = FitScorer()
    candidate_profile = {
        "target_titles": ["Senior Product Manager"],
        "verified_facts": [],
        "skills": []
    }

    job = {
        "title": "Junior UX Designer Intern",
        "normalized_title": "Junior UX Designer Intern",
        "description": "Figma design internship for college students located in Austin, Texas.",
        "location": "Austin, TX, USA",
        "remote_type": "onsite",
        "max_amount": 40000
    }

    result = scorer.score_job(job, candidate_profile)
    assert result["overall_score"] < 65.0
    assert result["recommendation"] == "skip"
    assert len(result["risks"]) >= 1
