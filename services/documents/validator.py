"""Fail-closed validation for the supported verbatim document format."""
from typing import Any, Dict, List, Optional, Tuple


class ProvenanceValidationError(ValueError):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class ClaimValidator:
    def __init__(
        self,
        candidate_profile: Dict[str, Any],
        variants: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.profile = candidate_profile
        self.verified_facts_by_id = {
            f["fact_id"]: f for f in candidate_profile.get("verified_facts", [])
            if f.get("verification_status") == "approved"
        }
        self.work_exp_by_id = {str(e["id"]): e for e in candidate_profile.get("work_experience", [])}
        self.variants_by_id = {
            str(v.get("id")): v for v in (variants or [])
            if isinstance(v, dict) and v.get("id")
        }

    VALID_CATEGORIES = {
        "experience", "skill", "responsibility", "domain",
        "location", "compensation", "screening", "other"
    }
    VALID_IMPORTANCE = {"required", "preferred", "unspecified"}
    VALID_MATCH_STATUS = {"matched", "partial", "unsupported", "gap"}
    VALID_REVIEW_STATUS = {"proposed", "confirmed"}

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

            status = req.get("match_status") or req.get("status")
            if status not in self.VALID_MATCH_STATUS:
                errors.append(f"Requirement '{rid}' has an invalid match_status: '{status}'. Allowed: {self.VALID_MATCH_STATUS}")

            category = req.get("category", "experience")
            if category not in self.VALID_CATEGORIES:
                errors.append(f"Requirement '{rid}' has invalid category '{category}'. Allowed: {self.VALID_CATEGORIES}")

            importance = req.get("importance", "required")
            if importance not in self.VALID_IMPORTANCE:
                errors.append(f"Requirement '{rid}' has invalid importance '{importance}'. Allowed: {self.VALID_IMPORTANCE}")

            review_status = req.get("review_status", "proposed")
            if review_status not in self.VALID_REVIEW_STATUS:
                errors.append(f"Requirement '{rid}' has invalid review_status '{review_status}'. Allowed: {self.VALID_REVIEW_STATUS}")

            quote = req.get("jd_quote")
            if not isinstance(quote, str) or not quote.strip() or (jd_text is not None and quote not in jd_text):
                errors.append(f"Requirement '{rid}' must quote exact JD text.")

            ids = req.get("evidence_fact_ids") if "evidence_fact_ids" in req else req.get("matched_fact_ids", [])
            if not isinstance(ids, list) or any(not isinstance(fid, str) for fid in ids):
                errors.append(f"Requirement '{rid}' requires a list of fact IDs.")
                continue
            if status in ("matched", "partial") and not ids:
                errors.append(f"Requirement '{rid}' has no matched_fact_ids / evidence_fact_ids (empty evidence).")
            if status in ("unsupported", "gap") and ids:
                errors.append(f"Requirement '{rid}' has match_status '{status}' but contains evidence fact IDs.")
            for fid in ids:
                if fid not in self.verified_facts_by_id:
                    errors.append(f"Requirement '{rid}' references unknown or unapproved fact_id '{fid}'.")

            evidence_quotes = req.get("evidence_quotes", [])
            if status in ("unsupported", "gap") and evidence_quotes:
                errors.append(f"Requirement '{rid}' has match_status '{status}' but contains evidence quotes.")
            if status in ("matched", "partial"):
                if not isinstance(evidence_quotes, list) or not evidence_quotes:
                    errors.append(f"Requirement '{rid}' requires evidence_quotes for every proposed match.")
                else:
                    cited_texts = {
                        self.verified_facts_by_id[fid]["text"]
                        for fid in ids if fid in self.verified_facts_by_id
                    }
                    if set(evidence_quotes) != cited_texts:
                        errors.append(
                            f"Requirement '{rid}' evidence_quotes must exactly match its cited fact texts."
                        )

            # Semantic correspondence is a proposal, not a deterministic fact check.
            # Exact fact quotations are the only automatically certified matches in V1.
            if status == "matched" and ids and not any(
                quote == self.verified_facts_by_id.get(fid, {}).get("text") for fid in ids
            ):
                if review_status != "confirmed":
                    errors.append(f"Requirement '{rid}': semantic matches must be 'partial' pending human review.")
        return not errors, errors

    def validate_analysis_submission(
        self,
        analysis_data: Dict[str, Any],
        jd_snapshot: Dict[str, Any],
        candidate_snapshot: Dict[str, Any]
    ) -> Tuple[bool, List[str]]:
        errors: List[str] = []
        if not isinstance(analysis_data, dict):
            return False, ["Analysis submission must be a JSON object."]

        # Validate snapshot identity against superseding
        sub_jd_snap = str(analysis_data.get("jd_snapshot_id", ""))
        actual_jd_snap = str(jd_snapshot.get("id", ""))
        if sub_jd_snap != actual_jd_snap:
            errors.append(f"Stale or mismatched jd_snapshot_id '{sub_jd_snap}'. Current snapshot is '{actual_jd_snap}'.")

        sub_cand_snap = str(analysis_data.get("candidate_snapshot_id", ""))
        actual_cand_snap = str(candidate_snapshot.get("id", ""))
        if sub_cand_snap != actual_cand_snap:
            errors.append(f"Stale or mismatched candidate_snapshot_id '{sub_cand_snap}'. Current snapshot is '{actual_cand_snap}'.")

        reqs = analysis_data.get("requirements")
        if not isinstance(reqs, list) or not reqs:
            errors.append("Analysis must contain a non-empty list of requirements.")
        else:
            jd_text = jd_snapshot.get("cleaned_text") or jd_snapshot.get("raw_text") or ""
            valid_reqs, req_errors = self.validate_requirement_analysis(reqs, jd_text=jd_text)
            errors.extend(req_errors)

        return not errors, errors

    def _validate_approved_variant(
        self, claim: Dict[str, Any], text: str, ids: List[str]
    ) -> List[str]:
        """Fail-closed checks for human-approved reusable wording."""
        errors: List[str] = []
        variant_id = claim.get("variant_id")
        variant = self.variants_by_id.get(str(variant_id)) if variant_id else None
        if variant is None:
            return [f"Unknown wording variant '{variant_id}'."]
        if variant.get("review_status") != "approved":
            errors.append(f"Wording variant '{variant_id}' is not human-approved.")
        if text != variant.get("variant_text"):
            errors.append(f"Claim text does not match approved variant '{variant_id}'.")
        import hashlib as _hashlib
        actual = _hashlib.sha256(str(variant.get("variant_text", "")).encode("utf-8")).hexdigest()
        if actual != variant.get("content_hash"):
            errors.append(f"Wording variant '{variant_id}' hash mismatch.")
        if str(variant.get("candidate_id")) != str(self.profile.get("id")):
            errors.append(f"Wording variant '{variant_id}' belongs to another candidate.")
        variant_fact_ids = variant.get("fact_ids", [])
        if (
            not isinstance(variant_fact_ids, list)
            or not variant_fact_ids
            or sorted(variant_fact_ids) != sorted(ids)
        ):
            errors.append(f"Wording variant '{variant_id}' fact binding must equal claim fact_ids.")
        for fid in variant_fact_ids:
            if fid not in self.verified_facts_by_id:
                errors.append(f"Wording variant '{variant_id}' cites unapproved fact_id '{fid}'.")
        return errors

    def _validate_experience_binding(
        self, claim: Dict[str, Any], fact: Dict[str, Any], errors: List[str]
    ) -> Tuple[bool, List[str]]:
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
        return (not errors), errors

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
        strategy = claim.get("generation_strategy", "verbatim")
        if strategy not in {"verbatim", "derived_template", "approved_variant"}:
            errors.append("Only verbatim, derived_template, and approved_variant strategies are supported.")
            return False, errors
        if section in ("experience", "summary"):
            ids = claim.get("fact_ids", [])
            if not isinstance(ids, list) or not ids or any(not isinstance(fid, str) for fid in ids):
                return False, errors + ["Claim must cite at least one approved fact_id."]
            if strategy == "derived_template":
                if section != "summary":
                    return False, errors + ["derived_template is allowed only for the summary."]
                from services.documents.summary import verify_derivation
                manifest = claim.get("derivation")
                valid_manifest, manifest_errors = verify_derivation(
                    manifest if isinstance(manifest, dict) else {}, self.profile
                )
                errors.extend(manifest_errors)
                if text != (manifest.get("final_text") if isinstance(manifest, dict) else None):
                    errors.append("Summary text must equal its derivation final_text.")
                if sorted(ids) != sorted(manifest.get("fact_ids", []) if isinstance(manifest, dict) else []):
                    errors.append("Summary fact_ids must equal its derivation fact_ids.")
                return (not errors), errors
            if strategy == "approved_variant":
                errors.extend(self._validate_approved_variant(claim, text, ids))
                if section == "experience":
                    first_fact = self.verified_facts_by_id.get(ids[0])
                    if first_fact is None:
                        return False, errors + ["Variant cites an unapproved fact_id."]
                    return self._validate_experience_binding(claim, first_fact, errors)
                return (not errors), errors
            # Verbatim path below (exactly one fact, exact text).
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
                return self._validate_experience_binding(claim, fact, errors)
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
