import pytest
import pypdf
from pathlib import Path
from services.documents.tailor import ResumeTailor
from services.documents.renderer import DocumentRenderer
from services.memory.repository import JobRepository

def test_tailor_draft_generation(candidate_data):
    tailor = ResumeTailor(candidate_data)
    job = {
        "job_id": "00000000-0000-0000-0000-000000000001",
        "title": "Senior Technical Product Manager",
        "company": "Cloud Innovators",
        "description": "Looking for a Senior Technical Product Manager with AWS API experience."
    }
    draft = tailor.generate_tailored_draft(job)
    assert len(draft["claims"]) >= 3
    
    # Check that experience claims map to verified facts
    exp_claims = [c for c in draft["claims"] if c["section"] == "experience"]
    for ec in exp_claims:
        assert len(ec["fact_ids"]) >= 1
        assert ec["generation_strategy"] == "verbatim"

    plain = tailor.generate_plain_text(draft)
    assert "Senior Technical Product Manager" in plain
    assert "FinTech Cloud Solutions" in plain

def test_document_rendering_and_pdf_compilation(candidate_data, tmp_path):
    tailor = ResumeTailor(candidate_data)
    job = {
        "job_id": "00000000-0000-0000-0000-000000000001",
        "title": "Senior Technical Product Manager",
        "company": "Cloud Innovators",
        "description": "AWS API platform leadership."
    }
    draft = tailor.generate_tailored_draft(job)
    plain_text = tailor.generate_plain_text(draft)
    content_hash = tailor.compute_content_hash(plain_text)

    renderer = DocumentRenderer(artifacts_dir=tmp_path)
    html = renderer.render_resume_to_html(candidate_data, draft)
    assert "Mouad Atfi" in html
    assert "Professional Summary" in html

    # Compile PDF via the resolved dedicated headless browser.
    html_path, pdf_path, page_count = renderer.compile_html_to_pdf(
        html_content=html,
        job_id=job["job_id"],
        version_number=1,
        content_hash=content_hash
    )
    assert Path(pdf_path).exists()
    assert 1 <= page_count <= 2

    # Verify text extraction with pypdf
    reader = pypdf.PdfReader(pdf_path)
    full_text = "".join(p.extract_text() for p in reader.pages)
    assert "MOUAD ATFI" in full_text
    assert "WORK EXPERIENCE" in full_text
    assert "42%" in full_text

def test_reproducible_diff():
    tailor = ResumeTailor({
        "full_name": "Mouad Atfi",
        "headline": "Product Lead",
        "email": "m@example.com",
        "phone": "123",
        "location": "Toronto",
        "skills": [],
        "education": []
    })
    base = "MOUAD ATFI\nRole A\n• Fact 1\n• Fact 2\n"
    tailored = "MOUAD ATFI\nRole A\n• Fact 2 (Prioritized)\n• Fact 1\n"
    diff = tailor.compute_diff(base, tailored)
    assert "+• Fact 2 (Prioritized)" in diff
    assert "-• Fact 2" in diff
