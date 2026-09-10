# MCP Integration & Server Registry

This document details the Model Context Protocol (MCP) servers used by the project, their transport protocols, configurations, and available tools. The checked-in `career-memory` server is agent-neutral; the listed Gemini configuration is one client installation.

## Repository Server and Integration Options

### 1. `career-memory`
- **Purpose**: Candidate facts, job pipeline storage, deduplication, fit scoring, document tailoring, and application copilot workflows.
- **Server Type**: FastMCP (Python 3.11)
- **Transport**: `stdio`
- **Entrypoint**: `/Users/mouadatfi/Antigravity/job/.venv/bin/python /Users/mouadatfi/Antigravity/job/services/mcp/server.py`
- **Environment**: Configured in `/Users/mouadatfi/.gemini/config/mcp_config.json`
- **Other clients**: Nimbalyst-launched Codex or Gemini sessions may register the same stdio entrypoint in their own MCP settings. Keep secrets and machine-local configuration out of the repository.
- **Exposed Tools (28 tools)**:
  - **Discovery & Jobs**: `search_and_ingest_jobs`, `get_jobs_feed`, `get_job_details`, `update_job_status`, `get_agent_runs`
  - **Memory & Intelligence**: `get_candidate_profile`, `score_job_fit`, `get_pending_analysis`, `submit_analysis_version`
  - **Review Queue**: `get_shortlist`, `record_review_decision`, `reserve_shortlist`, `acknowledge_shortlist_delivery`
  - **Documents & Tailoring**: `get_tailoring_context`, `submit_resume_draft`, `get_tailoring_audit`, `create_preparation_request`, `get_preparation_status`
  - **Application Copilot**:
    - `prepare_application`: Validates job readiness (`READY` status, HTTPS URL, approved resume plain text and compiled PDF artifact digest) and initializes application attempt.
    - `get_application_context`: Provides scoped candidate facts, approved resume version, and target ATS information.
    - `record_form_snapshot`: Stores an immutable snapshot of detected form controls, labels, and layout fingerprints.
    - `submit_field_plan`: Deterministically validates proposed field actions against candidate memory and risk policy (`SAFE`, `HUMAN_REVIEW`, `PROHIBITED`).
    - `record_application_actions`: Records executed browser actions with status and selector audit logs.
    - `checkpoint_application`: Freezes automation, marks job as `WAITING_FOR_HUMAN`, and prepares human takeover summary.
    - `get_application_status`: Queries current application state, the latest attempt, and latest checkpoint.
  - **Morning Job Radar & Briefing**:
    - `create_morning_briefing`: Evaluates new/updated jobs within window, freezes snapshot, persists briefing, creates single-use UI session, and outputs markdown summary + one-time URL.
    - `get_latest_briefing`: Retrieves latest briefing header and metrics.
    - `get_briefing_details`: Retrieves full briefing snapshot including frozen item state.

- **Schema Packaging & Offline Registration**:
  - Run `python scripts/export_mcp_schemas.py` to generate checked-in JSON schemas into `services/mcp/schemas/`.
  - Client configurations (e.g. `~/.gemini/config/mcp_config.json` or client-specific tool caches) are configured once offline by human operators.
  - **Strict Agent Boundary**: Autonomous agent workflows must never attempt to modify or patch files in `~/.gemini` or external client caches.

### 2. `jobspy` (Discovery Feed)
- **Purpose**: Low-level board scraper for Indeed, LinkedIn, ZipRecruiter, and Glassdoor.
- **Server Type**: Python MCPServer
- **Transport**: `stdio`
- **Entrypoint**: `/Users/mouadatfi/Documents/jobspy-mcp/.venv/bin/python /Users/mouadatfi/Documents/jobspy-mcp/server.py`
- **Exposed Tools**:
  - `search_jobs`: Query raw postings by keyword, country, location, and age.

### 3. `playwright` (Configured Browser Automation)
- **Purpose**: Visible, headed browser automation for inspecting ATS applications and filling safe, verified fields.
- **Configured Package Pin**: `@playwright/mcp@0.0.80`
- **Transport**: `stdio` via `npx`
- **Configured Command**: `npx -y @playwright/mcp@0.0.80`
- **Expected Capabilities after Runtime Verification**:
  - Navigation & Inspection: `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_tabs`
  - Interaction: `browser_fill_form`, `browser_click`, `browser_type`, `browser_select_option`, `browser_file_upload`
- **Operational Boundaries**:
  - Headed browser sessions allow direct human visibility.
  - Final submit controls, demographic questions, and legal/work authorization disclosures must NEVER be clicked or automated.
  - Interaction ceases upon calling `checkpoint_application`.

### 4. `github` & `cloudflare`
- Pre-existing user configurations maintained without alteration.

The current Gemini MCP configuration contains both `career-memory` and the pinned
`playwright` entry. Verify that both servers start and expose their expected tools in
each Antigravity session. Do not describe a particular live ATS as supported until it
has been checked without submission.

## Recommended User MCP Configuration (`~/.gemini/config/mcp_config.json`)

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
    },
    "playwright": {
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@0.0.80"
      ]
    }
  }
}
```
