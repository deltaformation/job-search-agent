# Operations & Runbook

This runbook describes how to operate, monitor, migrate, and troubleshoot the Job Search Operating System.

---

## 1. Environment Verification

Run non-mutating diagnostics to verify Python runtime, PostgreSQL 16 connection, headless browser, and required Python packages:

```bash
.venv/bin/python scripts/check_environment.py
```

Expected output:
- Python 3.11+
- PostgreSQL 16.x connected (`job_system`)
- Google Chrome available
- Core modules: `psycopg`, `pandas`, `python-jobspy`, `fastmcp`, `pydantic`, `pyyaml`, `pypdf`, `jinja2`

---

## 2. Database & Schema Migrations

The database migration subsystem uses an advisory-locked ledger (`schema_migrations`) with SHA256 checksum validation to ensure consistent schema evolution across installations.

```bash
# View migration ledger and status of all migrations
.venv/bin/python scripts/migrate.py --status

# Apply pending forward migrations
.venv/bin/python scripts/migrate.py --migrate

# Reconcile historical baseline migrations (001-003) on pre-existing databases
.venv/bin/python scripts/migrate.py --reconcile
```

> **Note**: Database upgrades never re-run candidate profile seeds (`db/seeds/001_candidate_seed.sql`). Seed operations are strictly guarded to preserve candidate modifications.

---

## 3. Discovery Operations

Discovery supports isolated multi-board scraping, row-level fault tolerance, 5-signal deduplication, and read-time freshness calculation.

### Discovery CLI Options (`scripts/run_discovery.py`)

| Flag | Description | Default |
|---|---|---|
| `--schedule <name>` | Load parameters from `config/schedule.yaml` (`morning_scan` / `evening_scan`) | Base config |
| `--roles <r1> <r2>` | Space-separated target job roles (quote roles containing spaces) | Config roles |
| `--locations <l1> <l2>` | Space-separated search locations | Config locations |
| `--sources <s1> <s2>` | Space-separated job boards (`indeed`, `linkedin`) | Enabled boards |
| `--max-results <N>` | Maximum results per board/query | Base limit |
| `--hours-old <N>` | Freshness filter cutoff in hours | Secondary window |
| `--smoke-test` | Fast bounded test (single query, limit 3) | `False` |
| `--dry-run` | Query and normalize without saving to PostgreSQL | `False` |

### Common CLI Invocations

```bash
# Bounded smoke test
.venv/bin/python scripts/run_discovery.py --smoke-test

# Dry-run smoke test (does not write to DB)
.venv/bin/python scripts/run_discovery.py --smoke-test --dry-run

# Run discovery with named morning schedule
.venv/bin/python scripts/run_discovery.py --schedule morning_scan

# Custom discovery run with overrides
.venv/bin/python scripts/run_discovery.py --roles "Technical Product Manager" --locations "Toronto, ON, Canada" --sources indeed --max-results 5
```

---

## 4. End-to-End Scheduled Pipeline

The scheduled runner executes discovery and reports jobs awaiting Antigravity analysis. It cannot perform Antigravity reasoning inside a Python process. Only jobs with a validated analysis and final score are shortlisted and acknowledged:

```bash
# Run scheduled morning scan
.venv/bin/python scripts/run_scheduled_scan.py --schedule morning_scan --limit 5

# Dry run with evening scan parameters
.venv/bin/python scripts/run_scheduled_scan.py --schedule evening_scan --limit 3 --dry-run
```

### 6-Stage Pipeline Sequence
1. **Audited Run Initialization**: Obtains schedule lock (`schedule_locks`) to prevent overlapping runs.
2. **Isolated Multi-Board Discovery**: Ingests fresh postings; records observations per board and query in `discovery_observations`.
3. **Pending Analysis Reporting**: Reports jobs that Antigravity must retrieve and analyze through MCP.
4. **Final-score Filtering**: Excludes provisional and analysis-pending jobs from the shortlist.
5. **Shortlist Queue & Reservation**: Selects eligible candidates and reserves a delivery batch.
6. **Delivery Acknowledgement**: Acknowledges only the successfully reserved jobs after printing the report.

