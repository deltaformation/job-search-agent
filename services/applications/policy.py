import re
from enum import Enum
from typing import List, Optional, Tuple

class FieldRiskClass(str, Enum):
    SAFE = "safe"
    HUMAN_REVIEW = "human_review"
    PROHIBITED = "prohibited"
    UNKNOWN = "unknown"

class FieldDecision(str, Enum):
    FILL = "fill"
    UPLOAD = "upload"
    ASK_HUMAN = "ask_human"
    LEAVE_BLANK = "leave_blank"

class SourceType(str, Enum):
    CANDIDATE_PROFILE = "candidate_profile"
    WORK_EXPERIENCE = "work_experience"
    EDUCATION = "education"
    CREDENTIAL = "credential"
    STANDARD_ANSWER = "standard_answer"
    RESUME_ARTIFACT = "resume_artifact"
    HUMAN = "human"

# 1. Prohibited Keywords (Demographics, Legal Attestation, Credentials, Submit)
PROHIBITED_PATTERNS = [
    # EEO / Demographics
    r"\brace\b", r"\bethnicity\b", r"\bgender\b", r"\bsex\b", r"\bsexual orientation\b",
    r"\bdisability\b", r"\bveteran\b", r"\breligion\b", r"\bdate of birth\b", r"\bbirthdate\b",
    r"\bage\b", r"\bpronoun", r"\bhispanic\b", r"\blatino\b", r"\bindigenous\b",
    r"\bmarital status\b",
    # Account & Security
    r"\bpassword\b", r"\bpasscode\b", r"\bmfa\b", r"\botp\b", r"\bpin\b",
    r"\bcaptcha\b", r"\bsecurity question\b", r"\bcredit card\b", r"\bbank account\b",
    r"\bsocial security\b", r"\bssn\b", r"\bsin\b", r"\btax id\b",
    # Legal Signatures & Attestations
    r"\bsignature\b", r"\bi certify\b", r"\bi agree\b", r"\bi attest\b",
    r"\bconsent to\b", r"\bbackground check consent\b", r"\bterms of service\b",
    r"\bunder penalty of perjury\b",
    # Final Action Buttons
    r"\bsubmit application\b", r"\bsend application\b", r"\bapply now\b", r"\bcomplete application\b"
]

# 2. Human Review Keywords (Work Auth, Compensation, Subjective, Freeform)
HUMAN_REVIEW_PATTERNS = [
    # Work Authorization & Legal Eligibility
    r"\bwork authoriz", r"\blegally authoriz", r"\bvisa\b", r"\bsponsorship\b",
    r"\bcitizen", r"\bpermanent resident", r"\bgreen card\b", r"\bsecurity clearance\b",
    r"\bexport control\b", r"\brelocation\b", r"\bwilling to relocate\b",
    r"\btravel\b", r"\bdriver'?s license\b", r"\bvalid license\b",
    # Compensation & Availability
    r"\bsalary\b", r"\bcompensation\b", r"\bpay expectation", r"\bdesired pay\b",
    r"\bhourly rate\b", r"\bexpected salary\b", r"\bnotice period\b", r"\bstart date\b",
    r"\bearliest start\b", r"\bavailability\b", r"\bnon-compete\b", r"\bconflict of interest\b",
    # Subjective & Interpretation Questions
    r"\bwhy do you want\b", r"\bwhy us\b", r"\bwhy are you interested\b",
    r"\bcover letter\b", r"\bletter of interest\b", r"\badditional info",
    r"\byears of experience\b", r"\brate your\b", r"\bhow many years\b"
]

# 3. Safe Factual Patterns
SAFE_PATTERNS = {
    "first_name": [r"\bfirst[\s_]?name\b", r"\bgiven[\s_]?name\b", r"\bforename\b"],
    "last_name": [r"\blast[\s_]?name\b", r"\bsurname\b", r"\bfamily[\s_]?name\b"],
    "full_name": [r"\bfull[\s_]?name\b", r"\byour[\s_]?name\b", r"^name$"],
    "email": [r"\bemail\b", r"\be-mail\b"],
    "phone": [r"\bphone\b", r"\bmobile\b", r"\bcell\b", r"\btelephone\b"],
    "location": [r"\bcity\b", r"\blocation\b", r"\baddress\b", r"\bpostal\b", r"\bzip\b", r"\bprovince\b", r"\bstate\b", r"\bcountry\b"],
    "linkedin": [r"\blinkedin\b"],
    "github": [r"\bgithub\b"],
    "portfolio": [r"\bportfolio\b", r"\bwebsite\b", r"\bpersonal website\b", r"\bblog\b"],
    "resume_upload": [r"\bresume\b", r"\bcv\b", r"\bcurriculum vitae\b"]
}

