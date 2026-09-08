# Operations & Runbook

This runbook describes how to operate, monitor, and troubleshoot the Job Search Operating System.

## Quick Reference Commands

### Start / Stop Local Services
```bash
# Start PostgreSQL 16
brew services start postgresql@16

# Check PostgreSQL status
brew services list

# Stop PostgreSQL 16
brew services stop postgresql@16
```

### Database Administration
```bash
# Connect to interactive psql shell
/opt/homebrew/opt/postgresql@16/bin/psql -d job_system

# Run database schema migrations
/Users/mouadatfi/Antigravity/job/.venv/bin/python /Users/mouadatfi/Antigravity/job/scripts/init_db.py
```

### Discovery & Scoring
```bash
# Execute manual discovery scan (default: Canada, <=72h, Senior/Technical Product Manager)
/Users/mouadatfi/Antigravity/job/.venv/bin/python /Users/mouadatfi/Antigravity/job/scripts/run_discovery.py

# Query HOT jobs (0-24h)
/Users/mouadatfi/Antigravity/job/.venv/bin/python -m services.memory.cli list-jobs --freshness HOT

# Run test suite
/Users/mouadatfi/Antigravity/job/.venv/bin/pytest /Users/mouadatfi/Antigravity/job/tests
```

## Scheduled Operations

Two recurring daily agent workflows are configured:
- **Morning Scan**: 07:30 local time (`America/Toronto`)
- **Evening Scan**: 18:30 local time (`America/Toronto`)

Each scan automatically:
1. Queries configured job boards across Canada / Ontario / Remote.
2. Ingests new postings within the 24h/72h window.
3. Deduplicates across sources and records source provenance.
4. Categorizes freshness (`HOT`, `FRESH`, `RECENT`, `STALE`).
5. Evaluates candidate fit against verified facts.
6. Persists all records and produces an agent audit log in `agent_runs`.
