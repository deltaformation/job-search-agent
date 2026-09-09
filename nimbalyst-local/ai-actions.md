# Nimbalyst AI Actions

Reusable prompts for Codex or Gemini/Antigravity sessions. Each prompt begins from shared files and preserves the human-review boundaries in `AGENTS.md`.

## Continue the active milestone

Read `AGENTS.md`, `nimbalyst-local/project-summary.md`, `nimbalyst-local/agent-handoff.md`, `nimbalyst-local/milestones/milestone-6-morning-job-radar.md`, and its matching plan. Inspect the open Milestone 6 tracker items and repository state. Claim one bounded backend task, implement it, run the relevant tests and full suite, then update the task, plan, milestone, and dashboard with concrete evidence. Do not install or claim activation of an external scheduler without my explicit choice.

## Review another agent's handoff

Read the linked task and session handoff, inspect its changed files, and verify the stated tests and safety invariants independently. Report concrete findings first. If the implementation is sound, move the task to `in-review`; do not mark it `done` when human or external integration verification is still outstanding.

## Run daily discovery and show the review queue

Run `.venv/bin/python scripts/run_discovery.py --schedule morning_scan`. Continue even if one board fails, then summarize source health, new HOT jobs, pending structured analyses, and final-score candidates. Do not fabricate analysis and do not advance application state without the required evidence and human action.

## Generate the morning briefing

Use the `career-memory` morning briefing tools when available. Otherwise call the checked-in backend entrypoint that actually exists; do not pretend importing `services/briefing/service.py` is an operational command. Return the persisted briefing identifier, source health, top jobs, explicit gaps, and the scoped local dashboard handoff.

## Verify resume integrity

Inspect the latest generated resume version and its stored provenance. Verify every claim against canonical candidate `fact_id` records, confirm unsupported requirements remain gaps, recompute the stored content and PDF digests, and report any discrepancy. Never run the human approval command or assert human confirmation.

## Check project and database health

Run `.venv/bin/python scripts/check_environment.py`, `.venv/bin/python scripts/migrate.py --status`, `.venv/bin/python scripts/populate_nimbalyst.py --check`, and `.venv/bin/pytest tests/ -q`. Report migration state, test totals, warnings, and any drift between implementation evidence and Nimbalyst status. Do not apply migrations unless the task explicitly includes that change.
