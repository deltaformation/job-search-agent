from dataclasses import dataclass
from typing import Dict, Any, List, Optional, Tuple
from pathlib import Path
from urllib.parse import urlparse
import ipaddress
import hashlib
import json
from services.memory.repository import JobRepository
from services.documents.renderer import ARTIFACTS_DIR

@dataclass
class ApplicationPackage:
    job_id: str
    application_url: str
    ats_type: Optional[str]
    resume_version_id: str
    version_number: int
    content_hash: str
    pdf_path: str
    pdf_hash: str
    candidate_profile: Dict[str, Any]
    candidate_snapshot_id: str
    jd_snapshot_id: str
    analysis_id: Optional[str]

class ReadinessValidationError(Exception):
    def __init__(self, blockers: List[str]) -> None:
        super().__init__("; ".join(blockers))
        self.blockers = blockers

def is_safe_apply_url(url: str) -> Tuple[bool, Optional[str]]:
    """
    Validates that apply URL is an allowed external HTTPS endpoint.
    Rejects file:, data:, javascript:, localhost, private/link-local/loopback IPs,
    embedded credentials, and malformed URLs.
    """
    if not url or not isinstance(url, str):
        return False, "Application URL is missing or empty."
    url_trimmed = url.strip()
    try:
        parsed = urlparse(url_trimmed)
    except Exception as e:
        return False, f"Malformed URL: {e}"

    if parsed.scheme.lower() != "https":
        return False, f"URL scheme must be HTTPS, got '{parsed.scheme}'."

    if parsed.username or parsed.password:
        return False, "URLs with embedded credentials are prohibited."

    hostname = parsed.hostname
    if not hostname:
        return False, "URL hostname is missing."

    hostname_lower = hostname.lower()
    if hostname_lower in ("localhost", "127.0.0.1", "::1") or hostname_lower.endswith(".local"):
        return False, f"Prohibited local/loopback destination: '{hostname}'."

    # Check for IP addresses (reject private, reserved, loopback)
    try:
        ip = ipaddress.ip_address(hostname_lower)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False, f"Prohibited private or reserved IP destination: '{hostname}'."
    except ValueError:
        # Not an IP address, valid domain name
        pass

    return True, None


KNOWN_ATS_HOST_SUFFIXES = (
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
)


def is_allowed_application_page(application_url: str, page_url: str) -> Tuple[bool, Optional[str]]:
    """Allow the bound host, its subdomains, or a recognized ATS redirect host."""
    bound_safe, bound_error = is_safe_apply_url(application_url)
    page_safe, page_error = is_safe_apply_url(page_url)
    if not bound_safe:
        return False, bound_error
    if not page_safe:
        return False, page_error

    bound_host = (urlparse(application_url).hostname or "").lower().rstrip(".")
    page_host = (urlparse(page_url).hostname or "").lower().rstrip(".")
    same_domain = (
        page_host == bound_host
        or page_host.endswith(f".{bound_host}")
        or bound_host.endswith(f".{page_host}")
    )
    known_ats = any(
        page_host == suffix or page_host.endswith(f".{suffix}")
        for suffix in KNOWN_ATS_HOST_SUFFIXES
    )
    if not same_domain and not known_ats:
        return False, f"Unexpected application redirect host '{page_host}'."
    return True, None


def validate_application_binding(
    application: Dict[str, Any],
    package: ApplicationPackage,
) -> List[str]:
    """Verify that an existing application still uses its immutable package."""
    blockers: List[str] = []
    comparisons = {
        "resume version": (application.get("resume_version_id"), package.resume_version_id),
        "resume content hash": (application.get("resume_content_hash"), package.content_hash),
        "resume PDF hash": (application.get("resume_pdf_hash"), package.pdf_hash),
        "analysis version": (application.get("analysis_id"), package.analysis_id),
        "application URL": (application.get("application_url"), package.application_url),
    }
    for label, (bound, current) in comparisons.items():
        if str(bound or "") != str(current or ""):
            blockers.append(
                f"Application-bound {label} no longer matches the current approved package."
            )
    return blockers

