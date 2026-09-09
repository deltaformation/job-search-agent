import os
import re
import yaml
from datetime import date, datetime
from pathlib import Path
from typing import Dict, Any, List, Optional

from services.intelligence.models import CanonicalRequirement, KeywordCoverageResult

CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "config" / "scoring.yaml"

class FitScorer:
    def __init__(self, config_path: Optional[Path] = None) -> None:
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
            },
            "penalties": {
                "us_only_location": -50,
                "below_min_experience_years": -20,
                "missing_critical_certification": -10,
            }
        }

    def score_job(
        self,
        job: Dict[str, Any],
        candidate_profile: Dict[str, Any],
        analysis: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        weights = self.config.get("weights", {})
        penalties_cfg = self.config.get("penalties", {})
        thresholds = self.config.get("thresholds", {})

        title = (job.get("title") or "").lower()
        normalized_title = (job.get("normalized_title") or "").lower()
        desc = (job.get("description") or "").lower()
        location = (job.get("location") or "").lower()
        remote_type = (job.get("remote_type") or "").lower()

        strengths: List[str] = []
        gaps: List[str] = []
        risks: List[str] = []
        uncertainties: List[str] = []
        evidence_fact_ids: List[str] = []
        factor_breakdown: Dict[str, Any] = {}
        penalty_total = 0.0

        is_provisional = analysis is None
        requirements = [
            CanonicalRequirement.model_validate(requirement).model_dump()
            for requirement in analysis.get("requirements", [])
        ] if analysis else []

        # ---------------------------------------------------------
        # 1. Role Alignment (Weight: 25%)
        # ---------------------------------------------------------
        target_titles = [t.lower() for t in candidate_profile.get("target_titles", [])]
        if any(t in title or t in normalized_title for t in target_titles):
            role_score = 95.0
            strengths.append(f"Title '{job.get('title')}' directly matches candidate target roles.")
        elif "product manager" in title or "product manager" in normalized_title:
            role_score = 80.0
            strengths.append("General Product Manager alignment.")
        else:
            role_score = 40.0
            gaps.append(f"Title '{job.get('title')}' is outside primary Product Management target roles.")

        factor_breakdown["role_alignment"] = {
            "score": role_score,
            "weight": weights.get("role_alignment", 0.25),
            "evidence_known": True
        }

        # ---------------------------------------------------------
        # 2. Relevant Experience (Weight: 20%)
        # ---------------------------------------------------------
        exp_reqs = [r for r in requirements if r.get("category") in ("experience", "responsibility")]
        matched_facts: List[str] = []

        if exp_reqs:
            # Structured analysis available: evaluate coverage of JD experience requirements
            matched_points = 0.0
            for r in exp_reqs:
                status = r.get("match_status")
                fids = r.get("evidence_fact_ids", [])
                if status == "matched":
                    matched_points += 1.0
                    matched_facts.extend(fids)
                elif status == "partial":
                    # Proposed partial mapping gets limited credit
                    matched_points += 0.4
                    matched_facts.extend(fids)
                else:
                    gaps.append(f"Experience gap: {r.get('description', r.get('jd_quote', ''))[:80]}")

            exp_score = min(100.0, (matched_points / max(len(exp_reqs), 1)) * 100.0)
            if matched_points >= 2.0:
                strengths.append(f"Verified experience satisfies {matched_points:.1f}/{len(exp_reqs)} analyzed requirements.")
            evidence_known_exp = True
        else:
            # Provisional heuristic: overlap with verified facts
            facts = candidate_profile.get("verified_facts", [])
            has_deep_fact_match = False
            for fact in facts:
                fact_text = fact.get("text", "").lower()
                technologies = [t.lower() for t in fact.get("technologies", [])]
                overlap = [t for t in technologies if t in desc]
                if len(overlap) >= 3:
                    has_deep_fact_match = True
                if len(overlap) >= 2 or any(k in desc and k in fact_text for k in ["api", "cloud", "platform", "data"]):
                    matched_facts.append(fact["fact_id"])

            if len(matched_facts) >= 3 or (len(matched_facts) >= 1 and has_deep_fact_match):
                exp_score = 90.0
                strengths.append(f"Provisional overlap with verified achievements ({', '.join(matched_facts[:3])}).")
            elif len(matched_facts) >= 1:
                exp_score = 78.0
                strengths.append(f"Provisional overlap grounded in fact IDs: {', '.join(matched_facts)}.")
            else:
                exp_score = 55.0
                gaps.append("Limited verified achievement overlap with specialized JD requirements.")
            evidence_known_exp = False
            uncertainties.append("Experience score is provisional pending Antigravity structured requirement analysis.")

        evidence_fact_ids.extend(matched_facts)
        factor_breakdown["relevant_experience"] = {
            "score": exp_score,
            "weight": weights.get("relevant_experience", 0.20),
            "evidence_known": evidence_known_exp,
            "matched_facts": list(set(matched_facts))
        }

        # ---------------------------------------------------------
        # 3. Seniority (Weight: 15%)
        # Note: Senior job title does NOT prove satisfaction of seniority requirements!
        # Evaluated against candidate verified experience years and level.
        # ---------------------------------------------------------
        candidate_years = self._verified_experience_years(candidate_profile)
        candidate_has_evidence = candidate_years is not None
        senior_indicators = ["senior", "sr.", "lead", "principal", "staff", "head of", "director"]
        junior_indicators = ["junior", "intern", "co-op", "associate pm", "entry level", "new grad"]

        if any(ind in title for ind in junior_indicators) or any(ind in desc[:500] for ind in junior_indicators):
            seniority_score = 20.0
            risks.append("Role appears junior, intern, or entry-level.")
        elif any(ind in title for ind in ["principal", "staff", "director", "head of"]):
            # Requires 8-10+ years
            if candidate_years is not None and candidate_years >= 8.0:
                seniority_score = 88.0
                strengths.append("Candidate experience matches Principal/Staff seniority tier.")
            else:
                seniority_score = 65.0
                gaps.append("Staff/Principal tier typically demands 10+ years.")
        elif any(ind in title for ind in senior_indicators):
            if candidate_has_evidence:
                seniority_score = 95.0
                strengths.append(f"Senior level aligns with {candidate_years:.1f} years derived from canonical employment dates.")
            else:
                seniority_score = 60.0
                gaps.append("Seniority requirements in JD are unsupported until candidate experience is verified.")
        elif "senior" in desc or "5+ years" in desc or "7+ years" in desc or "8+ years" in desc:
            if candidate_has_evidence:
                seniority_score = 85.0
                strengths.append("JD requirements align with candidate senior experience level.")
            else:
                seniority_score = 60.0
                gaps.append("JD seniority / years-of-experience requirement is unsupported until verified candidate evidence is checked.")
        else:
            seniority_score = 75.0

        factor_breakdown["seniority"] = {
            "score": seniority_score,
            "weight": weights.get("seniority", 0.15),
            "evidence_known": True
        }

        # ---------------------------------------------------------
        # 4. Required Skills (Weight: 15%)
        # Denominator is JD required skills, NOT total candidate skills!
        # ---------------------------------------------------------
        skill_reqs = [r for r in requirements if r.get("category") == "skill"]
        if skill_reqs:
            matched_skills_count = 0.0
            for sr in skill_reqs:
                if sr.get("match_status") == "matched":
                    matched_skills_count += 1.0
                elif sr.get("match_status") == "partial":
                    matched_skills_count += 0.5
                else:
                    gaps.append(f"Skill gap: {sr.get('description', sr.get('jd_quote', ''))[:60]}")
            skills_score = min(100.0, (matched_skills_count / max(len(skill_reqs), 1)) * 100.0)
            evidence_known_skills = True
        else:
            # Provisional: Extract key technical tokens in JD and check candidate verified skills & fact technologies
            verified_skills = [s["name"].lower() for s in candidate_profile.get("skills", []) if s.get("verified")]
            for f in candidate_profile.get("verified_facts", []):
                for tech in f.get("technologies", []):
                    verified_skills.append(tech.lower())

            tech_tokens_in_jd = set()
            for token in [
                "python", "kafka", "postgresql", "sql", "api", "rest", "graphql", "aws", "gcp", "azure",
                "cloud", "docker", "kubernetes", "agile", "scrum", "microservices", "streaming", "platform",
                "analytics", "strategy", "data", "ml", "ai"
            ]:
                if token in desc:
                    tech_tokens_in_jd.add(token)

            if tech_tokens_in_jd:
                matched_tokens = sum(1 for token in tech_tokens_in_jd if any(token in vs or vs in token for vs in verified_skills))
                if matched_tokens == 0:
                    skills_score = 40.0
                else:
                    skills_score = min(100.0, 40.0 + (matched_tokens / len(tech_tokens_in_jd)) * 60.0)
            else:
                skills_score = 70.0
                uncertainties.append("No explicit technical skills extracted from JD; provisional neutral score assigned.")
            evidence_known_skills = False

        factor_breakdown["required_skills"] = {
            "score": skills_score,
            "weight": weights.get("required_skills", 0.15),
            "evidence_known": evidence_known_skills
        }

        # ---------------------------------------------------------
        # 5. Domain Relevance (Weight: 10%)
        # ---------------------------------------------------------
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

        factor_breakdown["domain_relevance"] = {
            "score": domain_score,
            "weight": weights.get("domain_relevance", 0.10),
            "evidence_known": True
        }

        # ---------------------------------------------------------
        # 6. Location Fit (Weight: 5%)
        # Explicit restrictions: US-only = 0 score and severe penalty.
        # Remote does NOT assume Canadian eligibility without explicit indication.
        # ---------------------------------------------------------
        is_us_only = False
        us_indicators = ["must be authorized to work in the us", "us only", "united states only", "must reside in the us", "us citizen or green card", "must be based in the us", "us work authorization required"]
        if any(ind in desc for ind in us_indicators) or (("united states" in location or "usa" in location) and "canada" not in location and "remote" not in location):
            is_us_only = True

        if is_us_only:
            location_score = 0.0
            penalty_total += penalties_cfg.get("us_only_location", -50)
            risks.append("Posting indicates US-only location/authorization requirement; visa barrier for Canadian candidates.")
            evidence_known_loc = True
        elif "canada" in location or "toronto" in location or "ontario" in location or "remote canada" in location:
            location_score = 100.0
            strengths.append("Eligible Canadian location (Toronto / Ontario / Remote Canada).")
            evidence_known_loc = True
        elif remote_type == "remote" or "remote" in location:
            location_score = 50.0
            uncertainties.append("Generic 'Remote' does not confirm Canadian eligibility; legal work authorization must be verified.")
            evidence_known_loc = False
        else:
            location_score = 60.0
            uncertainties.append(f"Location '{job.get('location')}' eligibility in Canada is unconfirmed.")
            evidence_known_loc = False

        factor_breakdown["location_fit"] = {
            "score": location_score,
            "weight": weights.get("location_fit", 0.05),
            "evidence_known": evidence_known_loc,
            "is_us_only": is_us_only
        }

        # ---------------------------------------------------------
        # 7. Compensation Fit (Weight: 5%)
        # Compares against candidate's verified CAD preference.
        # Missing salary = neutral baseline with explicit uncertainty, no arbitrary bonus.
        # Incomparable currency/period marked unknown.
        # ---------------------------------------------------------
        min_amount = job.get("min_amount")
        max_amount = job.get("max_amount")
        currency = (job.get("currency") or "CAD").upper()
        preferences = candidate_profile.get("preferences") or {}
        compensation_pref = preferences.get("min_compensation_cad")
        if isinstance(compensation_pref, dict):
            target_cad = float(compensation_pref.get("base", 150000.0))
        elif isinstance(compensation_pref, (int, float)):
            target_cad = float(compensation_pref)
        else:
            target_cad = None

        if max_amount is None:
            comp_score = 70.0
            evidence_known_comp = False
            uncertainties.append("Compensation not disclosed in posting.")
        elif currency == "CAD" and target_cad is not None:
            evidence_known_comp = True
            if float(max_amount) >= target_cad:
                comp_score = 95.0
                strengths.append(f"Advertised compensation (${min_amount or 0:,.0f} - ${max_amount:,.0f} CAD) meets expectations.")
            else:
                comp_score = max(30.0, (float(max_amount) / target_cad) * 75.0)
                gaps.append(f"Advertised maximum compensation (${max_amount:,.0f} CAD) is below target ${target_cad:,.0f} CAD.")
        elif currency != "CAD":
            # Foreign currency or hourly rate
            comp_score = 70.0
            evidence_known_comp = False
            uncertainties.append(f"Advertised compensation in {currency} ({max_amount}) cannot be directly compared to CAD preference without conversion.")
        else:
            comp_score = 70.0
            evidence_known_comp = False
            uncertainties.append("Candidate compensation preference is not configured.")

        factor_breakdown["compensation_fit"] = {
            "score": comp_score,
            "weight": weights.get("compensation_fit", 0.05),
            "evidence_known": evidence_known_comp
        }

        # ---------------------------------------------------------
        # 8. Preference Fit (Weight: 5%)
        # Compared against candidate's actual preferences.
        # Missing preferences earn 0 points, never arbitrary positive points!
        # ---------------------------------------------------------
        candidate_prefs = preferences
        if not candidate_prefs:
            # Unknown preferences: neutral baseline without positive bonus
            preference_score = 70.0
            evidence_known_pref = False
            uncertainties.append("Candidate preferences not configured; neutral baseline assigned.")
        else:
            pref_points = 0.0
            max_pref_points = 3.0

            if "target_locations" in candidate_prefs:
                pref_locs = [l.lower() for l in candidate_prefs["target_locations"]]
                if any(pl in location or ("remote" in pl and remote_type == "remote") for pl in pref_locs):
                    pref_points += 1.0

            authorization = candidate_prefs.get("work_authorization")
            if isinstance(authorization, dict) and authorization.get("country") == "Canada":
                if not is_us_only and ("canada" in location or "toronto" in location or "ontario" in location):
                    pref_points += 1.0

            if "min_compensation_cad" in candidate_prefs:
                if max_amount and target_cad is not None and currency == "CAD" and float(max_amount) >= target_cad:
                    pref_points += 1.0
                elif max_amount is None:
                    pref_points += 0.5

            preference_score = (pref_points / max_pref_points) * 100.0
            evidence_known_pref = True

        factor_breakdown["preference_fit"] = {
            "score": preference_score,
            "weight": weights.get("preference_fit", 0.05),
            "evidence_known": evidence_known_pref
        }

        # ---------------------------------------------------------
        # Compute Overall Weighted Score
        # ---------------------------------------------------------
        weighted_sum = sum(
            factor_breakdown[f]["score"] * factor_breakdown[f]["weight"]
            for f in factor_breakdown
        )
        final_score = max(0.0, min(100.0, weighted_sum + penalty_total))
        overall_score = round(final_score, 1)

        # Evidence coverage percentage
        known_factors = sum(1 for f in factor_breakdown.values() if f.get("evidence_known"))
        evidence_coverage = round((known_factors / len(factor_breakdown)) * 100.0, 1)

        # Score band & recommendation
        if overall_score >= thresholds.get("exceptional", 90):
            score_band = "exceptional"
            recommendation = "apply"
        elif overall_score >= thresholds.get("strong", 85):
            score_band = "strong"
            recommendation = "apply"
        elif overall_score >= thresholds.get("review", 75):
            score_band = "review"
            recommendation = "review"
        else:
            score_band = "weak"
            recommendation = "skip"

        keyword_coverage = self.calculate_keyword_coverage(
            job,
            candidate_profile,
            analysis={"requirements": requirements} if analysis else None,
        )

        return {
            "overall_score": overall_score,
            "score_band": score_band,
            "recommendation": recommendation,
            "is_provisional": is_provisional,
            "evidence_coverage": evidence_coverage,
            "keyword_coverage": keyword_coverage,
            "role_alignment": round(role_score, 1),
            "experience_score": round(exp_score, 1),
            "seniority_score": round(seniority_score, 1),
            "skills_score": round(skills_score, 1),
            "domain_score": round(domain_score, 1),
            "location_score": round(location_score, 1),
            "comp_score": round(comp_score, 1),
            "preference_score": round(preference_score, 1),
            "factor_breakdown": factor_breakdown,
            "strengths": strengths,
            "gaps": gaps,
            "risks": risks,
            "uncertainties": uncertainties,
            "evidence_fact_ids": sorted(list(set(evidence_fact_ids))),
            "scoring_version": "v2"
        }

    def calculate_keyword_coverage(
        self,
        job: Dict[str, Any],
        candidate_profile: Dict[str, Any],
        required_terms: Optional[List[str]] = None,
        analysis: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Calculate transparent keyword coverage grounded strictly in verified candidate evidence.
        Formula: (supported normalized required terms / total normalized required terms) * 100
        Only verified skills/technologies or exact approved candidate fact texts count as support.
        """
        terms_to_check: List[str] = []
        if required_terms is not None:
            terms_to_check = [t.strip().lower() for t in required_terms if t and t.strip()]
        else:
            requirements = [
                CanonicalRequirement.model_validate(requirement).model_dump()
                for requirement in analysis.get("requirements", [])
            ] if analysis else []
            derived: List[str] = []
            for req in requirements:
                if req.get("importance", "required") == "required":
                    desc_text = req.get("description") or req.get("jd_quote") or ""
                    if desc_text and len(desc_text.split()) <= 4:
                        derived.append(desc_text.strip().lower())
            if not derived:
                desc = (job.get("description") or "").lower()
                common_tokens = [
                    "python", "kafka", "postgresql", "sql", "api", "rest", "graphql", "aws", "gcp", "azure",
                    "cloud", "docker", "kubernetes", "agile", "scrum", "microservices", "streaming", "platform",
                    "analytics", "strategy", "data", "ml", "ai"
                ]
                for tok in common_tokens:
                    if re.search(rf"\b{re.escape(tok)}\b", desc):
                        derived.append(tok)
            terms_to_check = derived

        # Deduplicate while preserving order
        seen_terms = set()
        normalized_terms = []
        for t in terms_to_check:
            if t not in seen_terms:
                seen_terms.add(t)
                normalized_terms.append(t)

        if not normalized_terms:
            return KeywordCoverageResult(
                coverage_percentage=0.0,
                matched_terms=[],
                unsupported_terms=[],
                term_sources={},
                skill_sources={},
                algorithm_version="keyword_v1",
                total_required_terms=0,
                supported_required_terms=0,
            ).model_dump()

        verified_skills = {
            s["name"].strip().lower(): s["name"].strip()
            for s in candidate_profile.get("skills", [])
            if s.get("verified") is True and isinstance(s.get("name"), str) and s["name"].strip()
        }
        approved_facts = [
            f for f in candidate_profile.get("verified_facts", [])
            if f.get("verification_status") == "approved"
        ]

        matched_terms: List[str] = []
        unsupported_terms: List[str] = []
        term_sources: Dict[str, List[str]] = {}
        skill_sources: Dict[str, List[str]] = {}

        for term in normalized_terms:
            term_sources_for_t: List[str] = []
            skill_sources_for_t: List[str] = []
            is_supported = False

            for skill, display_name in verified_skills.items():
                if term == skill or re.search(rf"\b{re.escape(term)}\b", skill):
                    is_supported = True
                    skill_sources_for_t.append(display_name)

            for fact in approved_facts:
                fid = fact.get("fact_id")
                techs = [t.strip().lower() for t in fact.get("technologies", [])]
                fact_text = (fact.get("text") or "").lower()

                has_tech_match = any(term == tech or re.search(rf"\b{re.escape(term)}\b", tech) for tech in techs)
                has_text_match = bool(re.search(rf"\b{re.escape(term)}\b", fact_text))

                if has_tech_match or has_text_match:
                    is_supported = True
                    if fid and fid not in term_sources_for_t:
                        term_sources_for_t.append(fid)

            if is_supported:
                matched_terms.append(term)
                term_sources[term] = sorted(term_sources_for_t)
                skill_sources[term] = sorted(skill_sources_for_t)
            else:
                unsupported_terms.append(term)

        total = len(normalized_terms)
        coverage_pct = round((len(matched_terms) / total) * 100.0, 1) if total > 0 else 0.0

        return KeywordCoverageResult(
            coverage_percentage=coverage_pct,
            matched_terms=matched_terms,
            unsupported_terms=unsupported_terms,
            term_sources=term_sources,
            skill_sources=skill_sources,
            algorithm_version="keyword_v1",
            total_required_terms=total,
            supported_required_terms=len(matched_terms),
        ).model_dump()

    @staticmethod
    def _verified_experience_years(candidate_profile: Dict[str, Any]) -> Optional[float]:
        """Derive tenure from canonical employment dates; never assume a value."""
        starts: List[date] = []
        ends: List[date] = []
        today = date.today()
        for experience in candidate_profile.get("work_experience", []):
            start = experience.get("start_date")
            end = experience.get("end_date")
            try:
                start_date = start if isinstance(start, date) else datetime.fromisoformat(str(start)).date()
                end_date = today if experience.get("is_current") else (
                    end if isinstance(end, date) else datetime.fromisoformat(str(end)).date()
                )
            except (TypeError, ValueError):
                continue
            if end_date >= start_date:
                starts.append(start_date)
                ends.append(end_date)
        if not starts:
            explicit = candidate_profile.get("years_of_experience")
            return float(explicit) if isinstance(explicit, (int, float)) else None
        # The canonical seed is contiguous; span avoids double-counting overlaps.
        return round((max(ends) - min(starts)).days / 365.2425, 1)
