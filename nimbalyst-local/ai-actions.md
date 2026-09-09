# Nimbalyst AI Actions

Quick 1-click prompts accessible directly from Nimbalyst's AI prompt composer dropdown:

### Run Daily Job Discovery & Radar
Run discovery across configured boards (Indeed, LinkedIn, Glassdoor) via `python scripts/run_discovery.py`. Summarize new HOT postings (0-24h) with fit score >= 80, showing company, title, location, and key match highlights.

### Truthful Resume Integrity Check
Inspect the latest generated resume against candidate memory fact-ids. Verify that 100% of bullet points map to verified fact_ids and confirm that zero unsupported requirements are present.

### Generate Morning Radar Briefing
Trigger the morning briefing generation via `services/briefing/service.py`. Produce the categorized digest of high-priority jobs ready for human review today.

### Check Database Health & System Status
Check PostgreSQL database connection, recent migrations, and job count by status (DISCOVERED, SCORED, READY, WAITING_FOR_HUMAN, APPLIED).