def classify_field(
    label: str,
    control_type: str = "text",
    name: Optional[str] = None,
    options: Optional[List[str]] = None
) -> Tuple[FieldRiskClass, Optional[str]]:
    """
    Deterministically classifies form fields into SAFE, HUMAN_REVIEW, PROHIBITED, or UNKNOWN.
    Returns (risk_class, matched_subfield_key).
    """
    text_to_check = f"{label} {name or ''}".lower().strip()

    # 1. Prohibited Check (Highest Priority)
    for pattern in PROHIBITED_PATTERNS:
        if re.search(pattern, text_to_check, re.IGNORECASE):
            return FieldRiskClass.PROHIBITED, None

    # Check options for prohibited/demographic dropdowns
    if options:
        opt_text = " ".join(str(o).lower() for o in options)
        for pattern in [r"\bmale\b", r"\bfemale\b", r"\bhispanic\b", r"\bveteran status\b", r"\bdisability status\b"]:
            if re.search(pattern, opt_text, re.IGNORECASE):
                return FieldRiskClass.PROHIBITED, None

    # 2. Human Review Check
    for pattern in HUMAN_REVIEW_PATTERNS:
        if re.search(pattern, text_to_check, re.IGNORECASE):
            return FieldRiskClass.HUMAN_REVIEW, None

    # 3. Safe Factual Check
    # Check if it's a resume file upload
    if control_type == "file" or "file" in control_type.lower():
        for pat in SAFE_PATTERNS["resume_upload"]:
            if re.search(pat, text_to_check, re.IGNORECASE):
                return FieldRiskClass.SAFE, "resume_upload"

    for subfield, patterns in SAFE_PATTERNS.items():
        if subfield == "resume_upload":
            continue
        for pat in patterns:
            if re.search(pat, text_to_check, re.IGNORECASE):
                return FieldRiskClass.SAFE, subfield

    # 4. Fallback Default
    return FieldRiskClass.UNKNOWN, None

def is_decision_allowed(risk_class: FieldRiskClass, decision: FieldDecision) -> bool:
    """
    Validates whether a proposed action decision is allowed for a given risk class:
    - SAFE: fill, upload, leave_blank, ask_human
    - HUMAN_REVIEW: ask_human, leave_blank (FILL and UPLOAD forbidden)
    - PROHIBITED: leave_blank (FILL, UPLOAD, ASK_HUMAN forbidden for auto-fill)
    - UNKNOWN: ask_human, leave_blank
    """
    if risk_class == FieldRiskClass.SAFE:
        return True

    if risk_class in (FieldRiskClass.HUMAN_REVIEW, FieldRiskClass.UNKNOWN):
        return decision in (FieldDecision.ASK_HUMAN, FieldDecision.LEAVE_BLANK)

    if risk_class == FieldRiskClass.PROHIBITED:
        return decision == FieldDecision.LEAVE_BLANK

    return False

def reconcile_risk(
    deterministic_risk: FieldRiskClass,
    proposed_risk: FieldRiskClass
) -> Tuple[FieldRiskClass, bool]:
    """
    Enforces the escalation-only invariant:
    The AI proposal can escalate risk (e.g. from SAFE to HUMAN_REVIEW),
    but cannot downgrade (e.g. PROHIBITED -> SAFE or HUMAN_REVIEW -> SAFE is rejected).
    Returns (final_risk, is_valid).
    """
    hierarchy = {
        FieldRiskClass.SAFE: 1,
        FieldRiskClass.UNKNOWN: 2,
        FieldRiskClass.HUMAN_REVIEW: 2,
        FieldRiskClass.PROHIBITED: 3
    }

    det_level = hierarchy[deterministic_risk]
    prop_level = hierarchy[proposed_risk]

    # Prohibited can NEVER be downgraded
    if deterministic_risk == FieldRiskClass.PROHIBITED and proposed_risk != FieldRiskClass.PROHIBITED:
        return FieldRiskClass.PROHIBITED, False

    # Human Review can NEVER be downgraded to SAFE
    if deterministic_risk in (FieldRiskClass.HUMAN_REVIEW, FieldRiskClass.UNKNOWN) and proposed_risk == FieldRiskClass.SAFE:
        return deterministic_risk, False

    # Escalation is allowed
    if prop_level > det_level:
        return proposed_risk, True

    return deterministic_risk, True
