import os
import shutil
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from jinja2 import Environment, select_autoescape
import pypdf

CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ARTIFACTS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "artifacts" / "resumes"

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page {
    size: letter;
    margin: 0.6in;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111827;
    line-height: 1.45;
    font-size: 10.5pt;
    margin: 0;
    padding: 0;
  }
  .header {
    text-align: center;
    border-bottom: 2px solid #1f2937;
    padding-bottom: 6px;
    margin-bottom: 12px;
  }
  .header h1 {
    margin: 0;
    font-size: 19pt;
    letter-spacing: 0.5px;
    color: #111827;
    text-transform: uppercase;
  }
  .header .headline {
    font-size: 11pt;
    font-weight: 600;
    color: #374151;
    margin: 3px 0;
  }
  .header .contact {
    font-size: 9.5pt;
    color: #4b5563;
  }
  .section {
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 11.5pt;
    font-weight: 700;
    text-transform: uppercase;
    border-bottom: 1px solid #d1d5db;
    padding-bottom: 2px;
    margin-bottom: 6px;
    color: #1f2937;
    letter-spacing: 0.4px;
  }
  .role-header {
    display: flex;
    justify-content: space-between;
    font-weight: 700;
    font-size: 10.5pt;
    color: #111827;
  }
  .company-line {
    display: flex;
    justify-content: space-between;
    font-style: italic;
    font-size: 10pt;
    color: #374151;
    margin-bottom: 4px;
  }
  ul {
    margin: 4px 0 8px 18px;
    padding: 0;
  }
  li {
    margin-bottom: 3.5px;
    font-size: 10pt;
  }
  .skills-list {
    font-size: 10pt;
    color: #1f2937;
  }
</style>
</head>
<body>

<div class="header">
  <h1>{{ profile.full_name }}</h1>
  <div class="headline">{{ profile.headline }}</div>
  <div class="contact">{{ profile.email }} | {{ profile.phone }} | {{ profile.location }}</div>
</div>

{% if summary_claims %}
<div class="section">
  <div class="section-title">Professional Summary</div>
  {% for claim in summary_claims %}
    <p style="margin: 0 0 6px 0; font-size: 10pt;">{{ claim.text }}</p>
  {% endfor %}
</div>
{% endif %}

<div class="section">
  <div class="section-title">Work Experience</div>
  {% for exp in experience_groups %}
    <div style="margin-bottom: 8px;">
      <div class="role-header">
        <span>{{ exp.role }}</span>
        <span>{{ exp.dates }}</span>
      </div>
      <div class="company-line">
        <span>{{ exp.company }}</span>
        <span>{{ exp.location }}</span>
      </div>
      <ul>
        {% for claim in exp.claims %}
          <li>{{ claim.text }}</li>
        {% endfor %}
      </ul>
    </div>
  {% endfor %}
</div>

<div class="section">
  <div class="section-title">Technical &amp; Product Skills</div>
  <div class="skills-list">
    <strong>Core Competencies:</strong> {{ verified_skills | join(', ') }}
  </div>
</div>

<div class="section">
  <div class="section-title">Education</div>
  {% for edu in education %}
    <div style="display: flex; justify-content: space-between; font-size: 10pt;">
      <span><strong>{{ edu.degree }}</strong> in {{ edu.field_of_study }}</span>
      <span>{{ edu.institution }}</span>
    </div>
  {% endfor %}
</div>

</body>
</html>
"""

class DocumentRenderer:
    def __init__(self, artifacts_dir: Optional[Path] = None):
        self.artifacts_dir = artifacts_dir or ARTIFACTS_DIR
        self.jinja_env = Environment(autoescape=select_autoescape(["html", "xml"]))

    def render_resume_to_html(
        self,
        profile: Dict[str, Any],
        structured_resume: Dict[str, Any]
    ) -> str:
        """
        Renders structured claims and canonical profile into ATS-friendly HTML.
        Canonical identity fields are injected directly from profile and autoescaped.
        """
        template = self.jinja_env.from_string(HTML_TEMPLATE)

        claims = structured_resume.get("claims", [])
        summary_claims = [c for c in claims if c.get("section") == "summary"]
        exp_claims = [c for c in claims if c.get("section") == "experience"]

        # Group experience claims by company & role
        grouped_exp = []
        company_seen = {}
        for ec in exp_claims:
            comp = ec.get("company", "Company")
            if comp not in company_seen:
                dates = ec.get("dates", {})
                date_str = f"{dates.get('start', '')} - {dates.get('end', 'Present')}"
                # Find matching work experience record for location
                loc = "Toronto, ON"
                for we in profile.get("work_experience", []):
                    if we["company"].lower() == comp.lower():
                        loc = we.get("location", loc)
                        break

                group = {
                    "company": comp,
                    "role": ec.get("role", "Role"),
                    "dates": date_str,
                    "location": loc,
                    "claims": []
                }
                company_seen[comp] = group
                grouped_exp.append(group)
            company_seen[comp]["claims"].append(ec)

        skill_names = [s["name"] for s in profile.get("skills", []) if s.get("verified", True)]

        rendered_html = template.render(
            profile=profile,
            summary_claims=summary_claims,
            experience_groups=grouped_exp,
            verified_skills=skill_names,
            education=profile.get("education", [])
        )
        return rendered_html

    def compile_html_to_pdf(
        self,
        html_content: str,
        job_id: str,
        version_number: int,
        content_hash: str
    ) -> Tuple[str, str, int]:
        """
        Compiles HTML to PDF via sandboxed headless Chrome.
        Validates page budget (<= 2 pages) and text extractability via pypdf.
        Returns (html_file_path, pdf_file_path, page_count).
        """
        job_dir = self.artifacts_dir / str(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)

        hash_short = content_hash[:8]
        html_filename = f"v{version_number}_{hash_short}.html"
        pdf_filename = f"v{version_number}_{hash_short}.pdf"

        html_path = job_dir / html_filename
        pdf_path = job_dir / pdf_filename
        tmp_pdf_path = job_dir / f"tmp_{pdf_filename}"

        # 1. Write HTML
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)

        # 2. Compile PDF via sandboxed headless Chrome
        cmd = [
            CHROME_BIN,
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--disable-remote-fonts",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-extensions",
            f"--print-to-pdf={str(tmp_pdf_path)}",
            str(html_path)
        ]

        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if res.returncode != 0 or not tmp_pdf_path.exists():
            if tmp_pdf_path.exists():
                tmp_pdf_path.unlink()
            raise RuntimeError(f"Chrome PDF compilation failed: {res.stderr}")

        # 3. Validate PDF with pypdf
        reader = pypdf.PdfReader(str(tmp_pdf_path))
        page_count = len(reader.pages)

        # Check page budget (<= 2 pages per user preference)
        if page_count > 2:
            tmp_pdf_path.unlink()
            raise ValueError(f"Rendered resume exceeds 2-page budget: {page_count} pages detected.")

        # Extract text and check text density
        full_text = ""
        for page in reader.pages:
            full_text += page.extract_text() or ""

        if len(full_text.strip()) < 300:
            tmp_pdf_path.unlink()
            raise ValueError(f"Rendered PDF contains insufficient extractable text: {len(full_text)} chars.")

        # Atomic move to final versioned path
        shutil.move(str(tmp_pdf_path), str(pdf_path))

        return str(html_path), str(pdf_path), page_count
