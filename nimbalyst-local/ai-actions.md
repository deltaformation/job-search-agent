# Nimbalyst AI Actions

Reusable prompts for Codex or Gemini/Antigravity sessions. Each prompt begins from shared files and preserves the human-review boundaries in `AGENTS.md`.

## Continue the active milestone

Read `AGENTS.md`, `nimbalyst-local/project-summary.md`, `nimbalyst-local/agent-handoff.md`, `nimbalyst-local/milestones/milestone-6-morning-job-radar.md`, and its matching plan. Inspect the open Milestone 6 tracker items and repository state. Claim one bounded backend task, implement it, run the relevant tests and full suite, then update the task, plan, milestone, and dashboard with concrete evidence. Do not install or claim activation of an external scheduler without my explicit choice.

## Review another agent's handoff

Read the linked task and session handoff, inspect its changed files, and verify the stated tests and safety invariants independently. Report concrete findings first. If the implementation is sound, move the task to `in-review`; do not mark it `done` when human or external integration verification is still outstanding.

## Run daily discovery and show the review queue

Run `.venv/bin/python scripts/run_discovery.py --schedule morning_scan`. Continue even if one board fails, then summarize source health, new HOT jobs, pending structured analyses, and final-score candidates. Do not fabricate analysis and do not advance application state without the required evidence and human action.

## Generate the morning briefing

Treat this as an operational user workflow, not an implementation or debugging task. Use the already-available `career-memory` morning briefing tools. Do not search source code, inspect database schemas, run inline Python or direct SQL, launch an unmanaged daemon, or modify generated MCP/client files. If the tool is unavailable, perform at most one documented read-only preflight and return one concise blocker asking for the MCP client to be refreshed; do not repair its registry. Return the persisted briefing identifier, source health, top jobs, explicit gaps, and the scoped local dashboard handoff.

## Inspect one job without approval churn

Run exactly `.venv/bin/python scripts/show_job_context.py --job-id <uuid>`. Use its bounded read-only result for the job, latest analysis, resume provenance, readiness blockers, and current application attempt. Do not query PostgreSQL directly, inspect `information_schema`, guess fields such as `resume_versions.notes`, or use inline `python -c`. This command does not constitute resume approval or application-submission consent.

## Rehearse the workflow safely

Treat the rehearsal as product acceptance, not permission to repair the project. Run exactly `.venv/bin/python scripts/run_rehearsal.py` as one attached process, show its briefing and dashboard, wait while the human completes the checklist, then let it clean up. Use `scripts/show_job_context.py` only when a bounded state check is required. Do not request approval for exploratory shell commands, alter migrations or client caches, or reconstruct the rehearsal with separate setup commands. If its single preflight reports a blocker, stop and report that prerequisite. Never claim `scripts/run_scheduled_scan.py --dry-run` tested the briefing/dashboard path because that mode intentionally omits persisted briefing and session state.

## Verify resume integrity

Inspect the latest generated resume version and its stored provenance. Verify every claim against canonical candidate `fact_id` records, confirm unsupported requirements remain gaps, recompute the stored content and PDF digests, and report any discrepancy. Never run the human approval command or assert human confirmation.

## Check project and database health

Run `.venv/bin/python scripts/check_environment.py`, `.venv/bin/python scripts/migrate.py --status`, `.venv/bin/python scripts/populate_nimbalyst.py --check`, and `.venv/bin/pytest tests/ -q`. Report migration state, test totals, warnings, and any drift between implementation evidence and Nimbalyst status. Do not apply migrations unless the task explicitly includes that change.
