from uuid import UUID, uuid4
import hashlib
import re
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from services.memory.repository import JobRepository
from services.applications.readiness import (
    ApplicationPackage,
    check_application_readiness,
    is_allowed_application_page,
    validate_application_binding,
)
from services.applications.validator import FieldPlanValidator

class ApplicationCopilotService:
    def __init__(self, repo: Optional[JobRepository] = None) -> None:
        self.repo = repo or JobRepository()

    @staticmethod
    def _identifier_error(**identifiers: str) -> Optional[Dict[str, Any]]:
        """Return a structured error before invalid UUIDs reach PostgreSQL."""
        for label, value in identifiers.items():
            try:
                UUID(str(value))
            except (ValueError, TypeError, AttributeError):
                return {"status": "error", "message": f"{label} must be a valid UUID."}
        return None

    def _bound_package(
        self,
        application: Dict[str, Any],
    ) -> Tuple[Optional[ApplicationPackage], List[str]]:
        ready, package, blockers = check_application_readiness(
            self.repo, str(application["job_id"])
        )
        if not ready or package is None:
            return None, blockers
        blockers.extend(validate_application_binding(application, package))
        return (package if not blockers else None), blockers

    def prepare_application(
        self,
        job_id: str,
        idempotency_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Validates job readiness, creates or binds the canonical application session,
        and initializes an append-only application attempt.
        """
        identifier_error = self._identifier_error(job_id=job_id)
        if identifier_error:
            return identifier_error
        is_ready, package, blockers = check_application_readiness(self.repo, job_id)
        if not is_ready or package is None:
            return {
                "status": "blocked",
                "job_id": job_id,
                "blockers": blockers
            }

        try:
            app, is_new_app = self.repo.create_or_get_application(
                job_id=job_id,
                resume_version_id=package.resume_version_id,
                content_hash=package.content_hash,
                pdf_hash=package.pdf_hash,
                analysis_id=package.analysis_id,
                application_url=package.application_url,
                ats_type=package.ats_type
            )
        except ValueError as exc:
            return {"status": "blocked", "job_id": job_id, "blockers": [str(exc)]}

        app_id = str(app["id"])
        idem_key = idempotency_key or f"prep_{uuid4().hex[:12]}"

        try:
            attempt, is_new_attempt = self.repo.create_application_attempt(
                application_id=app_id,
                idempotency_key=idem_key,
                stage_label="prepared",
                current_page_url=package.application_url
            )
        except ValueError as exc:
            return {"status": "blocked", "job_id": job_id, "blockers": [str(exc)]}

        # Transition application to PREPARING if currently DRAFT
        if app.get("status") == "DRAFT":
            transitioned, message = self.repo.transition_application_state(
                application_id=app_id,
                to_status="PREPARING",
                actor="copilot",
                reason="Application session prepared",
                attempt_id=str(attempt["id"])
            )
            if not transitioned:
                return {"status": "error", "message": message}

        # Transition job workflow state from READY to APPLICATION_STARTED if applicable
        job = self.repo.get_job_by_id(job_id)
        if job and job.get("status") == "READY":
            transitioned, message = self.repo.transition_job_workflow(
                job_id=job_id,
                next_state="APPLICATION_STARTED",
                actor="copilot",
                reason="Guarded application preparation initialized"
            )
            if not transitioned:
                return {"status": "error", "message": message}

        return {
            "status": "ready",
            "application_id": app_id,
            "attempt_id": str(attempt["id"]),
            "attempt_number": attempt["attempt_number"],
            "application_url": package.application_url,
            "ats_type": package.ats_type,
            "resume_version_id": package.resume_version_id,
            "pdf_path": package.pdf_path,
            "pdf_hash": package.pdf_hash,
            "is_new_application": is_new_app,
            "is_new_attempt": is_new_attempt
        }

    def get_application_context(
        self,
        application_id: str,
        attempt_id: str
    ) -> Dict[str, Any]:
        """
        Retrieves scoped data package for Antigravity:
        - Job metadata and application URL.
        - Approved resume artifact info (path and digest).
        - Safe candidate profile fields (redacted of internal IDs).
        - Policy summary.
        """
        identifier_error = self._identifier_error(
            application_id=application_id, attempt_id=attempt_id
        )
        if identifier_error:
            return identifier_error
        app = self.repo.get_application_by_id(application_id)
        if not app:
            return {"status": "error", "message": f"Application '{application_id}' not found."}

        attempt = self.repo.get_application_attempt(attempt_id)
        if not attempt:
            return {"status": "error", "message": f"Attempt '{attempt_id}' not found."}
        if str(attempt["application_id"]) != str(application_id):
            return {"status": "error", "message": "Attempt does not belong to the application."}

        job_id = str(app["job_id"])
        job = self.repo.get_job_by_id(job_id)
        if not job:
            return {"status": "error", "message": f"Job '{job_id}' not found."}

        package, blockers = self._bound_package(app)
        if package is None:
            return {"status": "blocked", "message": "Application readiness check failed.", "blockers": blockers}

        full_name = str(package.candidate_profile.get("full_name") or "").strip()
        parts = full_name.split()

        profile_links = package.candidate_profile.get("links", {})
        if isinstance(profile_links, list):
            merged_links: Dict[str, Any] = {}
            for item in profile_links:
                if isinstance(item, dict):
                    merged_links[str(item.get("name", "")).lower()] = item.get("url", "")
            profile_links = merged_links
        elif isinstance(profile_links, dict):
            profile_links = dict(profile_links)
        else:
            profile_links = {}
        prefs = package.candidate_profile.get("preferences") or {}
        if isinstance(prefs, dict):
            pref_linkedin = str(prefs.get("linkedin_url") or "").strip()
            if pref_linkedin and not str(profile_links.get("linkedin") or "").strip():
                profile_links["linkedin"] = pref_linkedin

        return {
            "status": "success",
            "application_id": application_id,
            "attempt_id": attempt_id,
            "job": {
                "job_id": job_id,
                "title": job["title"],
                "company": job["company"],
                "application_url": app.get("application_url") or package.application_url,
                "ats_type": app.get("ats_detected") or job.get("ats_type")
            },
            "resume_artifact": {
                "version_id": package.resume_version_id,
                "version_number": package.version_number,
                "pdf_path": package.pdf_path,
                "pdf_hash": package.pdf_hash
            },
            "candidate_safe_fields": {
                "full_name": full_name,
                "first_name": parts[0] if parts else "",
                "last_name": parts[-1] if len(parts) > 1 else "",
                "email": package.candidate_profile.get("email"),
                "phone": package.candidate_profile.get("phone"),
                "location": package.candidate_profile.get("location"),
                "links": profile_links
            },
            "policy_summary": {
                "safe_fields": ["full_name", "first_name", "last_name", "email", "phone", "location", "linkedin", "github", "portfolio", "resume_upload"],
                "human_review_required": [
                    "work_authorization", "sponsorship", "citizenship", "security_clearance",
                    "salary_expectations", "notice_period", "availability", "free_text_questions"
                ],
                "prohibited_fields": [
                    "demographic_questions (race, gender, veteran, disability)",
                    "legal_signatures_and_attestations",
                    "passwords_and_mfa",
                    "final_submit_action"
                ]
            }
        }

    def record_form_snapshot(
        self,
        attempt_id: str,
        page_url: str,
        form_fingerprint: str,
        fields_metadata: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Persists sanitized form snapshot and transitions attempt state to INSPECTING.
        """
        identifier_error = self._identifier_error(attempt_id=attempt_id)
        if identifier_error:
            return identifier_error
        attempt = self.repo.get_application_attempt(attempt_id)
        if not attempt:
            return {"status": "error", "message": f"Attempt '{attempt_id}' not found."}

        application = self.repo.get_application_by_id(str(attempt["application_id"]))
        if not application:
            return {"status": "error", "message": "Attempt application was not found."}
        allowed_page, page_error = is_allowed_application_page(
            str(application["application_url"]), page_url
        )
        if not allowed_page:
            return {"status": "error", "message": f"Unsafe application page: {page_error}"}
        if not re.fullmatch(r"[a-f0-9]{64}", form_fingerprint or ""):
            return {"status": "error", "message": "form_fingerprint must be a lowercase SHA-256 digest."}
        if not isinstance(fields_metadata, list) or len(fields_metadata) > 200:
            return {"status": "error", "message": "fields_metadata must be a list with at most 200 fields."}

        allowed_metadata_keys = {"field_key", "label", "control_type", "name", "options", "required"}
        sanitized_fields: List[Dict[str, Any]] = []
        seen_keys = set()
        for index, field in enumerate(fields_metadata):
            if not isinstance(field, dict) or set(field) - allowed_metadata_keys:
                return {"status": "error", "message": f"Field metadata at index {index} has an invalid shape."}
            field_key = field.get("field_key")
            if not isinstance(field_key, str) or not field_key.strip() or len(field_key) > 100:
                return {"status": "error", "message": f"Field metadata at index {index} has an invalid field_key."}
            if field_key in seen_keys:
                return {"status": "error", "message": f"Duplicate field_key '{field_key}'."}
            seen_keys.add(field_key)
            label = field.get("label")
            control_type = field.get("control_type")
            if not isinstance(label, str) or not label.strip() or len(label) > 500:
                return {"status": "error", "message": f"Field '{field_key}' has an invalid label."}
            if not isinstance(control_type, str) or not control_type.strip() or len(control_type) > 50:
                return {"status": "error", "message": f"Field '{field_key}' has an invalid control_type."}
            options = field.get("options", [])
            if not isinstance(options, list) or len(options) > 100 or any(not isinstance(option, str) or len(option) > 300 for option in options):
                return {"status": "error", "message": f"Field '{field_key}' has invalid options."}
            sanitized_fields.append({
                "field_key": field_key,
                "label": label.strip(),
                "control_type": control_type.strip().lower(),
                "name": str(field.get("name") or "")[:200],
                "options": options,
                "required": bool(field.get("required", False)),
            })

        snapshot = self.repo.save_form_snapshot(
            attempt_id=attempt_id,
            page_url=page_url,
            form_fingerprint=form_fingerprint,
            fields_metadata=sanitized_fields
        )

        if attempt.get("status") == "CREATED":
            transitioned, message = self.repo.transition_attempt_state(
                attempt_id=attempt_id,
                to_status="INSPECTING",
                stage_label="form_inspected",
                current_page_url=page_url
            )
            if not transitioned:
                return {"status": "error", "message": message}

        return {
            "status": "success",
            "form_snapshot_id": str(snapshot["id"]),
            "attempt_id": attempt_id,
            "fields_count": len(sanitized_fields)
        }

    def submit_field_plan(
        self,
        application_id: str,
        attempt_id: str,
        form_snapshot_id: str,
        fields: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Validates proposed field plan deterministically against candidate memory and policy.
        Persists plan and returns approved fill actions versus blocked fields.
        """
        identifier_error = self._identifier_error(
            application_id=application_id,
            attempt_id=attempt_id,
            form_snapshot_id=form_snapshot_id,
        )
        if identifier_error:
            return identifier_error
        app = self.repo.get_application_by_id(application_id)
        if not app:
            return {"status": "error", "message": f"Application '{application_id}' not found."}

        attempt = self.repo.get_application_attempt(attempt_id)
        if not attempt:
            return {"status": "error", "message": f"Attempt '{attempt_id}' not found."}
        if str(attempt["application_id"]) != str(application_id):
            return {"status": "error", "message": "Attempt does not belong to the application."}

        snapshot = self.repo.get_form_snapshot(form_snapshot_id)
        if not snapshot:
            return {"status": "error", "message": f"Form snapshot '{form_snapshot_id}' not found."}
        if str(snapshot["attempt_id"]) != str(attempt_id):
            return {"status": "error", "message": "Form snapshot does not belong to the attempt."}
        latest_snapshot = self.repo.get_latest_form_snapshot(attempt_id)
        if not latest_snapshot or str(latest_snapshot["id"]) != str(form_snapshot_id):
            return {"status": "error", "message": "Field plan references a stale form snapshot."}

        package, blockers = self._bound_package(app)
        if package is None:
            return {"status": "error", "message": "Application readiness invalidated.", "errors": blockers}

        validator = FieldPlanValidator(package.candidate_profile, package)
        plan_data = {"form_snapshot_id": form_snapshot_id, "fields": fields}
        is_valid, allowed_fields, blocked_fields, errors = validator.validate_plan(plan_data, snapshot)

        # Save to database
        validation_status = "VALIDATED" if is_valid else "REJECTED"
        persisted_fields = allowed_fields + blocked_fields if is_valid else fields
        saved_plan = self.repo.save_field_plan(
            attempt_id=attempt_id,
            form_snapshot_id=form_snapshot_id,
            fields=persisted_fields,
            validation_status=validation_status,
            validation_errors=errors
        )

        if is_valid and attempt.get("status") == "INSPECTING":
            transitioned, message = self.repo.transition_attempt_state(
                attempt_id=attempt_id,
                to_status="PLANNED",
                stage_label="plan_validated"
            )
            if not transitioned:
                return {"status": "error", "message": message}

        return {
            "status": "validated" if is_valid else "rejected",
            "application_id": application_id,
            "attempt_id": attempt_id,
            "form_snapshot_id": form_snapshot_id,
            "field_plan_id": str(saved_plan["id"]),
            "allowed_count": len(allowed_fields),
            "blocked_count": len(blocked_fields),
            "allowed_fields": allowed_fields,
            "blocked_fields": blocked_fields,
            "errors": errors
        }

    def record_actions(
        self,
        attempt_id: str,
        form_snapshot_id: str,
        actions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Audits executed fill and upload actions.
        """
        identifier_error = self._identifier_error(
            attempt_id=attempt_id, form_snapshot_id=form_snapshot_id
        )
        if identifier_error:
            return identifier_error
        attempt = self.repo.get_application_attempt(attempt_id)
        if not attempt:
            return {"status": "error", "message": f"Attempt '{attempt_id}' not found."}

        snapshot = self.repo.get_form_snapshot(form_snapshot_id)
        if not snapshot or str(snapshot["attempt_id"]) != str(attempt_id):
            return {"status": "error", "message": "Form snapshot does not belong to the attempt."}
        plan = self.repo.get_latest_validated_field_plan(attempt_id, form_snapshot_id)
        if not plan:
            return {"status": "error", "message": "No validated field plan exists for these actions."}
        if attempt["status"] not in {"PLANNED", "FILLING"}:
            return {"status": "error", "message": f"Actions cannot be recorded while attempt is '{attempt['status']}'."}
        if not isinstance(actions, list) or not actions or len(actions) > 200:
            return {"status": "error", "message": "actions must contain 1 to 200 entries."}

        application = self.repo.get_application_by_id(str(attempt["application_id"]))
        if not application:
            return {"status": "error", "message": "Attempt application was not found."}
        package, blockers = self._bound_package(application)
        if package is None:
            return {"status": "error", "message": "Application binding is no longer valid.", "errors": blockers}

        planned_actions = {
            field["field_key"]: field
            for field in plan.get("fields", [])
            if isinstance(field, dict) and field.get("decision") in {"fill", "upload"}
        }
        seen_idempotency = set()
        normalized_actions: List[Dict[str, Any]] = []
        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                return {"status": "error", "message": f"Action at index {index} must be an object."}
            field_key = action.get("field_key")
            planned = planned_actions.get(field_key)
            if not planned:
                return {"status": "error", "message": f"Action field '{field_key}' is not approved by the validated plan."}
            idempotency_key = action.get("idempotency_key")
            if not isinstance(idempotency_key, str) or not idempotency_key or len(idempotency_key) > 100:
                return {"status": "error", "message": f"Action '{field_key}' requires a valid idempotency_key."}
            if idempotency_key in seen_idempotency:
                return {"status": "error", "message": f"Duplicate action idempotency_key '{idempotency_key}'."}
            seen_idempotency.add(idempotency_key)
            action_type = str(action.get("action_type") or "").upper()
            expected_types = {"FILL", "SELECT"} if planned["decision"] == "fill" else {"UPLOAD"}
            if action_type not in expected_types:
                return {"status": "error", "message": f"Action '{field_key}' has type '{action_type}' but plan allows {sorted(expected_types)}."}
            status = str(action.get("status") or "").upper()
            if status not in {"SUCCESS", "FAILED", "BLOCKED"}:
                return {"status": "error", "message": f"Action '{field_key}' has invalid status '{status}'."}
            observed_value = action.get("value")
            if status == "SUCCESS" and observed_value is None:
                return {"status": "error", "message": f"Successful action '{field_key}' requires the observed value."}
            if status == "SUCCESS" and str(observed_value) != str(planned.get("proposed_value")):
                return {"status": "error", "message": f"Observed value for '{field_key}' differs from the validated plan."}
            if action_type == "UPLOAD":
                artifact_path = planned.get("upload_artifact_path")
                if not isinstance(artifact_path, str):
                    return {"status": "error", "message": "Validated upload is missing its artifact path."}
                try:
                    artifact_digest = hashlib.sha256(Path(artifact_path).read_bytes()).hexdigest()
                except OSError as exc:
                    return {"status": "error", "message": f"Cannot verify bound resume PDF: {exc}"}
                if artifact_digest != package.pdf_hash:
                    return {"status": "error", "message": "Bound resume PDF changed before action recording."}
            normalized_actions.append({
                **action,
                "idempotency_key": idempotency_key,
                "action_type": action_type,
                "status": status,
            })

        count = self.repo.record_fill_actions(
            attempt_id=attempt_id,
            form_snapshot_id=form_snapshot_id,
            field_plan_id=str(plan["id"]),
            actions=normalized_actions
        )

        if attempt.get("status") == "PLANNED":
            transitioned, message = self.repo.transition_attempt_state(
                attempt_id=attempt_id,
                to_status="FILLING",
                stage_label="actions_executed"
            )
            if not transitioned:
                return {"status": "error", "message": message}

        return {
            "status": "success",
            "attempt_id": attempt_id,
            "recorded_actions_count": count
        }

    def create_checkpoint(
        self,
        application_id: str,
        attempt_id: str,
        stage: str,
        page_url: str,
        blockers: List[str],
        next_action: str,
        human_checklist: List[Dict[str, Any]],
        idempotency_key: Optional[str] = None,
        snapshot_metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Captures pre-submit review checkpoint and manages safe human handoff.
        """
        identifier_error = self._identifier_error(
            application_id=application_id, attempt_id=attempt_id
        )
        if identifier_error:
            return identifier_error
        application = self.repo.get_application_by_id(application_id)
        attempt = self.repo.get_application_attempt(attempt_id)
        if not application or not attempt or str(attempt["application_id"]) != str(application_id):
            return {"status": "error", "message": "Application and attempt do not match."}
        allowed_page, page_error = is_allowed_application_page(
            str(application["application_url"]), page_url
        )
        if not allowed_page:
            return {"status": "error", "message": f"Unsafe checkpoint page: {page_error}"}
        if not isinstance(blockers, list) or any(not isinstance(item, str) for item in blockers):
            return {"status": "error", "message": "blockers must be a list of strings."}
        if not isinstance(human_checklist, list) or any(
            not isinstance(item, dict) for item in human_checklist
        ):
            return {"status": "error", "message": "human_checklist must be a list of objects."}
        if not isinstance(stage, str) or not stage.strip() or len(stage) > 100:
            return {"status": "error", "message": "stage must contain 1 to 100 characters."}
        if next_action not in {"human_review", "human_takeover"}:
            return {"status": "error", "message": "Checkpoint next_action must require human review or takeover."}

        target_status = "NEEDS_HUMAN_INPUT" if blockers else "READY_FOR_HUMAN_REVIEW"
        checkpoint_key = idempotency_key or hashlib.sha256(
            f"{application_id}:{attempt_id}:{stage}:{page_url}:{target_status}".encode("utf-8")
        ).hexdigest()
        try:
            checkpoint = self.repo.save_application_checkpoint(
            application_id=application_id,
            attempt_id=attempt_id,
            idempotency_key=checkpoint_key,
            stage=stage,
            page_url=page_url,
            blockers=blockers,
            next_action=next_action,
            human_checklist=human_checklist,
            application_status=target_status,
            snapshot_metadata=snapshot_metadata
        )
        except ValueError as exc:
            return {"status": "error", "message": str(exc)}

        return {
            "status": "checkpointed",
            "checkpoint_id": str(checkpoint["id"]),
            "stage": stage,
            "page_url": page_url,
            "has_blockers": bool(blockers),
            "blockers_count": len(blockers),
            "human_checklist": human_checklist
        }

    def get_application_status(self, application_id: str) -> Dict[str, Any]:
        """
        Returns application status, latest attempt, checkpoints, and review items.
        """
        identifier_error = self._identifier_error(application_id=application_id)
        if identifier_error:
            return identifier_error
        app = self.repo.get_application_by_id(application_id)
        if not app:
            return {"status": "error", "message": f"Application '{application_id}' not found."}

        latest_attempt = self.repo.get_latest_attempt(application_id)
        latest_checkpoint = self.repo.get_latest_checkpoint(application_id)
        job = self.repo.get_job_by_id(str(app["job_id"]))

        return {
            "status": "success",
            "application": {
                "id": str(app["id"]),
                "job_id": str(app["job_id"]),
                "company": job.get("company") if job else None,
                "title": job.get("title") if job else None,
                "status": app["status"],
                "applied_at": app.get("applied_at"),
                "application_url": app.get("application_url"),
                "resume_version_id": str(app.get("resume_version_id") or ""),
                "resume_pdf_hash": app.get("resume_pdf_hash"),
                "created_at": app.get("created_at")
            },
            "latest_attempt": latest_attempt,
            "latest_checkpoint": latest_checkpoint
        }
