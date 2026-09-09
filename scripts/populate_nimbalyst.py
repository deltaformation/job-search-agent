import os
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def make_ulid(seed_offset=0):
    t = int((1725890000 + seed_offset) * 1000)
    time_chars = []
    for _ in range(10):
        time_chars.append(ALPHABET[t % 32])
        t //= 32
    time_str = "".join(reversed(time_chars))
    import hashlib
    h = hashlib.sha256(f"seed_{seed_offset}".encode()).digest()
    rand_chars = "".join(ALPHABET[b % 32] for b in h[:16])
    return time_str + rand_chars

os.makedirs("nimbalyst-local/tracker", exist_ok=True)
os.makedirs("nimbalyst-local/plans", exist_ok=True)

# 1. Decisions
decisions_content = f"""# Architecture Decision Records (ADR)

## Core Architecture Decisions
- ADR-001: Local-First PostgreSQL 16 as Single Source of Truth #decision[id:dec_{make_ulid(100)} status:approved priority:critical created:2026-09-01]
  - **Status**: Approved
  - **Context**: Needed reliable ACID storage for job postings, deduplication fingerprints, and verified candidate career facts.
  - **Decision**: Adopt PostgreSQL 16 (`job_system`) running locally. Avoid cloud vendor lock-in or proprietary storage.

- ADR-002: Antigravity as the Sole Reasoning Harness #decision[id:dec_{make_ulid(101)} status:approved priority:critical created:2026-09-01]
  - **Status**: Approved
  - **Context**: Wanted to minimize infrastructure overhead and maximize reasoning capability without managing local Ollama or vLLM instances.
  - **Decision**: Antigravity is the primary LLM reasoning layer and agent harness, interfacing with the system exclusively via FastMCP tools.

- ADR-003: FastMCP Python Server with Native Tool Schemas #decision[id:dec_{make_ulid(102)} status:approved priority:high created:2026-09-02]
  - **Status**: Approved
  - **Context**: Need a protocol for Antigravity to discover jobs, score fits, update statuses, and retrieve candidate facts.
  - **Decision**: Implemented FastMCP (`career-memory`) exposing stdio tools.

- ADR-004: Strict Fact-ID Provenance Engine (No Hallucinations) #decision[id:dec_{make_ulid(103)} status:approved priority:critical created:2026-09-03]
  - **Status**: Approved
  - **Context**: Generative resume tools frequently hallucinate credentials, dates, or tools.
  - **Decision**: Every generated bullet point must explicitly trace back to an immutable `fact_id` in candidate memory. Unmatched JD requirements must be labeled as `gap` or `unsupported`.

- ADR-005: Strict Human Takeover Boundary for Application Submission #decision[id:dec_{make_ulid(104)} status:approved priority:critical created:2026-09-05]
  - **Status**: Approved
  - **Context**: Automated bots submitting applications risk violating terms of service, misrepresenting work authorization, or submitting bad data.
  - **Decision**: The agent stops at `WAITING_FOR_HUMAN`. Human must take over in a headed browser to inspect and confirm final submission.

- ADR-006: Immutable Resume Versioning with SHA256 Integrity Checks #decision[id:dec_{make_ulid(105)} status:approved priority:high created:2026-09-06]
  - **Status**: Approved
  - **Context**: Need auditability and tamper protection for resumes submitted to employers.
  - **Decision**: Approved resumes are locked with SHA256 hashes. Any revision creates a new version; previous reviewed artifacts are never overwritten.
"""

with open("nimbalyst-local/tracker/decisions.md", "w") as f:
    f.write(decisions_content)

# 2. Ideas
ideas_content = f"""# Project Ideas & Wishlist

## Active Ideas
- LinkedIn easy-apply auto-tagging and quick screening filter #idea[id:ida_{make_ulid(200)} status:to-do priority:medium created:2026-09-07]
- Voice-synthesized daily briefing audio dispatch for morning commute #idea[id:ida_{make_ulid(201)} status:to-do priority:low created:2026-09-08]
- Automated interview question generation based on detected JD gaps #idea[id:ida_{make_ulid(202)} status:to-do priority:high created:2026-09-09]
- Recruiter outreach email drafter using candidate voice and matched facts #idea[id:ida_{make_ulid(203)} status:to-do priority:medium created:2026-09-09]
- Multi-region job discovery across remote US and Canadian tech hubs #idea[id:ida_{make_ulid(204)} status:to-do priority:medium created:2026-09-09]
"""

with open("nimbalyst-local/tracker/ideas.md", "w") as f:
    f.write(ideas_content)

