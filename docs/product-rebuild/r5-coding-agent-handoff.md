# Milestone R5 Coding-Agent Handoff & Implementation Specification

> **Task**: Implement Milestone R5 (Settings & Data Management UI, Backup/Restore Engine, Safe Board Reset, and Clean Legacy Cutover).  
> **Prerequisite**: Milestone R4-G verified.  
> **Mandatory Safety Rule**: NEVER run shell `command(rm)`. Deletions must strictly use Node.js `fs.rmSync` or `git rm`.

---

## 1. Work Order Overview

Milestone R5 finishes the local-first rebuild by delivering:
1. **R5-A: Settings & Data Management UI**:
   - A persistent `Settings (⚙️)` modal in the top header.
   - One-click SQLite + Artifacts backup download (`GET /api/backup`).
   - Safe archive restore with pre-restore safety copy (`POST /api/restore`).
   - Safe "Clear All Jobs" board reset (`POST /api/jobs/reset`).
   - AI Model status & test connection ping (`POST /api/settings/ai-test`).
   - Candidate Profile summary & re-sync button.
2. **R5-B: Final Legacy Cutover**:
   - Deletion of all retired Python runtime files (`services/`, `.venv/`, `pyproject.toml`, scripts, tests).
   - Deletion of PostgreSQL files (`docker-compose.yml`, `db/migrations/*.sql`).
   - Modernized `README.md` reflecting pure Node/Next.js/SQLite operation.
3. **R5-C: User Walkthrough Checklist**:
   - Quick 8-step manual acceptance guide for the user.

---

## 2. Detailed Technical Specifications for R5-A

### A. Settings UI Component (`components/settings/SettingsModal.tsx`)
- **Trigger**: Add a `Settings` button with a `Settings` / `Sliders` icon in `components/AppHeader.tsx` (next to `Add Job` and theme toggle).
- **Layout**: Clean Radix Dialog modal with tabbed or sectioned layout:
  - **Tab 1: Data Management & Backup**
    - **Backup Export**:
      - Button: `Download Full Backup` (triggers `window.location.href = '/api/backup'`).
      - Description: *"Downloads a consolidated archive containing your SQLite database, candidate profile, and all tailored resume artifacts."*
    - **Restore from Backup**:
      - File input accepting `.tar.gz` or `.zip`.
      - Displays uploaded filename and size.
      - Confirmation prompt: *"Restoring will replace the current database and resumes. An automatic safety backup will be saved locally first. Proceed?"*
      - Button: `Restore Backup`.
    - **Safe Board Reset**:
      - Button: `Clear All Jobs` (variant: destructive).
      - Opens a confirmation dialog: requires typing `RESET` to enable the confirm button.
      - Calls `POST /api/jobs/reset` and reloads board.
  - **Tab 2: AI & Models**
    - Displays active models:
      - Primary: `google/gemma-4-26b-a4b-it:free`
      - Secondary: `nvidia/nemotron-3.5-lightning:free`
    - API Key Status: Green badge if `process.env.OPENROUTER_API_KEY` is present; amber badge if missing with instruction to add to `.env.local`.
    - Button: `Test AI Connection` (calls `POST /api/settings/ai-test`). Shows latency (e.g. `240ms - OK`).
  - **Tab 3: Candidate Profile & System Health**
    - Candidate Name: *Mouad Atfi*
    - Profile Version: Active version ID from SQLite.
    - Statistics: Approved Facts count (17), Verified Skills count (38).
    - Button: `Re-sync Master Resume` (re-loads `data/candidate/master-resume.json`).
    - Storage Info: Total jobs, total resumes, SQLite file size, and artifact storage size.

---

### B. Backend Endpoints

#### 1. `GET /app/api/backup/route.ts`
- **Steps**:
  1. Open SQLite handle: run `PRAGMA wal_checkpoint(TRUNCATE)` to flush all WAL changes into `data/rebuild/job-tracker.sqlite`.
  2. Create a compressed `.tar.gz` archive containing:
     - `data/rebuild/job-tracker.sqlite`
     - `data/candidate/master-resume.json`
     - `data/rebuild/artifacts/` (all PDF, DOCX, Markdown resumes and scrape evidence)
  3. **Crucial Security Guard**: NEVER include `.env`, `.env.local`, or root project files.
  4. Set headers:
     - `Content-Type: application/gzip`
     - `Content-Disposition: attachment; filename="job-tracker-backup-${YYYY-MM-DD}.tar.gz"`
  5. Stream response directly to client.

