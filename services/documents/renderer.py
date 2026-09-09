import tempfile
import os
import signal
import time
import re
from uuid import UUID
from html.parser import HTMLParser
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from services.documents.browser import resolve_headless_browser
from services.documents.validator import ClaimValidator, ProvenanceValidationError
from jinja2 import Environment, select_autoescape
import pypdf

ARTIFACTS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "artifacts" / "resumes"


def terminate_browser_process(process: subprocess.Popen[bytes]) -> None:
    """Stop a renderer process and fall back when process-group signals are denied."""
    if process.poll() is not None:
        process.wait()
        return

    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    except PermissionError:
        try:
            process.terminate()
        except ProcessLookupError:
            process.wait()
            return

    try:
        process.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        process.wait()
        return
    except PermissionError:
        process.kill()
    process.wait()

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'none'; img-src 'none';">
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
    break-after: avoid;
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
    break-inside: avoid;
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

class BodyTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_body = False
        self.fragments: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag == "body":
            self.in_body = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "body":
            self.in_body = False

    def handle_data(self, data: str) -> None:
        if self.in_body and data.strip():
            self.fragments.append(data.strip())


class DocumentRenderer:
    def __init__(
        self,
        artifacts_dir: Optional[Path] = None,
        browser_path: Optional[str] = None,
    ) -> None:
        self.artifacts_dir = artifacts_dir or ARTIFACTS_DIR
        self.browser_path = browser_path
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
        valid, report = ClaimValidator(profile).validate_draft(structured_resume)
        if not valid:
            raise ProvenanceValidationError("invalid_draft", str(report["errors"]))
        template = self.jinja_env.from_string(HTML_TEMPLATE)

        claims = structured_resume.get("claims", [])
        summary_claims = [c for c in claims if c.get("section") == "summary"]
        exp_claims = [c for c in claims if c.get("section") == "experience"]

        # Group experience claims by company & role
        grouped_exp = []
        company_seen = {}
        for ec in exp_claims:
            comp = ec["entity_id"]
            if comp not in company_seen:
                dates = ec.get("dates", {})
                date_str = f"{dates.get('start', '')} - {dates.get('end', 'Present')}"
                # Find matching work experience record for location
                loc = ""
                for we in profile.get("work_experience", []):
                    if str(we["id"]) == comp:
                        loc = we.get("location", loc)
                        break

                group = {
                    "company": ec["company"],
                    "role": ec.get("role", "Role"),
                    "dates": date_str,
                    "location": loc,
                    "claims": []
                }
                company_seen[comp] = group
                grouped_exp.append(group)
            company_seen[comp]["claims"].append(ec)

        skill_names = [s["name"] for s in profile.get("skills", []) if s.get("verified") is True]

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
        Compiles HTML to PDF via an isolated headless Chromium runtime.
        Validates page budget (<= 2 pages) and text extractability via pypdf.
        Returns (html_file_path, pdf_file_path, page_count).
        """
        job_key = str(UUID(str(job_id)))
        if version_number < 1 or not re.fullmatch(r"[a-f0-9]{64}", content_hash):
            raise ValueError("Invalid version number or content hash.")
        job_dir = self.artifacts_dir.resolve() / job_key
        job_dir.mkdir(parents=True, exist_ok=True)
        stem = f"v{version_number}_{content_hash[:8]}"
        html_path = job_dir / f"{stem}.html"
        pdf_path = job_dir / f"{stem}.pdf"
        # Exclusive reservation prevents concurrent retries overwriting a version.
        lock = job_dir / f".{stem}.lock"
        with lock.open("x"):
            published = []
            try:
                if html_path.exists() or pdf_path.exists():
                    raise FileExistsError("Version artifacts already exist; generate a new version.")
                with tempfile.TemporaryDirectory(dir=job_dir, prefix="render_") as temp, tempfile.TemporaryDirectory(prefix="job-chrome-", dir="/tmp") as chrome_profile:
                    temp_dir = Path(temp)
                    source = temp_dir / "resume.html"
                    target = temp_dir / "resume.pdf"
                    source.write_text(html_content, encoding="utf-8")
                    browser_path = resolve_headless_browser(
                        [self.browser_path] if self.browser_path else None
                    )
                    cmd = [browser_path, "--headless", "--no-first-run", "--use-mock-keychain", "--password-store=basic", "--no-default-browser-check", "--disable-search-engine-choice-screen", "--disable-gpu", "--no-pdf-header-footer",
                           "--disable-remote-fonts", "--disable-background-networking", "--disable-sync",
                           "--disable-extensions", "--host-resolver-rules=MAP * ~NOTFOUND",
                           f"--user-data-dir={chrome_profile}", f"--print-to-pdf={target}", source.as_uri()]
                    # Chrome can finish printing yet hang during shutdown on macOS.
                    # Wait for a complete PDF, then terminate only our process group.
                    with tempfile.TemporaryFile() as log:
                        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
                        try:
                            deadline = time.monotonic() + 30
                            complete = False
                            while time.monotonic() < deadline:
                                if target.exists():
                                    try:
                                        candidate = pypdf.PdfReader(str(target), strict=True)
                                        complete = bool(candidate.pages)
                                    except Exception:
                                        complete = False
                                if complete or process.poll() is not None:
                                    break
                                time.sleep(0.1)
                            if not complete:
                                exit_code = process.poll()
                                if exit_code is not None:
                                    raise RuntimeError(
                                        "Headless browser exited with status "
                                        f"{exit_code} before producing a complete PDF."
                                    )
                                raise RuntimeError(
                                    "Headless browser did not produce a complete PDF within the rendering deadline."
                                )
                        finally:
                            terminate_browser_process(process)

                    reader = pypdf.PdfReader(str(target))
                    page_count = len(reader.pages)
                    if not 1 <= page_count <= 2:
                        raise ValueError(f"Rendered resume exceeds page budget: {page_count} pages.")
                    text = "".join(page.extract_text() or "" for page in reader.pages)
                    if len(text.strip()) < 300:
                        raise ValueError("Rendered PDF contains insufficient extractable text.")
                    parser = BodyTextParser()
                    parser.feed(html_content)
                    extracted = re.sub(r"\s+", "", text).casefold()
                    for fragment in parser.fragments:
                        if re.sub(r"\s+", "", fragment).casefold() not in extracted:
                            raise ValueError("Rendered PDF is missing expected resume text.")
                    # Publish only verified artifacts, without replacing existing files.
                    for src, dest in ((source, html_path), (target, pdf_path)):
                        with dest.open("xb") as output:
                            published.append(dest)
                            output.write(src.read_bytes())
                return str(html_path), str(pdf_path), page_count
            except Exception:
                for path in published:
                    path.unlink(missing_ok=True)
                raise
            finally:
                lock.unlink(missing_ok=True)