# 3. AI Actions
ai_actions_content = """# Nimbalyst AI Actions

Quick 1-click prompts accessible directly from Nimbalyst's AI prompt composer dropdown:

### Run Daily Job Discovery & Radar
Run discovery across configured boards (Indeed, LinkedIn, Glassdoor) via `python scripts/run_discovery.py`. Summarize new HOT postings (0-24h) with fit score >= 80, showing company, title, location, and key match highlights.

### Truthful Resume Integrity Check
Inspect the latest generated resume against candidate memory fact-ids. Verify that 100% of bullet points map to verified fact_ids and confirm that zero unsupported requirements are present.

### Generate Morning Radar Briefing
Trigger the morning briefing generation via `services/briefing/service.py`. Produce the categorized digest of high-priority jobs ready for human review today.

### Check Database Health & System Status
Check PostgreSQL database connection, recent migrations, and job count by status (DISCOVERED, SCORED, READY, WAITING_FOR_HUMAN, APPLIED).
"""

with open("nimbalyst-local/ai-actions.md", "w") as f:
    f.write(ai_actions_content)

# 4. Plans for Milestones 1 - 6
m1 = f"""---
planStatus:
  planId: "pln_{make_ulid(301)}"
  title: "Milestone 1: Local Job Discovery & Ingestion"
  status: "completed"
  planType: "feature"
  priority: "critical"
  progress: 100
  owner: "Antigravity"
  tags: ["discovery", "jobspy", "postgresql", "mcp"]
  created: "2026-09-01"
  updated: "2026-09-02T18:00:00.000Z"
---

# Milestone 1: Local Job Discovery & Ingestion

## Overview
A local-first, multi-board job scraper and ingestion engine that interfaces with PostgreSQL 16 and exposes core capabilities to Antigravity via FastMCP.

## Key Deliverables
- **JobSpy Multi-Board Scraper**: Unified wrapper scraping LinkedIn, Indeed, Glassdoor, and ZipRecruiter with anti-blocking and jitter.
- **5-Signal Deduplication**: Robust fingerprinting (canonical URL, normalized company, job title, clean location, description hash) preserving multi-board provenance in `job_sources`.
- **Posting Age & Freshness Bucketing**: Classification into `HOT` (0-24h), `FRESH` (24-48h), `RECENT` (48-72h), and `STALE` (>72h).
- **PostgreSQL 16 Schema**: Migration-managed tables for jobs, sources, raw postings, and candidate profiles.
- **FastMCP Stdio Server**: Native tool integration (`career-memory`) exposing `get_jobs_feed`, `get_job_details`, `update_job_status`, and `search_and_ingest_jobs`.
"""

m2 = f"""---
planStatus:
  planId: "pln_{make_ulid(302)}"
  title: "Milestone 2: Truthful Resume Tailoring & ATS Rendering"
  status: "completed"
  planType: "feature"
  priority: "critical"
  progress: 100
  owner: "Antigravity"
  tags: ["resume", "fact-id", "provenance", "pdf", "weasyprint"]
  created: "2026-09-03"
  updated: "2026-09-04T18:00:00.000Z"
---

# Milestone 2: Truthful Resume Tailoring & ATS Rendering

## Overview
A deterministic, zero-hallucination resume tailoring engine that maps candidate career facts directly to target job requirements, renders ATS-compliant single-page PDFs, and enforces human sign-off before any artifact is approved.

## Key Deliverables
- **Fact-ID Provenance Engine**: Immutable fact registry where every claim, bullet point, technology, and metric maps to a verified `fact_id` (e.g. `fact_001`).
- **Strict Anti-Hallucination Policy**: Hard rules preventing the invention of employers, degrees, dates, clearances, or skills. Unmatched JD requirements are explicitly recorded as `gap`.
- **ATS PDF Rendering**: High-fidelity, parseable PDF generation with clean typographic hierarchy.
- **Tamper-Proof Approval Workflow**: Resumes are versioned immutably and stamped with SHA256 digests.
- **Human Review Boundary**: Interactive CLI (`scripts/review_resume.py`) requiring human approval before marking artifacts `APPROVED`.
"""

m3 = f"""---
planStatus:
  planId: "pln_{make_ulid(303)}"
  title: "Milestone 3: Guarded Application Copilot & Takeover Boundary"
  status: "completed"
  planType: "feature"
  priority: "critical"
  progress: 100
  owner: "Antigravity"
  tags: ["playwright", "copilot", "field-governance", "safety"]
  created: "2026-09-05"
  updated: "2026-09-06T18:00:00.000Z"
---

# Milestone 3: Guarded Application Copilot & Takeover Boundary

## Overview
A browser-assisted application copilot built on Playwright that navigates ATS portals, pre-fills verified candidate details, enforces strict field governance, and unconditionally halts for human takeover before submission.

## Key Deliverables
- **Deterministic Field Safety Governance**:
  - `SAFE`: Name, email, phone, location, LinkedIn URL, portfolio, and approved resume upload.
  - `HUMAN_REVIEW`: Work authorization, salary expectations, custom screening questions.
  - `PROHIBITED`: Autonomous clicking of final "Submit Application" buttons.
- **Strict Takeover Checkpoint**: The copilot halts in a headed browser at status `WAITING_FOR_HUMAN`. The candidate inspects all fields and performs the final click.
- **SHA256 Approved Artifact Binding**: Forbids unapproved resume versions, symlinks, or path traversal.
- **Interactive Outcome Recorder**: `scripts/record_application_outcome.py` with human TTY confirmation.
"""