def check_application_readiness(
    repo: JobRepository,
    job_id: str
) -> Tuple[bool, Optional[ApplicationPackage], List[str]]:
    """
    Deterministically validates that a job is ready for application preparation:
    - Job exists, status is READY, not stale/withdrawn/rejected/expired.
    - Application URL is a safe external HTTPS endpoint.
    - Latest resume version is human-approved and artifact digests match disk.
    - Candidate profile contains required contact details.
    - Not already submitted.
    """
    blockers: List[str] = []

    # 1. Job Validation
    job = repo.get_job_by_id(job_id)
    if not job:
        return False, None, [f"Job '{job_id}' not found."]

    job_status = job.get("status")
    if job_status != "READY":
        # Allow if application already started from READY
        app = repo.get_application_by_job_id(job_id) if hasattr(repo, "get_application_by_job_id") else None
        if not (app and job_status in ("APPLICATION_STARTED", "WAITING_FOR_HUMAN")):
            blockers.append(f"Job is in state '{job_status}', expected 'READY'.")

    if job_status in ("SKIPPED", "REJECTED", "EXPIRED", "WITHDRAWN"):
        blockers.append(f"Job has been marked as {job_status}.")

    # 2. Safe URL Check
    apply_url = job.get("apply_url") or job.get("canonical_url")
    is_safe, url_err = is_safe_apply_url(apply_url)
    if not is_safe:
        blockers.append(f"Invalid application URL: {url_err}")

    # 3. Existing Submission Check
    if hasattr(repo, "get_application_by_job_id"):
        existing_app = repo.get_application_by_job_id(job_id)
        if existing_app:
            if existing_app.get("status") == "SUBMITTED_CONFIRMED" or existing_app.get("applied_at"):
                blockers.append("Application has already been human-confirmed as submitted.")

    # 4. Candidate Contact Details
    profile = repo.get_candidate_profile()
    if not profile:
        blockers.append("Candidate profile not found.")
    else:
        for field in ("full_name", "email", "phone", "location"):
            val = profile.get(field)
            if not val or not str(val).strip():
                blockers.append(f"Candidate profile is missing required contact field: '{field}'.")

    # 5. Latest Resume Version Verification
    latest_resume = repo.get_latest_resume_for_job(job_id)
    if not latest_resume:
        blockers.append(f"No resume versions found for job '{job_id}'.")
        return False, None, blockers

    if not latest_resume.get("approved_by_human"):
        blockers.append(
            f"Latest resume version (v{latest_resume.get('version_number', 1)}) has not been approved by a human."
        )

    for snapshot_field in ("profile_snapshot_id", "jd_snapshot_id"):
        if not latest_resume.get(snapshot_field):
            blockers.append(f"Approved resume is missing required lineage: '{snapshot_field}'.")

    analysis = repo.get_job_analysis(job_id)
    resume_analysis_id = latest_resume.get("analysis_id")
    if not resume_analysis_id:
        blockers.append("Approved resume is not bound to a validated job analysis version.")
    elif not analysis or str(analysis["id"]) != str(resume_analysis_id):
        blockers.append("Job analysis changed after resume generation; generate and approve a new resume.")

    candidate_snapshot = None
    if latest_resume.get("profile_snapshot_id"):
        candidate_snapshot = repo.get_candidate_snapshot(str(latest_resume["profile_snapshot_id"]))
        if not candidate_snapshot:
            blockers.append("Approved resume candidate snapshot was not found.")
        elif profile:
            current_profile_hash = hashlib.sha256(
                json.dumps(profile, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()
            if candidate_snapshot.get("snapshot_hash") != current_profile_hash:
                blockers.append("Candidate profile changed after resume approval; generate and approve a new resume.")

    # Check text content hash
    tailored_text = (latest_resume.get("tailored_text") or "").strip()
    computed_text_hash = hashlib.sha256(tailored_text.encode("utf-8")).hexdigest()
    if computed_text_hash != latest_resume.get("content_hash"):
        blockers.append("Resume content hash mismatch; text has been altered.")

    # Check PDF artifact path and digest
    pdf_path_str = latest_resume.get("pdf_path")
    if not pdf_path_str:
        blockers.append("Approved resume has no compiled PDF path.")
    else:
        pdf_path = Path(pdf_path_str).resolve()
        artifacts_root = ARTIFACTS_DIR.resolve()

        # Reject path traversal and symlinks
        try:
            pdf_path.relative_to(artifacts_root)
        except ValueError:
            blockers.append(f"PDF path '{pdf_path}' is outside authorized artifacts root.")

        if Path(pdf_path_str).is_symlink():
            blockers.append(f"PDF path '{pdf_path_str}' is a symlink; symlinks are prohibited.")

        if not pdf_path.is_file():
            blockers.append(f"Compiled PDF file not found at '{pdf_path}'.")
        else:
            file_bytes = pdf_path.read_bytes()
            computed_pdf_hash = hashlib.sha256(file_bytes).hexdigest()
            expected_pdf_hash = latest_resume.get("pdf_hash")
            if not expected_pdf_hash:
                blockers.append("Resume record missing pdf_hash; cannot verify artifact integrity.")
            elif computed_pdf_hash != expected_pdf_hash:
                blockers.append(f"Compiled PDF file digest mismatch ({computed_pdf_hash[:8]} vs {expected_pdf_hash[:8]}).")

    if blockers:
        return False, None, blockers

    package = ApplicationPackage(
        job_id=job_id,
        application_url=apply_url,
        ats_type=job.get("ats_type"),
        resume_version_id=str(latest_resume["id"]),
        version_number=latest_resume["version_number"],
        content_hash=latest_resume["content_hash"],
        pdf_path=str(pdf_path),
        pdf_hash=latest_resume["pdf_hash"],
        candidate_profile=profile,
        candidate_snapshot_id=str(latest_resume.get("profile_snapshot_id") or ""),
        jd_snapshot_id=str(latest_resume.get("jd_snapshot_id") or ""),
        analysis_id=str(resume_analysis_id) if resume_analysis_id else None
    )

    return True, package, []
