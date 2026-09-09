# Local-First MCP Job-Search Operating System

An autonomous, local-first, MCP-native job discovery, fit evaluation, and application workflow running under **Antigravity** as the primary agent and reasoning harness.

## System Highlights

- **AI Layer**: Antigravity is the primary intelligence engine. No local Ollama, vLLM, or separate LLMs.
- **Candidate Memory**: Backed by a local **PostgreSQL 16** database. All achievements are anchored to immutable, verified `fact_id` records (`fact_001`, `fact_002`, ...). Strictly prevents hallucination or fabrication.
- **5-Signal Deduplication**: Merges multi-board listings across LinkedIn, Indeed, Glassdoor, and ZipRecruiter using canonical URLs, direct ATS URLs (Lever, Greenhouse, Workday, etc.), source IDs, company/title/location heuristics, and content hashing.
- **Freshness Classification**: Categorizes postings into `HOT` (<=24h), `FRESH` (24–48h), `RECENT` (48–72h), and `STALE` (>72h).
- **Fit Scoring Engine**: Deterministic multi-factor scoring (Role alignment 25%, Experience 20%, Seniority 15%, Skills 15%, Domain 10%, Location 5%, Comp 5%, Preferences 5%) that references verified career facts.
- **Model Context Protocol (MCP)**: Exposes pipeline tools (`career-memory`) directly to Antigravity.

---

## Directory Structure

```text
job-search-agent/
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
│
├── docs/
│   ├── architecture.md       # Target architecture and data flows
│   ├── environment.md        # Detected host specifications
│   ├── decisions.md          # Architectural Decision Records (ADRs)
│   ├── mcp.md                # MCP server definitions and tool schemas
│   └── operations.md         # CLI and execution runbook
│
├── db/
│   ├── migrations/           # 001_initial_schema.sql
│   └── seeds/                # 001_candidate_seed.sql
│
├── config/
│   ├── jobs.yaml             # Target roles, locations, board parameters
│   ├── scoring.yaml          # Factor weights and recommendation thresholds
│   └── schedule.yaml         # Twice-daily scan configurations
│
├── services/
│   ├── discovery/            # Scraper, normalizer, freshness, deduplicator
│   ├── intelligence/         # Deterministic fit scorer
│   ├── memory/               # PostgreSQL repository
│   └── mcp/                  # FastMCP career-memory server
│
├── scripts/
│   ├── init_db.py            # Schema migration runner; demo data is opt-in
│   └── run_discovery.py      # Manual and scheduled discovery runner
│
└── tests/                    # Automated pytest suite
```

---

## Quick Start

### 1. Requirements
- macOS on Apple Silicon (ARM64)
- Python 3.11+
- PostgreSQL 16 (`brew install postgresql@16 && brew services start postgresql@16`)

### 2. Database Setup
```bash
/opt/homebrew/opt/postgresql@16/bin/createdb -U mouadatfi job_system
.venv/bin/python scripts/init_db.py
.venv/bin/python scripts/load_candidate_profile.py --confirm-replace
```

### 3. Run Automated Tests
```bash
.venv/bin/pytest tests/
```

### 4. Execute Discovery Scan
```bash
.venv/bin/python scripts/run_discovery.py
```
