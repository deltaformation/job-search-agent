"""
Synthetic calibration corpus for candidate fit scoring.
Contains representative test cases:
1. strong_fit: Clear Senior TPM in Toronto/Canada with API/Platform/Cloud requirements and matching CAD salary.
2. weak_fit: Entry-level marketing/junior role with no overlap.
3. ambiguous_seniority: Product role with vague years requirement.
4. us_only_remote: Generic Remote title but JD states "Must be authorized to work in the US / US only".
5. absent_salary: Strong role with missing/undisclosed salary.
6. hourly_salary: Role with hourly USD compensation.
7. missing_evidence: Specialized ML/Hardware requirements with zero candidate evidence.
"""
from typing import Dict, Any, List

CALIBRATION_JOBS: Dict[str, Dict[str, Any]] = {
    "strong_fit": {
        "job_id": "00000000-0000-0000-0000-000000000001",
        "title": "Senior Technical Product Manager",
        "normalized_title": "Senior Technical Product Manager",
        "company": "CloudScale Systems",
        "location": "Toronto, ON, Canada",
        "remote_type": "hybrid",
        "description": "We are seeking a Senior Technical Product Manager with 5+ years experience building cloud platforms, REST APIs, and event-driven data streaming with Kafka and AWS. Must have experience leading engineering squads and scaling developer platforms.",
        "min_amount": 160000,
        "max_amount": 185000,
        "currency": "CAD"
    },
    "weak_fit": {
        "job_id": "00000000-0000-0000-0000-000000000002",
        "title": "Junior Marketing Associate",
        "normalized_title": "Marketing Associate",
        "company": "GrowthAds Agency",
        "location": "Toronto, ON, Canada",
        "remote_type": "onsite",
        "description": "Entry-level role for social media marketing, copy writing, and Google Adwords campaigns. Recent graduates welcome.",
        "min_amount": 45000,
        "max_amount": 55000,
        "currency": "CAD"
    },
    "ambiguous_seniority": {
        "job_id": "00000000-0000-0000-0000-000000000003",
        "title": "Product Manager",
        "normalized_title": "Product Manager",
        "company": "Innovate Labs",
        "location": "Remote Canada",
        "remote_type": "remote",
        "description": "Looking for an energetic Product Manager to help shape our SaaS product. Broad PM responsibilities with modern agile practices.",
        "min_amount": None,
        "max_amount": None,
        "currency": "CAD"
    },
    "us_only_remote": {
        "job_id": "00000000-0000-0000-0000-000000000004",
        "title": "Senior Technical Product Manager",
        "normalized_title": "Senior Technical Product Manager",
        "company": "FinTech US Corp",
        "location": "Remote",
        "remote_type": "remote",
        "description": "Exciting remote Senior TPM role in cloud payments and APIs. Important: Must be authorized to work in the US without sponsorship. US only.",
        "min_amount": 170000,
        "max_amount": 190000,
        "currency": "USD"
    },
    "absent_salary": {
        "job_id": "00000000-0000-0000-0000-000000000005",
        "title": "Senior Product Manager - Platform",
        "normalized_title": "Senior Product Manager",
        "company": "Enterprise Infra Ltd",
        "location": "Toronto, ON, Canada",
        "remote_type": "remote",
        "description": "Senior PM role leading enterprise infrastructure and data pipelines with PostgreSQL and Kubernetes. Compensation commensurate with experience.",
        "min_amount": None,
        "max_amount": None,
        "currency": "CAD"
    },
    "hourly_salary": {
        "job_id": "00000000-0000-0000-0000-000000000006",
        "title": "Technical Product Manager - Contract",
        "normalized_title": "Technical Product Manager",
        "company": "Consulting Group",
        "location": "Ontario, Canada",
        "remote_type": "hybrid",
        "description": "Contract technical PM role building developer tools and APIs.",
        "min_amount": 75,
        "max_amount": 90,
        "currency": "USD"
    },
    "missing_evidence": {
        "job_id": "00000000-0000-0000-0000-000000000007",
        "title": "Senior Hardware Product Manager",
        "normalized_title": "Senior Product Manager",
        "company": "Quantum Devices Inc",
        "location": "Toronto, ON, Canada",
        "remote_type": "onsite",
        "description": "Seeking Senior PM with deep expertise in embedded systems, FPGA firmware, semiconductor manufacturing, and cleanroom fabrication. 8+ years hardware engineering required.",
        "min_amount": 160000,
        "max_amount": 180000,
        "currency": "CAD"
    }
}
