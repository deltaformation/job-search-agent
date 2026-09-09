from scripts.show_candidate_profile import build_summary


def test_build_summary_preserves_only_observed_profile_values() -> None:
    profile = {
        "full_name": "Test Candidate",
        "email": "candidate@example.test",
        "phone": "+1-555-0100",
        "location": "Toronto",
        "work_experience": [{"company": "Example", "role": "Product Manager", "id": "hidden"}],
        "verified_facts": [{"fact_id": "fact_test", "text": "Verified statement", "id": "hidden"}],
        "skills": [{"name": "Discovery"}],
        "preferences": {"target": "remote"},
    }

    summary = build_summary(profile)

    assert summary["work_experience"] == [{"company": "Example", "role": "Product Manager"}]
    assert summary["verified_facts"] == [
        {"fact_id": "fact_test", "text": "Verified statement"}
    ]
    assert summary["skills_count"] == 1
    assert "id" not in summary["work_experience"][0]
