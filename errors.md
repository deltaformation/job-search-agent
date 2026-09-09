# System Diagnostic & Error Report (`errors.md`)

This document details the issues, edge cases, and warnings identified during system verification, live discovery, and real resume ingestion, along with their root causes and proposed resolutions.

---

## 0. [OPERATIONAL] Escaped f-string in shell-embedded Python

### Summary
The candidate-profile diagnostic failed with `SyntaxError: f-string expression part cannot include a backslash`. The repository API was not involved; the quoting needed by the shell placed backslashes inside an f-string expression.

### Resolution
Use the checked-in diagnostic instead of multiline `python -c`:

```bash
.venv/bin/python scripts/show_candidate_profile.py
```

- **Status**: **RESOLVED**. The script supports human-readable output, `--json`, and `--fact-limit`.

---

## 1. [CRITICAL] Empty Job Descriptions for LinkedIn Scraped Postings

### Summary
When running live discovery across LinkedIn and Indeed, all Indeed postings were ingested with full job descriptions (2,000–9,000 characters), but **100% of LinkedIn postings were stored with empty descriptions (`description = NULL` or length 0)**.

### Root Cause
In `services/discovery/scraper.py`, the call to JobSpy's `scrape_jobs()` uses default arguments:
```python
df = scrape_jobs(
    site_name=[site],
    search_term=search_term,
    location=location,
    country_indeed=country,
    results_wanted=results_wanted,
    hours_old=int(math.ceil(hours_old))
)
```
In `python-jobspy`, the parameter `linkedin_fetch_description` defaults to **`False`**. Consequently, JobSpy only parses the summary cards on LinkedIn's search results page without visiting individual posting pages to fetch the full text.

### Impact
Without full job descriptions:
- **Fit Scoring**: Cannot extract JD requirements or compute evidence matches; jobs receive generic or deflated scores.
- **Resume Tailoring**: Cannot align verified candidate `fact_id`s to specific JD requirements.

### Solution (Resolved)
In `services/discovery/scraper.py`, description fetching is enabled only for LinkedIn:
```python
df = scrape_jobs(
    site_name=[site],
    search_term=search_term,
    location=location,
    country_indeed=country,
    results_wanted=results_wanted,
    hours_old=int(math.ceil(hours_old)),
    linkedin_fetch_description=site.strip().lower() == "linkedin"
)
```
Rows that still arrive without a description are rejected and reported instead of being persisted and scored as usable jobs.

- **Status**: **RESOLVED** in `services/discovery/scraper.py`.

---

## 2. [OPERATIONAL] LinkedIn Job Interstitial Navigation in Browser Copilot

### Summary
Postings discovered from LinkedIn have `apply_url` set to `https://www.linkedin.com/jobs/view/<ID>`.

### Impact
When Antigravity opens this URL in a headed browser with `@playwright/mcp@0.0.80`, LinkedIn may present:
1. An unauthenticated guest banner.
2. An "Easy Apply" modal (if applied via LinkedIn).
3. An "Apply on company website" button that redirects to Greenhouse, Lever, Workday, or Taleo.

### Solution
- For LinkedIn postings with external ATS links, the copilot flow should:
  1. Navigate to the LinkedIn URL.
  2. Click the external "Apply on company website" link to resolve the true destination ATS URL.
  3. Record the form snapshot on the actual ATS destination page.
- Alternatively, prioritize postings from direct ATS job feeds or Indeed which frequently provide direct ATS links (`job_url_direct`).

Recognized redirect validation now covers Greenhouse, Lever, Ashby, Workday, Taleo, iCIMS, and SmartRecruiters. Authentication, Easy Apply, CAPTCHA, and account challenges remain human-only.

- **Status**: **RESOLVED** in the application page validator and Playwright workflow.

---

## 3. [ENVIRONMENT] Local Git Author Email Fallback Warning

### Summary
When committing changes locally, Git emitted the following warning:
```
Committer: Mouad Atfi <mouadatfi@Mouads-Air.ts.net lan>
Your name and email address were configured automatically based
on your username and hostname. Please check that they are accurate.
```

### Impact
Commits on GitHub display an unverified local hostname committer (`mouadatfi@Mouads-Air.ts.net lan`) rather than your linked GitHub account email.

### Solution
Run the following commands in the workspace:
```bash
git config user.name "Mouad Atfi"
git config user.email "ma170789@gmail.com"
```

- **Status**: **RESOLVED** in the repository-local Git configuration.

---

## 4. [DATA CONSISTENCY] Candidate Seed (`001_candidate_seed.sql`) vs Live Memory

### Summary
The live PostgreSQL database was cleanly populated with the reviewed resume data using `scripts/load_candidate_profile.py`. However, `db/seeds/001_candidate_seed.sql` still contains a synthetic profile placeholder.

### Impact
- Live operations (discovery, tailoring, applications) use the live database and work with your real profile.
- Isolated test schemas (`tests/conftest.py`) load `001_candidate_seed.sql` during pytest runs.

### Resolution
Fresh initialization no longer loads synthetic career data by default. The existing seed is explicitly labeled as disposable test/demo data. Canonical profile replacement requires the human-operated `scripts/load_candidate_profile.py --confirm-replace` command, and work-authorization answers are marked sensitive and human-reviewed.

- **Status**: **RESOLVED** without copying personal career facts into a default seed path.

---

## 5. [PREFERENCE TUNING] Location Filtering Granularity

### Summary
During the morning discovery scan for "Lead Product Manager" in Ontario, some non-product or regional manufacturing roles were ingested (e.g. *Regional Sourcing Manager*, *Team Lead*).

### Impact
Heuristic title matching currently penalizes non-PM roles during fit scoring (scores < 75), but they still consume discovery slots.

### Resolution
`config/jobs.yaml` now has a dedicated title filter requiring `product` and excluding `sourcing` and `procurement`. Filtered results are counted separately and do not consume persistence or scoring work. The deduplication similarity threshold remains dedicated to duplicate detection.

- **Status**: **RESOLVED**.

---

## 6. [CRITICAL] Plaintext credentials in user-level MCP configuration

### Summary
The user-level Gemini MCP configuration contains live GitHub and Cloudflare credentials directly in server environment blocks. The credential values are not stored in this repository and are intentionally omitted from this report.

### Resolution
Rotate both credentials in their provider consoles, then configure the MCP servers through an environment or secret-storage mechanism supported by the local harness. Confirm that the replacement GitHub token has only the repository permissions it needs and that the Cloudflare token is scoped to the required account and resources.

- **Status**: **USER ACTION REQUIRED**. Repository secret scanning found no copies of these credentials.

---

## Current Health Status
- **Automated Tests**: 15 isolated discovery, configuration, and diagnostic checks pass; the database-backed suite was intentionally not rerun.
- **PostgreSQL Database**: Canonical profile was reported loaded; migration ledger status must be checked outside the restricted sandbox.
- **Playwright MCP**: Pinned configuration entry is present; live tool startup remains a per-session runtime check.
- **Git State**: The diagnostic fixes are ready for local commit after review.
