# MCP Integration & Server Registry

This document details the Model Context Protocol (MCP) servers integrated with Antigravity, their transport protocols, configurations, and available tools.

## Active & Configured Servers

### 1. `career-memory`
- **Purpose**: Candidate facts, job pipeline storage, deduplication, fit scoring, and application tracking.
- **Server Type**: FastMCP (Python 3.11)
- **Transport**: `stdio`
- **Entrypoint**: `/Users/mouadatfi/Antigravity/job/.venv/bin/python /Users/mouadatfi/Antigravity/job/services/mcp/server.py`
- **Environment**: Configured in `/Users/mouadatfi/.gemini/config/mcp_config.json`
- **Exposed Tools**:
  - `search_and_ingest_jobs`: Trigger multi-board search, normalize, deduplicate, bucket freshness, and persist.
  - `get_jobs_feed`: Query jobs by freshness (`HOT`, `FRESH`, `RECENT`), status, minimum score, and posting window.
  - `get_job_details`: Retrieve full job details, JD description, source provenance, and ATS apply links.
  - `score_job_fit`: Compute or retrieve candidate fit score with strengths, gaps, risks, and evidence fact IDs.
  - `get_candidate_profile`: Retrieve verified candidate profile, skills, and immutable fact IDs (`fact_001`, etc.).
  - `record_application_event`: Transition job/application state (`QUALIFIED`, `TAILORING`, `WAITING_FOR_HUMAN`, etc.).
  - `get_agent_runs`: Audit recent scheduled or manual discovery executions and metrics.

### 2. `jobspy` (Discovery Feed)
- **Purpose**: Low-level board scraper for Indeed, LinkedIn, ZipRecruiter, and Glassdoor.
- **Server Type**: Python MCPServer
- **Transport**: `stdio`
- **Entrypoint**: `/Users/mouadatfi/Documents/jobspy-mcp/.venv/bin/python /Users/mouadatfi/Documents/jobspy-mcp/server.py`
- **Exposed Tools**:
  - `search_jobs`: Query raw postings by keyword, country, location, and age.

### 3. `playwright` (Browser Automation - Milestone 3)
- **Purpose**: Headless and visible browser automation for ATS form inspection and filling.
- **Server Type**: Microsoft Official Playwright MCP
- **Transport**: `stdio` via `npx`
- **Entrypoint**: `npx -y @playwright/mcp@latest`

### 4. `github` & `cloudflare`
- Pre-existing user configurations maintained without alteration.

## Configuration Syntax (`~/.gemini/config/mcp_config.json`)

```json
{
  "mcpServers": {
    "career-memory": {
      "command": "/Users/mouadatfi/Antigravity/job/.venv/bin/python",
      "args": [
        "/Users/mouadatfi/Antigravity/job/services/mcp/server.py"
      ],
      "env": {
        "DATABASE_URL": "postgresql://mouadatfi@localhost:5432/job_system",
        "PYTHONPATH": "/Users/mouadatfi/Antigravity/job"
      }
    }
  }
}
```
