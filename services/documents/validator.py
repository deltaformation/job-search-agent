"""Fail-closed validation for the supported verbatim document format."""
from typing import Any, Dict, List, Optional, Tuple


class ProvenanceValidationError(ValueError):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class ClaimValidator:
    def __init__(self, candidate_profile: Dict[str, Any]) -> None:
        self.profile = candidate_profile
        self.verified_facts_by_id = {
            f["fact_id"]: f for f in candidate_profile.get("verified_facts", [])
            if f.get("verification_status") == "approved"
        }
        self.work_exp_by_id = {str(e["id"]): e for e in candidate_profile.get("work_experience", [])}

    def validate_requirement_analysis(
        self, requirements: List[Dict[str, Any]], jd_text: Optional[str] = None
    ) -> Tuple[bool, List[str]]:
        errors: List[str] = []
        seen = set()
        if not isinstance(requirements, list):
            return False, ["Requirements must be a list."]
        for req in requirements:
            if not isinstance(req, dict):
                errors.append("Requirement must be an object.")
                continue
            rid = req.get("requirement_id")
            if not isinstance(rid, str) or not rid or rid in seen:
                errors.append("Requirement IDs must be nonempty and unique.")
            else:
                seen.add(rid)
            status = req.get("status")
            if status not in ("matched", "partial", "unsupported", "gap"):
                errors.append(f"Requirement '{rid}' has an invalid status.")
            quote = req.get("jd_quote")
            if not isinstance(quote, str) or not quote.strip() or (jd_text is not None and quote not in jd_text):
                errors.append(f"Requirement '{rid}' must quote exact JD text.")
            ids = req.get("matched_fact_ids", [])
            if not isinstance(ids, list) or any(not isinstance(fid, str) for fid in ids):
                errors.append(f"Requirement '{rid}' requires a list of fact IDs.")
                continue
            if status in ("matched", "partial") and not ids:
                errors.append(f"Requirement '{rid}' has no matched_fact_ids.")
            for fid in ids:
                if fid not in self.verified_facts_by_id:
                    errors.append(f"Requirement '{rid}' references unknown or unapproved fact_id '{fid}'.")
            # Semantic correspondence is a proposal, not a deterministic fact check.
            # Exact fact quotations are the only automatically certified matches in V1.
            if status == "matched" and ids and not any(
                quote == self.verified_facts_by_id.get(fid, {}).get("text") for fid in ids
            ):
                errors.append(f"Requirement '{rid}': semantic matches must be 'partial' pending human review.")
        return not errors, errors

    def validate_claim(self, claim: Dict[str, Any]) -> Tuple[bool, List[str]]:
        if not isinstance(claim, dict):
            return False, ["Claim must be an object."]
        errors: List[str] = []
        section = claim.get("section")
        ids = claim.get("fact_ids", [])
        if not isinstance(ids, list) or any(not isinstance(fid, str) for fid in ids):
            return False, ["fact_ids must be a list of strings."]
        text = claim.get("text")
        if not isinstance(text, str) or not text.strip():
            errors.append("Claim text must be nonempty.")
        if claim.get("generation_strategy", "verbatim") != "verbatim":
            errors.append("Only the verbatim generation strategy is supported.")
        if section in ("experience", "summary"):
            ids = claim.get("fact_ids", [])
            if not isinstance(ids, list) or len(ids) != 1 or not isinstance(ids[0], str):
                return False, errors + ["Each verbatim claim must cite exactly one approved fact_id."]
            fact = self.verified_facts_by_id.get(ids[0])
            if not fact:
                return False, errors + [f"Unknown or unapproved fact_id '{ids[0]}'."]
            if text != fact.get("text"):
                errors.append("Text differs from approved fact text under verbatim strategy.")
            for key, label in (("claimed_metrics", "Metric tampering"), ("claimed_technologies", "Unverified technology")):
                values = claim.get(key, [])
                evidence_key = "metrics" if key == "claimed_metrics" else "technologies"
                if not isinstance(values, list):
                    errors.append(f"{key} must be a list.")
                else:
                    for value in values:
                        if value not in fact.get(evidence_key, []):
                            errors.append(f"{label} '{value}' is not present in the cited fact.")
            if section == "experience":
                exp = self.work_exp_by_id.get(str(fact.get("work_experience_id")))
                if not exp:
                    errors.append("Experience fact has no candidate-owned employment record.")
                else:
                    if claim.get("company") != exp["company"]:
                        errors.append("Misattributed employer.")
                    if claim.get("role") != exp["role"] or claim.get("entity_id") != str(exp["id"]):
                        errors.append("Role or employment identity does not match the cited fact.")
                    dates = {"start": str(exp["start_date"]), "end": str(exp["end_date"]) if exp.get("end_date") else ("Present" if exp.get("is_current") else "")}
                    if claim.get("dates") != dates:
                        errors.append("Employment dates do not match canonical evidence.")
        elif section == "education":
            fields = ("degree", "institution", "field_of_study")
            matching = [e for e in self.profile.get("education", []) if all(
                isinstance(claim.get(k), str) and claim[k] and claim[k] == e.get(k) for k in fields
            )]
            if not matching or text != f"{claim.get('degree')} in {claim.get('field_of_study')}, {claim.get('institution')}":
                errors.append("Claim is not in verified education.")
        else:
            errors.append(f"Unsupported claim section: {section}.")
        return not errors, errors

    def validate_draft(self, structured_resume: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
        errors: List[str] = []
        claims = structured_resume.get("claims") if isinstance(structured_resume, dict) else None
        if not isinstance(claims, list) or not claims:
            claims = []
            errors.append("Draft must contain a nonempty claims list.")
        seen = set()
        count = 0
        fact_ids = set()
        for claim in claims:
            valid, claim_errors = self.validate_claim(claim)
            errors.extend(claim_errors)
            if not isinstance(claim, dict):
                continue
            cid = claim.get("claim_id")
            if not isinstance(cid, str) or not cid or cid in seen:
                errors.append("Claim IDs must be nonempty and unique.")
            else:
                seen.add(cid)
            if valid:
                count += 1
                fact_ids.update(claim.get("fact_ids", []))
        report = {"is_valid": not errors, "total_claims": len(claims), "validated_claims": count,
                  "errors": errors, "verified_facts_referenced": sorted(fact_ids)}
        return not errors, report