m4 = f"""---
planStatus:
  planId: "pln_{make_ulid(304)}"
  title: "Milestone 4: Evidence & Preparation Contract"
  status: "completed"
  planType: "feature"
  priority: "high"
  progress: 100
  owner: "Antigravity"
  tags: ["intelligence", "scoring", "gap-analysis", "interview-prep"]
  created: "2026-09-07"
  updated: "2026-09-07T18:00:00.000Z"
---

# Milestone 4: Evidence & Preparation Contract

## Overview
An intelligence layer that scores candidate fit against job descriptions, identifies skill gaps with complete honesty, and synthesizes structured interview preparation briefs.

## Key Deliverables
- **Fit Scoring Engine**: Multi-dimensional scoring evaluating required skills, preferred qualifications, seniority, and domain relevance.
- **Transparent Gap Analysis**: Explicit itemization of supported versus unsupported requirements so candidates know where they stand before applying.
- **Company & Role Research Briefs**: Automatic dossier generation including company overview, tech stack, and strategic focus areas.
"""

m5 = f"""---
planStatus:
  planId: "pln_{make_ulid(305)}"
  title: "Milestone 5: Local Control Service & Same-Conversation Bridge"
  status: "completed"
  planType: "feature"
  priority: "high"
  progress: 100
  owner: "Antigravity"
  tags: ["service", "fastapi", "sse", "bridge", "notifications"]
  created: "2026-09-08"
  updated: "2026-09-08T18:00:00.000Z"
---

# Milestone 5: Local Control Service & Same-Conversation Bridge

## Overview
A lightweight local REST/SSE service and supervisor bridge enabling background workers to report progress, manage long-running sessions, and notify Antigravity within the same conversation loop.

## Key Deliverables
- **Local Control API**: FastAPI service on localhost with token security and structured session control.
- **Worker Session Lifecycle**: Tracking active, completed, and waiting background jobs.
- **Real-Time Event Streaming**: SSE endpoint delivering state changes and human-takeover alerts.
- **Desktop Notification Integration**: System alerts when copilot sessions reach `WAITING_FOR_HUMAN`.
"""

m6 = f"""---
planStatus:
  planId: "pln_{make_ulid(306)}"
  title: "Milestone 6: Morning Job Radar & Daily Briefing View"
  status: "in-development"
  planType: "feature"
  priority: "high"
  progress: 85
  owner: "Antigravity"
  tags: ["briefing", "radar", "dashboard", "morning-routine"]
  created: "2026-09-09"
  updated: "2026-09-09T15:00:00.000Z"
---

# Milestone 6: Morning Job Radar & Daily Briefing View

## Overview
A morning command-center dashboard and daily briefing generator that presents fresh high-fit opportunities discovered overnight, organized for fast human triaging, review, and single-click application prep.

## Key Deliverables
- **Job Briefings Persistence**: Database migration `012_job_briefings.sql` storing daily digests and candidate notes.
- **Briefing Generator Service**: `services/briefing/service.py` curating top matches, classifying posting age, and highlighting key match reasons.
- **Morning Dashboard View**: `services/ui/briefing_view.py` rendering interactive job cards with score badges, gap summaries, and direct review actions.
- **Automated Scheduling Integration**: Daily cron trigger for 08:00 AM local time.
"""

with open("nimbalyst-local/plans/milestone-1-discovery-ingestion.md", "w") as f:
    f.write(m1)
with open("nimbalyst-local/plans/milestone-2-truthful-resume-engine.md", "w") as f:
    f.write(m2)
with open("nimbalyst-local/plans/milestone-3-guarded-application-copilot.md", "w") as f:
    f.write(m3)
with open("nimbalyst-local/plans/milestone-4-evidence-prep-contract.md", "w") as f:
    f.write(m4)
with open("nimbalyst-local/plans/milestone-5-local-control-bridge.md", "w") as f:
    f.write(m5)
with open("nimbalyst-local/plans/milestone-6-morning-job-radar.md", "w") as f:
    f.write(m6)

# 5. Project Summary
summary_content = """# Job Search Operating System (Antigravity + Nimbalyst)

A local-first, MCP-native job-search and application automation system designed to run under **Antigravity** as the primary agent harness and visualized in **Nimbalyst**.

## Core Architecture
- **Reasoning Harness**: Google Antigravity (Gemini)
- **Visual Workspace**: Nimbalyst (Multi-editor, Kanban, Session tracker)
- **Local Persistence**: PostgreSQL 16 (`job_system`)
- **MCP Server**: FastMCP `career-memory`
- **Scraping**: Multi-board JobSpy wrapper (LinkedIn, Indeed, Glassdoor, ZipRecruiter)
- **Resume Tailoring**: Fact-ID provenance engine with WeasyPrint ATS PDF renderer
- **Application Copilot**: Guarded Playwright browser automation with mandatory human takeover
"""

with open("nimbalyst-local/project-summary.md", "w") as f:
    f.write(summary_content)

print("All Nimbalyst plans and tracker files generated successfully!")
