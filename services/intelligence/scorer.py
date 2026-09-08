import os
import re
import yaml
from pathlib import Path
from typing import Dict, Any, List, Optional

CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "config" / "scoring.yaml"

class FitScorer:
    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = config_path or CONFIG_PATH
        self.config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        if self.config_path.exists():
            with open(self.config_path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        return {
            "weights": {
                "role_alignment": 0.25,
                "relevant_experience": 0.20,
                "seniority": 0.15,
                "required_skills": 0.15,
                "domain_relevance": 0.10,
                "location_fit": 0.05,
                "compensation_fit": 0.05,
                "preference_fit": 0.05,
            },
            "thresholds": {
                "exceptional": 90,
                "strong": 85,
                "review": 75,
                "weak": 65,
            }
        }

    def score_job(self, job: Dict[str, Any], candidate_profile: Dict[str, Any]) -> Dict[str, Any]:
        weights = self.config.get("weights", {})
        title = job.get("title", "").lower()
        normalized_title = job.get("normalized_title", "").lower()
        desc = (job.get("description") or "").lower()
        location = job.get("location", "").lower()
        remote_type = job.get("remote_type", "").lower()

        strengths = []
        gaps = []
        risks = []
        evidence_fact_ids = []

        # 1. Role Alignment (Weight: 25%)
        role_alignment = 50.0
        target_titles = [t.lower() for t in candidate_profile.get("target_titles", [])]
        if any(t in title or t in normalized_title for t in target_titles):
            role_alignment = 95.0
            strengths.append(f"Title '{job.get('title')}' strongly aligns with target roles.")
        elif "product manager" in title:
            role_alignment = 80.0
            strengths.append("General Product Manager role alignment.")
        else:
            role_alignment = 40.0
            gaps.append(f"Title '{job.get('title')}' is outside primary Product Management target.")

        # 2. Seniority (Weight: 15%)
        seniority_score = 60.0
        senior_indicators = ["senior", "sr.", "lead", "principal", "staff", "head of", "director"]
        junior_indicators = ["junior", "intern", "co-op", "associate pm", "entry level", "new grad"]
        if any(ind in title for ind in junior_indicators) or any(ind in desc[:500] for ind in junior_indicators):
            seniority_score = 20.0
            risks.append("Role appears entry-level or internship.")
        elif any(ind in title for ind in senior_indicators):
            seniority_score = 95.0
            strengths.append("Senior / Lead level role matching career trajectory.")
        elif "senior" in desc or "5+ years" in desc or "7+ years" in desc or "8+ years" in desc:
            seniority_score = 60.0
            gaps.append("JD seniority / years-of-experience requirement is unsupported until verified candidate evidence is checked.")
        else:
            seniority_score = 75.0

        # 3. Relevant Experience (Weight: 20%)
        # Matches verified achievements
        exp_score = 70.0
        facts = candidate_profile.get("verified_facts", [])
        matched_facts = []
        for fact in facts:
            fact_text = fact.get("text", "").lower()
            technologies = [t.lower() for t in fact.get("technologies", [])]
            # Check overlap between fact technologies/keywords and JD
            overlap = [t for t in technologies if t in desc]
            if len(overlap) >= 2 or ("api" in desc and "api" in fact_text) or ("cloud" in desc and "cloud" in fact_text) or ("platform" in desc and "platform" in fact_text):
                matched_facts.append(fact["fact_id"])
                evidence_fact_ids.append(fact["fact_id"])

        if len(matched_facts) >= 3:
            exp_score = 95.0
            strengths.append(f"Strong overlap with verified achievements ({', '.join(matched_facts[:3])}).")
        elif len(matched_facts) >= 1:
            exp_score = 80.0
            strengths.append(f"Relevant experience grounded in fact IDs: {', '.join(matched_facts)}.")
        else:
            exp_score = 60.0
            gaps.append("Limited direct overlap between verified achievements and specialized JD requirements.")

        # 4. Required Skills (Weight: 15%)
        skills = [s for s in candidate_profile.get("skills", []) if s.get("verified") is True]
        skills_matched = 0
        total_skills_checked = len(skills)
        for s in skills:
            skill_name = s.get("name", "").lower()
            # Match broad skill tokens
            tokens = [t for t in re.split(r'[\s/&,]+', skill_name) if len(t) > 3]
            if any(t in desc for t in tokens):
                skills_matched += 1

        skills_score = min(100.0, max(50.0, (skills_matched / max(total_skills_checked, 1)) * 110.0))
        if skills_matched >= 5:
            strengths.append(f"High technical and PM skill coverage ({skills_matched} verified skills present).")
        else:
            gaps.append(f"Moderate skill overlap ({skills_matched} skills identified in JD).")

        # 5. Domain Relevance (Weight: 10%)
        domain_keywords = ["cloud", "saas", "fintech", "api", "developer platform", "infrastructure", "b2b", "data"]
        domain_hits = [k for k in domain_keywords if k in desc]
        if len(domain_hits) >= 3:
            domain_score = 95.0
            strengths.append(f"Core technical domain alignment: {', '.join(domain_hits[:3])}.")
        elif len(domain_hits) >= 1:
            domain_score = 80.0
            strengths.append(f"Related domain keywords: {', '.join(domain_hits)}.")
        else:
            domain_score = 65.0

        # 6. Location / Remote Fit (Weight: 5%)
        location_score = 80.0
        if "canada" in location or "toronto" in location or "ontario" in location or remote_type == "remote":
            location_score = 100.0
            strengths.append("Eligible Canadian location / Remote fit.")
        elif "usa" in location or "united states" in location:
            location_score = 30.0
            risks.append("Posting indicates US location; potential visa barrier.")
        else:
            location_score = 75.0

        # 7. Compensation Fit (Weight: 5%)
        comp_score = 80.0
        min_amount = job.get("min_amount")
        max_amount = job.get("max_amount")
        if max_amount:
            if max_amount >= 150000:
                comp_score = 95.0
                strengths.append(f"Advertised compensation (${min_amount or 0:,.0f} - ${max_amount:,.0f}) meets expectations.")
            else:
                comp_score = 60.0
                gaps.append(f"Advertised maximum compensation (${max_amount:,.0f}) is below preferred threshold.")

        # 8. Preferences Fit (Weight: 5%)
        preference_score = 85.0

        # Compute overall weighted score
        overall = (
            role_alignment * weights.get("role_alignment", 0.25) +
            exp_score * weights.get("relevant_experience", 0.20) +
            seniority_score * weights.get("seniority", 0.15) +
            skills_score * weights.get("required_skills", 0.15) +
            domain_score * weights.get("domain_relevance", 0.10) +
            location_score * weights.get("location_fit", 0.05) +
            comp_score * weights.get("compensation_fit", 0.05) +
            preference_score * weights.get("preference_fit", 0.05)
        )
        overall_score = round(overall, 1)

        # Recommendation based on thresholds
        thresholds = self.config.get("thresholds", {})
        if overall_score >= thresholds.get("strong", 85):
            recommendation = "apply"
        elif overall_score >= thresholds.get("review", 75):
            recommendation = "review"
        else:
            recommendation = "skip"

        return {
            "overall_score": overall_score,
            "recommendation": recommendation,
            "role_alignment": round(role_alignment, 1),
            "experience_score": round(exp_score, 1),
            "seniority_score": round(seniority_score, 1),
            "skills_score": round(skills_score, 1),
            "domain_score": round(domain_score, 1),
            "location_score": round(location_score, 1),
            "comp_score": round(comp_score, 1),
            "preference_score": round(preference_score, 1),
            "strengths": strengths,
            "gaps": gaps,
            "risks": risks,
            "evidence_fact_ids": list(set(evidence_fact_ids))
        }
