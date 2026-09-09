# AGENTS.md - Job Search Operating System

This document provides instructions, architectural context, and code review guidelines for AI coding agents (including ChatGPT Codex).

## Project Overview
This repository is a **local-first, MCP-native job-search and application automation system** designed to run under **Antigravity** as the primary agent harness.
- **Persistence**: Local PostgreSQL 16 database (`job_system`).
- **MCP Layer**: FastMCP server (`career-memory`) exposing discovery, candidate profile, fit scoring, and application tracking tools.
- **AI Reasoning**: Antigravity itself is the primary LLM reasoning layer. No local Ollama, vLLM, or separate LLMs are used.

## Architecture & Monorepo Structure
- `config/`: Configuration files for search criteria (`jobs.yaml`), scoring weights (`scoring.yaml`), and schedule (`schedule.yaml`).
- `db/migrations/`: SQL DDL migrations (e.g. `001_initial_schema.sql`).
- `db/seeds/`: Seed SQL files (e.g. `001_candidate_seed.sql`).
- `services/discovery/`: Scraper (JobSpy wrapper), normalizer, deduplicator (5-signal), and freshness bucketer.
- `services/intelligence/`: Fit scorer evaluating JD against verified candidate profile.
- `services/memory/`: PostgreSQL repository and data access layer.
- `services/mcp/`: FastMCP server (`career-memory`) for Antigravity integration.
- `scripts/`: Operational entrypoints (`init_db.py`, `run_discovery.py`).
- `tests/`: Pytest test suite (`pytest tests/`).

## Critical Domain & Truthfulness Rules
1. **Never Invent Facts**: The system must NEVER invent employers, titles, dates, technologies, certifications, degrees, security clearances, metrics, responsibilities, or years of experience.
2. **Fact-ID Provenance**: Every career fact in candidate memory has an immutable `fact_id` (e.g. `fact_001`). All generated resume claims or bullet points must map to at least one verified `fact_id`.
3. **Unsupported Requirements**: Unmatched job description requirements must be explicitly marked as `unsupported` or `gap`. Never synthesize unverified candidate experience to fill a JD gap.
4. **Human-in-the-Loop Safety**: Work authorization, legal disclosures, salary negotiations, and final application submissions require explicit human review. No autonomous final submissions in V1.

## Code Standards & Guidelines
- **Python Version**: Python 3.11+.
- **Type Annotations**: All functions must have complete type hints (`typing.Optional`, `typing.List`, `typing.Dict`, etc.).
- **Database / JSON Handling**:
  - Always handle `Decimal` and `NaN` conversions before `json.dumps()`. PostgreSQL `NUMERIC` types return `decimal.Decimal` which requires `default=str` or float conversion.
  - Pandas `NaN` values must be sanitized to `None` prior to JSON serialization.
- **Error Handling**:
  - Scraping failures on one board must not abort discovery on other boards.
  - Database operations should use parameterized queries (`%s`) to prevent SQL injection.
- **Testing**:
  - Always run `pytest tests/` after modifying services or logic. All tests must pass with zero errors.
- **Operational Commands**:
  - Prefer checked-in scripts for multiline diagnostics. Do not embed escaped Python f-strings in `python -c` shell commands. Use `scripts/show_candidate_profile.py` for candidate-memory inspection.

## Code Review Checklist (for Codex & Reviewers)
1. **Fact Integrity**: Does the code respect candidate memory and `fact_id` provenance?
2. **Resilience**: Are third-party failures (HTTP 403, 400, rate limits) caught and logged without crashing the pipeline?
3. **Security**: Are credentials kept out of source code (using `.env` / environment variables)?
4. **Data Consistency**: Does deduplication maintain canonical URL resolution and preserve source provenance in `job_sources`?
5. **Freshness Accuracy**: Does posting age calculation correctly bucket into `HOT` (0-24h), `FRESH` (24-48h), `RECENT` (48-72h), and `STALE` (>72h)?

## Milestone 2 Human Review Boundary
- Never run `scripts/review_resume.py` or call repository approval with `human_confirmed=True` autonomously. The local review command is operated by the human after inspecting the exact PDF/version.
- Content hashes and the legacy `approval_signature` field are integrity/audit metadata, not evidence of human consent or digital signatures.
- Generate a new immutable version for revisions; never overwrite a reviewed artifact. Resume approval never authorizes application submission.

## Milestone 3 Browser & Application Submission Boundary
- **Never Submit Applications Autonomously**: The agent harness (Antigravity) and background workers must NEVER click final submit buttons, submit ATS forms, or attest to legal/work authorization disclosures.
- **Strict Human Takeover**: Automation must stop at `WAITING_FOR_HUMAN` and emit a checkpoint. The human completes final review and manual submission in a headed browser.
- **Deterministic Field Governance**: Only factual candidate fields matching canonical profile memory verbatim may be planned or filled (`SAFE`). Legal, auth, and voluntary self-ID fields are `HUMAN_REVIEW` or `PROHIBITED`.
- **Approved Artifact Binding**: Application workflows require a `READY` job with an approved resume. The validator verifies on-disk SHA256 digests and forbids symlinks, path traversals, or unapproved versions.
- **Human-Only Outcome Recording**: `scripts/record_application_outcome.py` is strictly interactive and requires an active human TTY typing `CONFIRM`. Autonomous agents must never execute or mock this confirmation.
