import difflib
import html
import json
import hashlib
from typing import Dict, Any, List, Optional, Tuple

class ResumeTailor:
    def __init__(self, candidate_profile: Dict[str, Any]) -> None:
        self.profile = candidate_profile
        self.verified_facts = {
            f["fact_id"]: f for f in candidate_profile.get("verified_facts", [])
            if f.get("verification_status") == "approved"
        }
        self.work_experiences = candidate_profile.get("work_experience", [])
        self.skills = candidate_profile.get("skills", [])
        self.education = candidate_profile.get("education", [])

    def create_tailoring_context(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Builds the safe prompt context for Antigravity, quarantining the untrusted JD text
        and providing the complete verified facts inventory.
        """
        raw_desc = job.get("description") or ""
        # Sanitize JD text to prevent injection characters
        cleaned_desc = raw_desc.replace("\x00", "").strip()

        facts_inventory = []
        for fid, f in self.verified_facts.items():
            facts_inventory.append({
                "fact_id": fid,
                "work_experience_id": str(f.get("work_experience_id") or ""),
                "category": f.get("category"),
                "text": f.get("text"),
                "technologies": f.get("technologies", []),
                "metrics": f.get("metrics", [])
            })

        return {
            "candidate_id": str(self.profile.get("id", "cand_default")),
            "candidate_name": self.profile.get("full_name", "Candidate"),
            "target_titles": self.profile.get("target_titles", []),
            "verified_facts_inventory": facts_inventory,
            "verified_skills": [s["name"] for s in self.skills if s.get("verified") is True],
            "work_experiences": [
                {
                    "id": str(exp["id"]),
                    "company": exp["company"],
                    "role": exp["role"],
                    "location": exp.get("location"),
                    "start_date": str(exp["start_date"]),
                    "end_date": str(exp["end_date"]) if exp.get("end_date") else ("Present" if exp.get("is_current") else "")
                }
                for exp in self.work_experiences
            ],
            "education": [
                {
                    "degree": edu["degree"],
                    "field_of_study": edu["field_of_study"],
                    "institution": edu["institution"]
                }
                for edu in self.education
            ],
            "job_id": str(job["job_id"]),
            "job_title": job.get("title"),
            "company": job.get("company"),
            "untrusted_job_description": f"<untrusted_job_description>\n{html.escape(cleaned_desc)}\n</untrusted_job_description>"
        }

    def generate_tailored_draft(
        self,
        job: Dict[str, Any],
        matched_fact_ids: Optional[List[str]] = None,
        evidence_fact_ids: Optional[List[str]] = None,
        requirements: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Synthesizes a structured tailored resume following Option A (Verbatim Selection).
        Every bullet is anchored to an approved fact_id with verbatim text and verified metrics.

        When validated ``requirements`` are supplied, fact ordering uses the
        deterministic coverage-first ranker (no heuristic weights). Otherwise
        the legacy relevance heuristic applies.
        """
        desc = (job.get("description") or "").lower()
        title = (job.get("title") or "").lower()

        if requirements is not None:
            from services.documents.keywords import CoverageFirstFactRanker
            from services.documents.template_registry import load_resume_config
            resume_config = load_resume_config()
            ranker = CoverageFirstFactRanker(
                max_per_role=int(resume_config.get("max_experience_bullets", 5)),
                max_prior_role=int(resume_config.get("max_prior_role_bullets", 3)),
                max_total=int(resume_config.get("max_total_bullets", 14)),
            )
            top_fact_ids = ranker.rank(requirements, self.profile)
        else:
            priority_fact_ids = set(evidence_fact_ids if evidence_fact_ids is not None else (matched_fact_ids or []))

            # Score relevance of each verified fact against the JD
            fact_scores: List[Tuple[str, float]] = []
            for fid, fact in self.verified_facts.items():
                score = 0.0
                fact_text = fact.get("text", "").lower()
                techs = [t.lower() for t in fact.get("technologies", [])]

                # Direct tech match
                for t in techs:
                    if t in desc:
                        score += 2.0
                # Keyword match
                tokens = ["platform", "api", "cloud", "scale", "latency", "revenue", "enterprise", "cross-functional"]
                for tok in tokens:
                    if tok in desc and tok in fact_text:
                        score += 1.0

                if fid in priority_fact_ids:
                    score += 5.0

                fact_scores.append((fid, score))

            # Sort facts by relevance
            fact_scores.sort(key=lambda x: x[1], reverse=True)
            top_fact_ids = [fid for fid, _ in fact_scores]

        # Assemble structured claims grouped by work experience
        claims: List[Dict[str, Any]] = []
        claim_counter = 1

        # Summaries are optional. Do not manufacture a career narrative or tenure.
        if top_fact_ids:
            fact = self.verified_facts[top_fact_ids[0]]
            claims.append({
                "claim_id": f"claim_{claim_counter:03d}", "section": "summary",
                "text": fact["text"], "fact_ids": [fact["fact_id"]],
                "generation_strategy": "verbatim"
            })
            claim_counter += 1

        # Experience claims (verbatim from approved facts)
        for exp in self.work_experiences:
            exp_id = str(exp["id"])
            # Find facts belonging to this experience
            exp_facts = [
                self.verified_facts[fid] for fid in top_fact_ids
                if str(self.verified_facts[fid].get("work_experience_id")) == exp_id
            ]

            for fact in exp_facts:
                claims.append({
                    "claim_id": f"claim_{claim_counter:03d}",
                    "section": "experience",
                    "entity_id": exp_id,
                    "company": exp["company"],
                    "role": exp["role"],
                    "dates": {
                        "start": str(exp["start_date"]),
                        "end": str(exp["end_date"]) if exp.get("end_date") else ("Present" if exp.get("is_current") else "")
                    },
                    "text": fact["text"],
                    "fact_ids": [fact["fact_id"]],
                    "claimed_technologies": fact.get("technologies", []),
                    "claimed_metrics": fact.get("metrics", []),
                    "generation_strategy": "verbatim"
                })
                claim_counter += 1

        # Education claims
        for edu in self.education:
            claims.append({
                "claim_id": f"claim_{claim_counter:03d}",
                "section": "education",
                "degree": edu["degree"],
                "institution": edu["institution"],
                "field_of_study": edu.get("field_of_study"),
                "text": f"{edu['degree']} in {edu['field_of_study']}, {edu['institution']}",
                "fact_ids": [],
                "claimed_technologies": [],
                "claimed_metrics": [],
                "generation_strategy": "verbatim"
            })
            claim_counter += 1

        structured_resume = {
            "job_id": str(job["job_id"]),
            "target_role": job.get("title"),
            "target_company": job.get("company"),
            "claims": claims
        }

        return structured_resume

    def compute_diff(self, baseline_resume_text: str, tailored_resume_text: str) -> str:
        """
        Produces a unified line-by-line diff between the baseline and tailored resume text.
        """
        base_lines = baseline_resume_text.splitlines(keepends=True)
        tailored_lines = tailored_resume_text.splitlines(keepends=True)
        diff = difflib.unified_diff(
            base_lines,
            tailored_lines,
            fromfile="Baseline_Canonical_Resume.txt",
            tofile="Tailored_Resume.txt",
            n=3
        )
        return "".join(diff)

    def generate_plain_text(self, structured_resume: Dict[str, Any]) -> str:
        """
        Plain-text projection of the canonical view model. HTML rendering
        consumes the same model, so the two projections cannot drift.
        """
        from services.documents.view_model import build_view_model, render_plain_text
        view_model = build_view_model(self.profile, structured_resume)
        return render_plain_text(view_model)

    def compute_content_hash(self, text_content: str) -> str:
        return hashlib.sha256(text_content.strip().encode("utf-8")).hexdigest()