#### 2. `POST /app/api/restore/route.ts`
- **Steps**:
  1. Parse multipart form upload.
  2. Pre-Restore Safety Copy: Copy current `data/rebuild/job-tracker.sqlite` to `data/rebuild/job-tracker.pre-restore-${timestamp}.bak`.
  3. Extract archive to a temporary staging folder.
  4. Verify the extracted SQLite database opens cleanly and passes `PRAGMA integrity_check`.
  5. Atomically move/replace the database and artifact files into `data/rebuild/`.
  6. Return `200 OK` with `{ restored: true, timestamp: ... }`.

#### 3. `POST /app/api/jobs/reset/route.ts`
- **Steps**:
  1. In a synchronous SQLite transaction:
     - Delete job and tailoring history: `resume_claim_facts`, `resume_claims`, `resume_reviews`, `resume_artifacts`, `resume_versions`, `job_notes`, `workflow_events`, `applications`, `source_artifacts`, `scrape_attempts`, `job_extractions`, `job_sources`, `work_attempts`, `work_items`, `intake_items`, `intake_batches`, `job_analyses`, `jd_snapshots`, `jobs`.
  2. Preserves: `candidate_profiles`, `candidate_profile_versions`, `candidate_facts`, `candidate_snapshots`, `candidate_snapshot_facts`.
  3. Run `VACUUM`.
  4. Return `200 OK` with `{ reset: true }`.

#### 4. `POST /app/api/settings/ai-test/route.ts`
- Sends a minimal 1-token test completion (`{"model": "google/gemma-4-26b-a4b-it:free", "messages": [{"role": "user", "content": "ping"}]}`) to `https://openrouter.ai/api/v1/chat/completions`.
- Returns `{ ok: true, latencyMs: 310, model: "google/gemma-4-26b-a4b-it:free" }` or `{ ok: false, error: err.message }`.

---

## 3. Detailed Specifications for R5-B (Legacy Cutover)

### Exact Files to Delete via `git rm` or Node `fs.rmSync`:
1. **Python Virtual Environment & Packaging**:
   - `.venv/`
   - `.pytest_cache/`
   - `pyproject.toml`
   - `pytest.ini`
   - `requirements.txt`
2. **Python Services**:
   - `services/` (entire directory)
3. **PostgreSQL & Container Artifacts**:
   - `docker-compose.yml`
   - `db/migrations/` (all PostgreSQL migrations; keep `drizzle/` for SQLite)
   - `db/seeds/`
   - `db/` directory (if empty after removing migrations/seeds)
4. **Retired Python Scripts (`scripts/*.py`)**:
   - `scripts/check_environment.py`
   - `scripts/export_mcp_schemas.py`
   - `scripts/generate-extraction-goldens.py`
   - `scripts/init_db.py`
   - `scripts/load_candidate_profile.py`
   - `scripts/migrate.py`
   - `scripts/record_application_outcome.py`
   - `scripts/review_code.py`
   - `scripts/review_resume.py`
   - `scripts/review_wording_variant.py`
   - `scripts/run_agent_discovery.py`
   - `scripts/run_control_center.py`
   - `scripts/run_discovery.py`
   - `scripts/run_parity_fixtures.py`
   - `scripts/run_rehearsal.py`
   - `scripts/run_scheduled_scan.py`
   - `scripts/show_candidate_profile.py`
   - `scripts/show_job_context.py`
   - `scripts/show_pipeline_status.py`
   - `scripts/tailor_resume.py`
   - `scripts/__pycache__/`
5. **Retired Python Tests (`tests/*.py`)**:
   - `tests/conftest.py`
   - All `tests/test_*.py` files (keep `tests/unit/`, `tests/e2e/`, and `tests/fixtures/`)
   - `tests/__pycache__/`

### Documentation Cutover:
- Update `README.md` to:
  - Explain the 100% local architecture: Next.js + React + SQLite + Playwright.
  - Getting started in 1 command: `npm run dev`.
  - Provide configuration guidance for `.env.local` (`OPENROUTER_API_KEY`).
  - Document the backup and restore procedure.

---

## 4. Verification & Validation Gate

1. **Type & Lint Check**:
   - `npm run typecheck` must pass with 0 errors.
   - `npm run lint` must pass with 0 errors.
2. **Unit Tests**:
   - `npm test` must run all Vitest suites and pass completely.
3. **Dead Reference Check**:
   - Ripgrep for `.py`, `PostgreSQL`, `psycopg`, or `docker-compose` to confirm zero dangling code references in the active runtime.
4. **Dev Server Run**:
   - `npm run dev` starts cleanly at `http://127.0.0.1:3000`.
   - Settings modal opens and performs backup download.