`--dry-run` performs queries and normalization without writing runs, observations, jobs, scores, reservations, or delivery acknowledgements.

The YAML cron expressions define intended run times; they do not register an operating-system scheduler. Invoke the runner from Antigravity or install it in your preferred scheduler when you are ready to automate it.

---

## 5. Workflow State Model vs. Fit Assessment Status

To prevent race conditions and preserve user progress, the system enforces a strict architectural separation between **Fit Assessment Status** and **Application Workflow State**.

### Fit Assessment Status (`jobs.assessment_status`)
Tracks the depth of AI fit analysis:
- `UNASSESSED`: Job newly ingested; no score computed.
- `PROVISIONALLY_SCORED`: Job scored using heuristic/keyword overlap; pending Antigravity structured requirement analysis.
- `SCORED`: Comprehensive Antigravity requirement analysis completed and validated.

### Application Workflow State (`jobs.status`)
Tracks the human/application pipeline progression:
- `NEW`: Ingested job before scoring or qualification.
- `QUALIFIED`: Scored job meeting qualification threshold (overall score >= 85).
- `SHORTLISTED`: Job placed on candidate review shortlist.
- `REVIEWED`: Job inspected by human reviewer.
- `TAILORING`: Job selected for resume tailoring and evidence alignment.
- `READY`: Resume tailored and approved by human; ready for application preparation.
- `APPLICATION_STARTED`: Application package prepared.
- `WAITING_FOR_HUMAN`: Awaiting human review/input for disclosures or submission.
- `SUBMITTED`: Application submitted (requires explicit human confirmation).
- `SCREEN` / `INTERVIEW` / `FINAL` / `OFFER`: Post-submission interview stages.
- `SKIPPED`: Job passed over by user with recorded reason.
- `REJECTED`: Application rejected by company.
- `EXPIRED`: Job closed or expired on source board.
- `WITHDRAWN`: Application withdrawn by candidate.

### Workflow State Preconditions & Invariants:
1. **Rescoring Isolation**: Re-evaluating job fit or running discovery updates `assessment_status` and score records, but **never overwrites active application states** (`TAILORING`, `READY`, `APPLICATION_STARTED`, `WAITING_FOR_HUMAN`, `SUBMITTED`, etc.).
2. **`READY` Precondition**: A job cannot transition to `READY` without an existing approved resume version in `resume_versions` with `approved = TRUE`.
3. **`SUBMITTED` Precondition**: Transition to `SUBMITTED` requires `human_confirmed=True`. Autonomous agents are strictly forbidden from asserting application submission.

---

## 6. Review Queue & Shortlist Delivery

The shortlist API avoids double-delivery and race conditions using time-limited delivery reservations:

```python
from services.memory.repository import JobRepository
repo = JobRepository()

# 1. Query candidate shortlist
shortlist = repo.get_shortlist(limit=5, min_score=85.0)

# 2. Reserve candidate batch (15 min TTL)
job_ids = [j["job_id"] for j in shortlist]
batch_id = "batch-uuid"
reserved_job_ids = repo.reserve_shortlist(job_ids, batch_id=batch_id, ttl_minutes=15)

# 3. Acknowledge delivery after presentation to user
repo.acknowledge_shortlist_delivery(batch_id, reserved_job_ids)
```

---

## 7. Human-in-the-Loop Safeguards

- **Fact-ID Provenance**: Every generated career statement or requirement match references an immutable `fact_id`. Unverified claims or hallucinated employers/degrees fail deterministic validation.
- **Resume Approval Boundary**: Resume review is executed by the human user via `scripts/review_resume.py`. AI agents cannot sign off on resume artifacts autonomously.
- **Application Boundary**: Browser automation and form submission are strictly human-in-the-loop. No autonomous submissions are permitted.

---

## 8. Test Suite Verification

Run the full automated test suite to ensure all discovery, scoring, provenance, document generation, and workflow state constraints pass:

```bash
.venv/bin/pytest tests/
```
