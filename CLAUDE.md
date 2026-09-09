# CLAUDE.md - Job Search Operating System

## Project Overview
This repository is a **local-first, MCP-native job-search and application automation system** managed as a multi-agent project in **Nimbalyst**.
- **Persistence**: Local PostgreSQL 16 database (`job_system`).
- **MCP Layer**: FastMCP server (`career-memory`) exposing discovery, candidate profile, fit scoring, and application tracking tools.
- **AI Reasoning**: Codex and Gemini/Antigravity can reason over the same deterministic services. Provider-specific integrations are adapters, not sources of truth.
- **Shared Workflow**: Read `AGENTS.md`, `nimbalyst-local/project-summary.md`, and `nimbalyst-local/agent-handoff.md` before beginning milestone work.

## Architecture & Monorepo Structure
- `config/`: Configuration files for search criteria (`jobs.yaml`), scoring weights (`scoring.yaml`), and schedule (`schedule.yaml`).
- `db/migrations/`: SQL DDL migrations (e.g. `001_initial_schema.sql`).
- `db/seeds/`: Seed SQL files (e.g. `001_candidate_seed.sql`).
- `services/discovery/`: Scraper (JobSpy wrapper), normalizer, deduplicator (5-signal), and freshness bucketer.
- `services/intelligence/`: Fit scorer evaluating JD against verified candidate profile.
- `services/memory/`: PostgreSQL repository and data access layer.
- `services/mcp/`: FastMCP server (`career-memory`) for compatible agent clients.
- `scripts/`: Operational entrypoints (`init_db.py`, `run_discovery.py`, `review_code.py`).
- `tests/`: Pytest test suite (`pytest tests/`).

## Critical Domain & Truthfulness Rules
1. **Never Invent Facts**: The agent must NEVER invent employers, titles, dates, technologies, certifications, degrees, security clearances, metrics, responsibilities, or years of experience.
2. **Fact-ID Provenance**: Every career fact in candidate memory has an immutable `fact_id` (e.g. `fact_001`). All generated resume claims or bullet points must map to at least one verified `fact_id`.
3. **Unsupported Requirements**: Unmatched job description requirements must be explicitly marked as `unsupported` or `gap`. Never synthesize unverified candidate experience to fill a JD gap.
4. **Human-in-the-Loop Safety**: Work authorization, legal disclosures, salary negotiations, and final application submissions require explicit human review. No autonomous final submissions in V1.

## Code Standards & Guidelines
- **Python Version**: Python 3.11+.
- **Type Annotations**: All new functions should have complete type hints (`typing.Optional`, `typing.List`, `typing.Dict`, etc.).
- **Database / JSON Handling**:
  - Always handle `Decimal` and `NaN` conversions before `json.dumps()`. PostgreSQL `NUMERIC` types return `decimal.Decimal` which requires `default=str` or float conversion.
  - Pandas `NaN` values must be sanitized to `None` prior to JSON serialization.
- **Error Handling**:
  - Scraping failures on one board must not abort discovery on other boards.
  - Database operations should use parameterized queries (`%s`) to prevent SQL injection.
- **Testing**:
  - Always run `pytest tests/` after modifying services or logic. All tests must pass with zero errors.

## Code Review Checklist
When reviewing code in this repository, check for:
1. **Fact Integrity**: Does the code respect candidate memory and `fact_id` provenance?
2. **Resilience**: Are third-party failures (HTTP 403, 400, rate limits) caught and logged without crashing the pipeline?
3. **Security**: Are credentials kept out of source code (using `.env` / environment variables)?
4. **Data Consistency**: Does deduplication maintain canonical URL resolution and preserve source provenance in `job_sources`?
5. **Freshness Accuracy**: Does posting age calculation correctly bucket into `HOT` (0-24h), `FRESH` (24-48h), `RECENT` (48-72h), and `STALE` (>72h)?
