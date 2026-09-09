# Playwright MCP Antigravity Workflow Guide

This document describes the orchestration sequence for **Antigravity** when assisting a user with a job application in `READY` status using `@playwright/mcp@0.0.80` and `career-memory`.

---

## Recommended Playwright MCP Configuration
- **Package pin**: `@playwright/mcp@0.0.80` (Official Microsoft Playwright MCP)
- **Transport**: `stdio` via `npx -y @playwright/mcp@0.0.80`
- **Execution Mode**: Headed browser session (visible to the user)
- **Expected Tool Highlights**:
  - `browser_navigate`: Opens the verified application URL.
  - `browser_snapshot`: Captures the accessibility and DOM snapshot.
  - `browser_fill_form`: Fills approved form inputs.
  - `browser_file_upload`: Uploads the bound approved resume PDF.
  - `browser_take_screenshot`: Captures pre-submit visual state for review.

The current Gemini MCP configuration does not contain a Playwright server entry.
Configure and inspect the live server before using this workflow. Synthetic ATS
fixtures validate the repository policy path, but they do not prove that browser
tools are installed or that a real ATS is supported.

---

## Guarded Orchestration Lifecycle

```
[1. PREPARE] -> [2. NAVIGATE] -> [3. SNAPSHOT] -> [4. PLAN] -> [5. FILL & UPLOAD] -> [6. CHECKPOINT & HALT]
                                                                                           |
                                                                                           v
                                                                                  [HUMAN SUBMISSION]
```

### Stage 1: Preparation & Binding
1. Agent calls `career-memory:prepare_application(job_id)`.
2. The server verifies that:
   - Job is in `READY` status.
   - Latest resume version is human-approved.
   - Text and PDF artifact digests on disk match the database ledger.
   - Application URL is a safe HTTPS endpoint.
3. Server returns `application_id`, `attempt_id`, and `application_url`.

### Stage 2: Navigation & Domain Check
1. Agent retrieves scoped context via `career-memory:get_application_context(application_id, attempt_id)`.
2. Agent calls `playwright:browser_navigate(url=application_url)`.
3. Agent checks that final URL is on the expected employer or ATS domain (e.g. `boards.greenhouse.io`, `jobs.lever.co`). If redirected to an unknown or suspicious domain, halt immediately.

### Stage 3: Form Inspection & Snapshot
1. Agent captures the accessibility tree using `playwright:browser_snapshot()`.
2. Agent computes a SHA256 fingerprint of the visible form structure.
3. Agent assigns a stable `field_key` and sanitizes field metadata (`label`, `control_type`, `name`, `options`, `required`).
4. Agent calls `career-memory:record_form_snapshot(attempt_id, page_url, form_fingerprint, fields_metadata)`.

### Stage 4: Deterministic Field Planning
1. Agent proposes a structured field plan mapping form inputs to candidate memory:
   ```json
   {
     "field_key": "first_name",
     "label": "First Name",
     "control_type": "text",
     "risk_class": "safe",
     "proposed_value": "Mouad",
     "source_type": "candidate_profile",
     "decision": "fill"
   }
   ```
2. Agent submits the plan via `career-memory:submit_field_plan(application_id, attempt_id, form_snapshot_id, fields)`.
3. **Deterministic Policy Enforcement**:
   - The validator classifies every field deterministically.
   - Prohibited fields (race, gender, veteran status, legal signatures, passwords) cannot be automated.
   - Human-review fields (work authorization, visa sponsorship, compensation, "why us") are blocked from auto-filling.
   - Proposals that attempt to downgrade risk (e.g. marking work auth as "safe") are strictly rejected.
   - Server returns `allowed_fields` (approved for safe fill) and `blocked_fields` (requiring human review).

### Stage 5: Safe Fill & Resume Upload
1. For each entry in `allowed_fields` where `decision == 'fill'`:
   - Agent fills the input via `playwright:browser_fill_form(fields=[...])`.
2. For the resume file input where `decision == 'upload'`:
   - Agent retrieves the verified `pdf_path` from the approved package.
   - Agent uploads the file via `playwright:browser_file_upload(paths=[pdf_path])`.
3. Agent audits the executed actions via `career-memory:record_application_actions(attempt_id, form_snapshot_id, actions)`.

### Stage 6: Pre-Submit Checkpoint & Human Handoff
1. Agent compiles the pre-submit checkpoint:
   - Any unresolved required fields.
   - Work authorization questions needing human selection.
   - Compensation and voluntary demographic questions.
   - Legal attestation checkboxes.
2. Agent calls `career-memory:checkpoint_application(...)` with the human checklist and stage `pre_submit_review`.
3. **CRITICAL BOUNDARY**:
   - **Agent MUST NOT click Submit, Apply, or any final submission button.**
   - Agent leaves the browser open and visible.
   - Agent notifies the user with the exact checklist of items requiring their personal review.

### Stage 7: Human Outcome Confirmation
1. The human user reviews the form in the visible browser, answers sensitive questions, checks attestations, and clicks Submit.
2. The human user records the observed outcome in the interactive terminal:
   ```bash
   .venv/bin/python scripts/record_application_outcome.py --app-id <UUID>
   ```
3. The script requires explicit typing of `"CONFIRM"` and atomically updates:
   - `applications.status = 'SUBMITTED_CONFIRMED'`
   - `jobs.status = 'SUBMITTED'`
   - Audit logs in `application_events` and `job_events`.
