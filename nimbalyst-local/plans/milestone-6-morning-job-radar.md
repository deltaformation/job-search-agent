---
projectDocument:
  type: plan
planId: "pln_01J7BH87YGY57VT6JT62ZZFHCQ"
title: "Milestone 6: Morning Job Radar & Daily Briefing View"
status: in-development
planType: feature
priority: high
progress: 95
owner: shared-agent-pool
stakeholders: [human, codex, gemini-antigravity]
tags: [briefing, radar, dashboard, morning-routine]
created: "2026-09-09"
updated: "2026-09-09T20:00:00.000Z"
---

# Milestone 6: Morning Job Radar & Daily Briefing View

## Overview
A morning command-center dashboard and daily briefing generator that presents fresh high-fit opportunities discovered overnight, organized for fast human triaging, review, and single-click application prep.

## Key Deliverables
- **Job Briefings Persistence**: Database migration `012_job_briefings.sql` storing daily digests and candidate notes.
- **Briefing Generator Service**: `services/briefing/service.py` curating top matches, classifying posting age, and highlighting key match reasons.
- **Morning Dashboard View**: `services/ui/briefing_view.py` rendering interactive job cards with score badges, gap summaries, and direct review actions.
- **Secure Action Integration**: Scoped dashboard sessions and idempotent “Prepare Selected” actions feed the durable outbox.
- **Agent Tools**: MCP tools create and retrieve morning briefings without embedding model reasoning in Python.

## Delivered evidence

- Commit `e1bcb7b` adds migration `012_job_briefings.sql`, `services/briefing/service.py`, `services/ui/briefing_view.py`, MCP/API integration, and `test_milestone6_morning_dashboard.py`.
- Tests cover discovery windows, immutable snapshots, compensation and work-arrangement normalization, partial-source failures, dashboard accessibility, membership validation, mixed batch behavior, notifications, safety endpoints, and MCP tools.
- Review hardening adds migration `013_scheduled_briefing_integrity.sql`, idempotent scheduled-run persistence, real discovery-observation status reporting, atomic batch outbox writes, and stored-XSS protection.
- Rehearsal UX hardening adds `scripts/run_rehearsal.py`, `scripts/show_job_context.py`, synchronized MCP schemas, explicit command-budget rules, cleanup ownership that preserves an existing supervised sidecar, nonce-authorized dashboard scripting, and safe CLI analysis submission.
- Verification passed: 8 focused no-database checks, then 175 PostgreSQL-backed regression tests. One headless-browser PDF compilation test was explicitly deselected because authorization was limited to local PostgreSQL access.
- Current full-suite verification: 165 tests passed on 2026-09-09.

## Remaining work

- Keep `config/schedule.yaml` at the intended 07:30 America/Toronto schedule; do not describe it as active until a real scheduler is registered and observed.
- Human chooses the scheduler/harness and verifies one real run. Do not install cron, a Codex automation, or another scheduler without that choice.
- Run the separately authorized headless-browser PDF compilation test and perform one human acceptance pass through the attached rehearsal command.

## Completion criteria

- [x] The scheduled runner creates exactly one auditable briefing per triggering discovery run, with retry/idempotency behavior tested.
- [x] Dry runs create no briefing or session state.
- One externally scheduled run is observed at the intended local time and its activation is recorded as human-verified.
