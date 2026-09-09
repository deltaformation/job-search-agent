# MCP Integration & Server Registry

This document details the Model Context Protocol (MCP) servers integrated with Antigravity, their transport protocols, configurations, and available tools.

## Repository Server and Integration Options

### 1. `career-memory`
- **Purpose**: Candidate facts, job pipeline storage, deduplication, fit scoring, document tailoring, and application copilot workflows.
- **Server Type**: FastMCP (Python 3.11)
- **Transport**: `stdio`
- **Entrypoint**: `/Users/mouadatfi/Antigravity/job/.venv/bin/python /Users/mouadatfi/Antigravity/job/services/mcp/server.py`
- **Environment**: Configured in `/Users/mouadatfi/.gemini/config/mcp_config.json`
- **Exposed Tools (23 tools)**:
  - **Discovery & Jobs**: `search_and_ingest_jobs`, `get_jobs_feed`, `get_job_details`, `update_job_status`, `get_agent_runs`
  - **Memory & Intelligence**: `get_candidate_profile`, `score_job_fit`, `get_pending_analysis`, `submit_analysis_version`
  - **Review Queue**: `get_shortlist`, `record_review_decision`, `reserve_shortlist`, `acknowledge_shortlist_delivery`
  - **Documents & Tailoring**: `get_tailoring_context`, `submit_resume_draft`, `get_tailoring_audit`
  - **Application Copilot**:
    - `prepare_application`: Validates job readiness (`READY` status, HTTPS URL, approved resume plain text and compiled PDF artifact digest) and initializes application attempt.
    - `get_application_context`: Provides scoped candidate facts, approved resume version, and target ATS information.
    - `record_form_snapshot`: Stores an immutable snapshot of detected form controls, labels, and layout fingerprints.
    - `submit_field_plan`: Deterministically validates proposed field actions against candidate memory and risk policy (`SAFE`, `HUMAN_REVIEW`, `PROHIBITED`).
    - `record_application_actions`: Records executed browser actions with status and selector audit logs.
    - `checkpoint_application`: Freezes automation, marks job as `WAITING_FOR_HUMAN`, and prepares human takeover summary.
    - `get_application_status`: Queries current application state, the latest attempt, and latest checkpoint.

### 2. `jobspy` (Discovery Feed)
- **Purpose**: Low-level board scraper for Indeed, LinkedIn, ZipRecruiter, and Glassdoor.
- **Server Type**: Python MCPServer
- **Transport**: `stdio`
- **Entrypoint**: `/Users/mouadatfi/Documents/jobspy-mcp/.venv/bin/python /Users/mouadatfi/Documents/jobspy-mcp/server.py`
- **Exposed Tools**:
  - `search_jobs`: Query raw postings by keyword, country, location, and age.

### 3. `playwright` (Optional Browser Automation)
- **Purpose**: Visible, headed browser automation for inspecting ATS applications and filling safe, verified fields.
- **Recommended Package Pin**: `@playwright/mcp@0.0.80`
- **Transport**: `stdio` via `npx`
- **Recommended Command**: `npx -y @playwright/mcp@0.0.80`
- **Expected Capabilities**:
  - Navigation & Inspection: `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_tabs`
  - Interaction: `browser_fill_form`, `browser_click`, `browser_type`, `browser_select_option`, `browser_file_upload`
- **Operational Boundaries**:
  - Headed browser sessions allow direct human visibility.
  - Final submit controls, demographic questions, and legal/work authorization disclosures must NEVER be clicked or automated.
  - Interaction ceases upon calling `checkpoint_application`.

### 4. `github` & `cloudflare`
- Pre-existing user configurations maintained without alteration.

The current Gemini MCP configuration contains `career-memory` but no `playwright`
entry. The application policy, persistence, and synthetic HTML tests are available;
browser orchestration remains unavailable until the user configures and verifies the
optional Playwright server. Do not describe real ATS browser support as operational
until that check succeeds.

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
