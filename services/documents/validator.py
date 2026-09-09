import re
from typing import Dict, Any, List, Optional, Tuple

class ProvenanceValidationError(Exception):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

class ClaimValidator:
    def __init__(self, candidate_profile: Dict[str, Any]):
        self.candidate_profile = candidate_profile
        self.verified_facts_by_id = {
            f["fact_id"]: f for f in candidate_profile.get("verified_facts", [])
            if f.get("verification_status") == "approved"
        }
        self.work_exp_by_id = {
            str(exp["id"]): exp for exp in candidate_profile.get("work_experience", [])
        }
        self.verified_skills = {
            s["name"].strip().lower() for s in candidate_profile.get("skills", [])
            if s.get("verified", True)
        }
        self.all_verified_fact_techs = {
            str(t).strip().lower()
            for f in self.verified_facts_by_id.values()
            for t in f.get("technologies", [])
        }
        skill_tokens = set()
        for s in self.verified_skills:
            for tok in re.findall(r'[A-Za-z0-9#+.]+', s):
                if len(tok) >= 2:
                    skill_tokens.add(tok.lower())
        self.all_allowed_techs = self.all_verified_fact_techs.union(self.verified_skills).union(skill_tokens)
        self.verified_education = candidate_profile.get("education", [])
        self.verified_credentials = candidate_profile.get("credentials", [])

    def validate_requirement_analysis(self, requirements: List[Dict[str, Any]]) -> Tuple[bool, List[str]]:
        """
        Validates that extracted JD requirements obey integrity rules:
        - If matched_fact_ids is empty, status cannot be 'matched' or 'partial'.
        - All fact_ids in matched_fact_ids must exist and be approved.
        """
        errors = []
        for req in requirements:
            req_id = req.get("requirement_id", "unknown")
            status = req.get("status", "unsupported").lower()
            fact_ids = req.get("matched_fact_ids", [])

            if status in ["matched", "partial"] and not fact_ids:
                errors.append(f"Requirement '{req_id}' is marked '{status}' but has no matched_fact_ids. Must be 'unsupported' or 'gap'.")

            for fid in fact_ids:
                if fid not in self.verified_facts_by_id:
                    errors.append(f"Requirement '{req_id}' references unknown or unapproved fact_id '{fid}'.")

        return len(errors) == 0, errors

    def validate_claim(self, claim: Dict[str, Any]) -> Tuple[bool, List[str]]:
        """
        Validates an individual structured claim against verified candidate facts.
        """
        errors = []
        claim_id = claim.get("claim_id", "unnamed_claim")
        section = claim.get("section", "experience")
        fact_ids = claim.get("fact_ids", [])
        text = claim.get("text", "").strip()

        if section == "experience":
            if not fact_ids:
                errors.append(f"Claim '{claim_id}': Experience bullet must cite at least one verified fact_id.")
                return False, errors

            # 1. Fact Existence
            facts = []
            for fid in fact_ids:
                if fid not in self.verified_facts_by_id:
                    errors.append(f"Claim '{claim_id}': fact_id '{fid}' does not exist or is not approved.")
                else:
                    facts.append(self.verified_facts_by_id[fid])

            if errors:
                return False, errors

            primary_fact = facts[0]

            # 2. Company & Role Attribution
            exp_id = str(primary_fact.get("work_experience_id") or "")
            parent_exp = self.work_exp_by_id.get(exp_id)
            if parent_exp:
                claimed_company = (claim.get("company") or "").strip().lower()
                verified_company = parent_exp["company"].strip().lower()
                if claimed_company and claimed_company != verified_company:
                    errors.append(
                        f"Claim '{claim_id}': Misattributed employer. Claim lists '{claim.get('company')}', "
                        f"but fact '{primary_fact['fact_id']}' belongs to '{parent_exp['company']}'."
                    )

            # 3. Metric Containment
            # Any metric in claimed_metrics must strictly exist in the fact's verified metrics
            claimed_metrics = claim.get("claimed_metrics", [])
            verified_metrics = primary_fact.get("metrics", [])
            # Combine metrics from all cited facts if multiple
            all_verified_metrics = []
            for f in facts:
                for m in f.get("metrics", []):
                    all_verified_metrics.append(str(m).lower())

            for cm in claimed_metrics:
                cm_clean = str(cm).strip().lower()
                # Check if cm_clean is represented in verified metrics
                if not any(cm_clean in vm or vm in cm_clean for vm in all_verified_metrics):
                    errors.append(
                        f"Claim '{claim_id}': Metric tampering detected. Claimed metric '{cm}' "
                        f"is not verified in fact '{primary_fact['fact_id']}' metrics {primary_fact.get('metrics')}."
                    )

            # Also verify numerical figures inside claim text match verified numbers
            # Check numbers with % or $ or M or K
            text_numbers = re.findall(r'(\d+%\s*|\$\d+(?:\.\d+)?(?:M|K|B)?|\b\d+M\b|\b\d+K\b|\b\d+TB\b)', text)
            for tn in text_numbers:
                tn_clean = tn.strip().lower()
                matched_in_metrics = any(tn_clean in vm for vm in all_verified_metrics)
                matched_in_fact_text = any(tn_clean in f.get("text", "").lower() for f in facts)
                if not (matched_in_metrics or matched_in_fact_text):
                    errors.append(
                        f"Claim '{claim_id}': Numerical figure '{tn}' in bullet text is not present "
                        f"in verified fact evidence: {all_verified_metrics}."
                    )

            # 4. Technology Containment
            claimed_techs = claim.get("claimed_technologies", [])
            all_verified_techs = set()
            for f in facts:
                for t in f.get("technologies", []):
                    all_verified_techs.add(str(t).strip().lower())
            # Add global verified skills as allowable general technologies
            all_allowed_techs = all_verified_techs.union(self.verified_skills)

            for ct in claimed_techs:
                ct_clean = str(ct).strip().lower()
                if ct_clean not in all_allowed_techs:
                    errors.append(
                        f"Claim '{claim_id}': Unverified technology '{ct}'. "
                        f"Technology is not present in fact evidence or verified skills."
                    )

            # 5. Verbatim Strategy Check (Option A)
            strategy = claim.get("generation_strategy", "verbatim")
            if strategy == "verbatim":
                # Must match primary fact text closely (allowing minor whitespace/capitalization)
                fact_clean = re.sub(r'\s+', ' ', primary_fact.get("text", "")).strip().lower()
                text_clean = re.sub(r'\s+', ' ', text).strip().lower()
                if fact_clean != text_clean:
                    errors.append(
                        f"Claim '{claim_id}': Text differs from approved fact text under verbatim strategy.\n"
                        f"Expected: '{primary_fact.get('text')}'\nReceived: '{text}'"
                    )

        elif section == "summary":
            # Executive Summary claims: check that any highlighted technologies or metrics are verified
            claimed_techs = claim.get("claimed_technologies", [])
            for ct in claimed_techs:
                if str(ct).strip().lower() not in self.all_allowed_techs:
                    errors.append(f"Summary claim '{claim_id}': Highlights unverified skill/tech '{ct}'.")

        elif section == "education":
            # Verify institution and degree match verified education
            claimed_degree = claim.get("degree", "").strip().lower()
            claimed_inst = claim.get("institution", "").strip().lower()
            if not any(
                claimed_degree in e["degree"].lower() and claimed_inst in e["institution"].lower()
                for e in self.verified_education
            ):
                errors.append(f"Education claim '{claim_id}': '{claim.get('degree')}' at '{claim.get('institution')}' is not in verified education.")

        return len(errors) == 0, errors

    def validate_draft(self, structured_resume: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
        """
        Validates all sections and claims in a structured resume draft.
        Returns (is_valid, validation_report).
        """
        all_errors = []
        claims = structured_resume.get("claims", [])
        validated_claim_count = 0

        for claim in claims:
            ok, errs = self.validate_claim(claim)
            if not ok:
                all_errors.extend(errs)
            else:
                validated_claim_count += 1

        report = {
            "is_valid": len(all_errors) == 0,
            "total_claims": len(claims),
            "validated_claims": validated_claim_count,
            "errors": all_errors,
            "verified_facts_referenced": list({
                fid for c in claims for fid in c.get("fact_ids", [])
            })
        }
        return report["is_valid"], report
