---
name: morning-briefing
description: |
  Orchestrate the Morning Job Briefing workflow for Antigravity.
  Use when the user asks "Good morning, what are the new jobs?", requests a daily update,
  or asks for newly discovered job opportunities.
---

# Morning Job Search Briefing Skill

This skill guides Antigravity to generate a morning job briefing, produce an accessible chat summary and interactive web dashboard from a frozen snapshot, and process human batch preparation decisions.

## Workflow

### 1. Discovery & Analysis Window Check
1. Retrieve or trigger the latest discovery window using MCP `search_and_ingest_jobs` if needed, or query recent agent runs via `get_agent_runs`.
2. Report any per-board discovery errors without aborting other boards (board isolation).
3. If new jobs require requirement analysis, retrieve pending items via `get_pending_analysis` and submit structured requirement analyses via `submit_analysis_version`.

### 2. Generate Briefing Snapshot & Dashboard Session
1. Call MCP tool `create_morning_briefing(schedule_name='morning_scan', window_hours=24.0, limit=20)`.
2. This creates:
   - An immutable `job_briefings` header and frozen `job_briefing_items` snapshots.
   - A purpose-bound local UI session with a one-time redemption URL.
   - A concise Markdown summary table.
3. Output the Markdown table in chat and present the one-time link to the interactive dashboard.
4. **STOP and wait for user selection**. Do not guess or auto-prepare jobs without user selection.

### 3. Processing Selection Actions (`prepare_selected`)
When a `prepare_selected` UI action event arrives via the same-conversation bridge:
1. Parse the action payload:
   ```json
   {
     "briefing_id": "<uuid>",
     "job_ids": ["<uuid>", ...],
     "results": {
       "<uuid>": {"status": "QUEUED", "request_id": "<uuid>"}
     }
   }
   ```
2. For each job in `QUEUED` status:
   - Process requirement analysis if not yet finalized.
   - Generate the tailored resume draft using `get_tailoring_context` and `submit_resume_draft`.
   - Update the preparation request state.
3. Process each job independently: **failure for one selected job must never abort the others**.
4. Report the tailored draft preparation status back to the user in chat.

## Critical Safety Rules
- **No Resume Approval in Morning Briefing**: The briefing dashboard and selection action only prepare drafts (`preparation_requests`). They never approve resumes.
- **No Autonomous Application Submission**: The system must never submit applications.
