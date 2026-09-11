import re
import hashlib
from pathlib import Path
from typing import Dict, Any, List, Tuple, Set
from services.applications.readiness import ApplicationPackage
from services.applications.policy import (
    FieldRiskClass, FieldDecision, SourceType,
    classify_field, is_decision_allowed, reconcile_risk
)

class FieldPlanValidationError(Exception):
    def __init__(self, errors: List[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors

class FieldPlanValidator:
    def __init__(self, candidate_profile: Dict[str, Any], application_package: ApplicationPackage) -> None:
        self.profile = candidate_profile
        self.package = application_package
        self.verified_fact_ids: Set[str] = {
            f["fact_id"] for f in self.profile.get("verified_facts", []) if "fact_id" in f
        }

    def _extract_canonical_contact_values(self) -> Dict[str, str]:
        """Extracts normalized canonical values from verified profile."""
        full_name = str(self.profile.get("full_name") or "").strip()
        parts = full_name.split()
        first_name = parts[0] if parts else ""
        last_name = parts[-1] if len(parts) > 1 else ""

        # Extract links from links/social list, falling back to
        # canonical preferences.linkedin_url (loader/seed source of truth).
        links = self.profile.get("links", {})
        if isinstance(links, list):
            links_dict = {}
            for item in links:
                if isinstance(item, dict):
                    links_dict[item.get("name", "").lower()] = item.get("url", "")
            links = links_dict
        if isinstance(links, dict):
            links = dict(links)
        else:
            links = {}
        prefs = self.profile.get("preferences") or {}
        if isinstance(prefs, dict):
            pref_linkedin = str(prefs.get("linkedin_url") or "").strip()
            if pref_linkedin and not str(links.get("linkedin") or "").strip():
                links["linkedin"] = pref_linkedin

        return {
            "first_name": first_name.lower(),
            "last_name": last_name.lower(),
            "full_name": full_name.lower(),
            "email": str(self.profile.get("email") or "").strip().lower(),
            "phone": re.sub(r"[^\d+]", "", str(self.profile.get("phone") or "")),
            "location": str(self.profile.get("location") or "").strip().lower(),
            "linkedin": str(links.get("linkedin") or "").strip().lower(),
            "github": str(links.get("github") or "").strip().lower(),
            "portfolio": str(links.get("portfolio") or links.get("website") or "").strip().lower(),
        }

    def validate_plan(
        self,
        plan: Dict[str, Any],
        form_snapshot: Dict[str, Any]
    ) -> Tuple[bool, List[Dict[str, Any]], List[Dict[str, Any]], List[str]]:
        """
        Deterministically validates an AI-proposed field plan against candidate memory,
        form snapshot identity, and risk classification policy.

        Returns:
            is_valid (bool): True if plan has no structural or policy violation errors.
            allowed_fields (List): Fields approved for autonomous filling/uploading.
            blocked_fields (List): Fields requiring human review or prohibited from automation.
            errors (List[str]): Critical validation errors (e.g. attempted policy downgrades).
        """
        errors: List[str] = []
        allowed_fields: List[Dict[str, Any]] = []
        blocked_fields: List[Dict[str, Any]] = []

        if not isinstance(plan, dict):
            return False, [], [], ["Field plan must be a JSON object."]

        # 1. Snapshot Identity Verification
        expected_snap_id = str(form_snapshot.get("id") or "")
        plan_snap_id = str(plan.get("form_snapshot_id") or "")
        if plan_snap_id != expected_snap_id:
            errors.append(f"Snapshot mismatch: plan references '{plan_snap_id}', current is '{expected_snap_id}'.")

        fields = plan.get("fields")
        if not isinstance(fields, list):
            return False, [], [], ["Plan must contain a 'fields' list."]

        canonical_values = self._extract_canonical_contact_values()
        snapshot_fields = form_snapshot.get("fields_metadata", [])
        if not isinstance(snapshot_fields, list):
            return False, [], [], ["Form snapshot fields_metadata must be a list."]
        metadata_by_key = {
            item.get("field_key"): item
            for item in snapshot_fields
            if isinstance(item, dict) and isinstance(item.get("field_key"), str)
        }
        seen_keys: Set[str] = set()

        for idx, field in enumerate(fields):
            if not isinstance(field, dict):
                errors.append(f"Field at index {idx} must be an object.")
                continue

            field_key = field.get("field_key")
            if not field_key or not isinstance(field_key, str):
                errors.append(f"Field at index {idx} missing valid 'field_key'.")
                continue

            if field_key in seen_keys:
                errors.append(f"Duplicate field_key '{field_key}' in plan.")
            seen_keys.add(field_key)

            snapshot_field = metadata_by_key.get(field_key)
            if not snapshot_field:
                errors.append(f"Field '{field_key}' is not present in the referenced form snapshot.")
                continue

            label = str(field.get("label") or "").strip()
            control_type = str(field.get("control_type") or "text").lower()
            prop_risk_raw = str(field.get("risk_class") or "unknown").lower()
            decision_raw = str(field.get("decision") or "leave_blank").lower()

            for metadata_key in ("label", "control_type"):
                proposed = str(field.get(metadata_key) or "").strip().lower()
                captured = str(snapshot_field.get(metadata_key) or "").strip().lower()
                if proposed != captured:
                    errors.append(
                        f"Field '{field_key}' {metadata_key} does not match the captured form snapshot."
                    )
            if "name" in field and str(field.get("name") or "").strip().lower() != str(snapshot_field.get("name") or "").strip().lower():
                errors.append(f"Field '{field_key}' name does not match the captured form snapshot.")
            options = snapshot_field.get("options")

            try:
                prop_risk = FieldRiskClass(prop_risk_raw)
            except ValueError:
                errors.append(f"Field '{label}': invalid risk_class '{prop_risk_raw}'.")
                continue

            try:
                decision = FieldDecision(decision_raw)
            except ValueError:
                errors.append(f"Field '{label}': invalid decision '{decision_raw}'.")
                continue

            # Deterministic Classification
            det_risk, matched_subfield = classify_field(
                label,
                control_type,
                name=str(snapshot_field.get("name") or ""),
                options=options if isinstance(options, list) else None,
            )

            # Reconcile risk (escalation only)
            final_risk, is_risk_valid = reconcile_risk(det_risk, prop_risk)
            if not is_risk_valid:
                errors.append(
                    f"Policy violation on field '{label}': cannot downgrade risk from '{det_risk.value}' to '{prop_risk.value}'."
                )
                blocked_fields.append({**field, "block_reason": "Attempted risk downgrade"})
                continue

            # Decision allowed for final risk?
            if not is_decision_allowed(final_risk, decision):
                errors.append(
                    f"Policy violation on field '{label}': decision '{decision.value}' forbidden for risk '{final_risk.value}'."
                )
                blocked_fields.append({**field, "block_reason": f"Decision forbidden for {final_risk.value}"})
                continue

            # Check decision specifics
            if decision == FieldDecision.FILL:
                if final_risk != FieldRiskClass.SAFE:
                    errors.append(f"Field '{label}': only SAFE fields can have decision 'fill'.")
                    blocked_fields.append({**field, "block_reason": "Non-safe field cannot be filled"})
                    continue

                if control_type == "file":
                    errors.append(f"Field '{label}': file controls require decision 'upload'.")
                    continue

                if field.get("source_type") != SourceType.CANDIDATE_PROFILE.value:
                    errors.append(f"Field '{label}': safe factual fills must use candidate_profile as source_type.")
                    continue
                source_id = field.get("source_id")
                candidate_id = self.profile.get("id")
                if source_id is not None and str(source_id) != str(candidate_id):
                    errors.append(f"Field '{label}': source_id does not belong to the current candidate.")
                    continue

                prop_value = field.get("proposed_value")
                if prop_value is None or str(prop_value).strip() == "":
                    errors.append(f"Field '{label}': decision is 'fill' but proposed_value is empty.")
                    continue

                # Verify canonical truthfulness if matched to contact field
                if matched_subfield and matched_subfield in canonical_values:
                    expected_canon = canonical_values[matched_subfield]
                    norm_prop = str(prop_value).strip().lower()

                    if matched_subfield == "phone":
                        norm_prop = re.sub(r"[^\d+]", "", norm_prop)

                    if not expected_canon:
                        errors.append(f"Field '{label}': canonical candidate value is missing.")
                        continue
                    if norm_prop != expected_canon:
                        errors.append(
                            f"Untruthful value for '{label}': '{prop_value}' does not match canonical '{expected_canon}'."
                        )
                        continue

                # Fact-ID provenance check for claim-bearing fields
                fact_ids = field.get("fact_ids", [])
                if not isinstance(fact_ids, list):
                    errors.append(f"Field '{label}': fact_ids must be a list.")
                    continue
                for fid in fact_ids:
                    if fid not in self.verified_fact_ids:
                        errors.append(f"Field '{label}': references unverified or unknown fact_id '{fid}'.")

                allowed_fields.append({**field, "resolved_risk": final_risk.value})

            elif decision == FieldDecision.UPLOAD:
                if final_risk != FieldRiskClass.SAFE:
                    errors.append(f"Field '{label}': upload decision only allowed for safe resume input.")
                    blocked_fields.append({**field, "block_reason": "Non-safe file upload"})
                    continue

                if control_type != "file":
                    errors.append(f"Field '{label}': decision 'upload' requires control_type 'file'.")
                    continue

                if field.get("source_type") != SourceType.RESUME_ARTIFACT.value:
                    errors.append(f"Field '{label}': resume uploads must use resume_artifact as source_type.")
                    continue

                # Must target exact bound PDF artifact
                expected_pdf = self.package.pdf_path
                prop_path = field.get("proposed_value") or expected_pdf
                if prop_path != expected_pdf:
                    errors.append(
                        f"Field '{label}': upload path '{prop_path}' does not match bound approved PDF '{expected_pdf}'."
                    )
                    continue

                pdf_path = Path(expected_pdf)
                if pdf_path.is_symlink() or not pdf_path.is_file():
                    errors.append(f"Field '{label}': bound PDF artifact is unavailable or is a symlink.")
                    continue
                if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != self.package.pdf_hash:
                    errors.append(f"Field '{label}': bound PDF digest changed before upload.")
                    continue

                allowed_fields.append({
                    **field,
                    "resolved_risk": final_risk.value,
                    "upload_artifact_path": expected_pdf,
                    "upload_artifact_digest": self.package.pdf_hash
                })

            elif decision == FieldDecision.ASK_HUMAN:
                blocked_fields.append({
                    **field,
                    "resolved_risk": final_risk.value,
                    "block_reason": field.get("reason") or f"Requires human review ({final_risk.value})"
                })

            elif decision == FieldDecision.LEAVE_BLANK:
                blocked_fields.append({
                    **field,
                    "resolved_risk": final_risk.value,
                    "block_reason": "Field must remain unfilled by automation",
                })

        required_keys = {
            item["field_key"]
            for item in snapshot_fields
            if isinstance(item, dict) and item.get("required") is True and item.get("field_key")
        }
        for missing_key in sorted(required_keys - seen_keys):
            errors.append(f"Required captured field '{missing_key}' is missing from the plan.")

        if errors:
            return False, [], blocked_fields, errors
        return True, allowed_fields, blocked_fields, []
