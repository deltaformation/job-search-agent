---
projectDocument:
  type: milestone
title: "Milestone 6: Morning Job Radar"
status: active
owner: shared-agent-pool
startDate: "2026-09-09"
description: "Persisted morning briefings, an accessible local dashboard, safe batch preparation, and scheduled-run integration pending human activation."
tags: [briefing, dashboard, scheduling, active]
---

# Milestone 6: Morning Job Radar

Core implementation landed in commit `e1bcb7b`; review hardening completed the scheduled-run integration. The milestone remains active because external scheduler activation is not yet human-verified.

## Delivered

- Frozen briefing snapshots and discovery-window persistence in migration `012_job_briefings.sql`.
- `BriefingService` for curation, normalization, source health, and Markdown summaries.
- Accessible morning dashboard with scoped, idempotent “Prepare Selected” actions.
- MCP and local API integration.
- `tests/test_milestone6_morning_dashboard.py` covering the implemented contract.
- Migration 013 run binding, real partial-source visibility, atomic batch outbox writes, and dashboard stored-XSS protection.
- Successful non-dry scheduled runs persist one idempotent briefing and emit a scoped dashboard URL when a conversation ID is available.
- Operational UX hardening adds one attached rehearsal command, synchronized checked-in MCP schemas, a bounded read-only job-context diagnostic, owned-process cleanup, nonce-authorized dashboard scripting, and CLI analysis safety checks.
- Full-suite evidence: 165 tests passed on 2026-09-09.

## Remaining

- Human selects and activates the scheduler, then records one observed 07:30 America/Toronto run.
- Human runs the separately authorized headless-browser PDF test and accepts one interactive rehearsal. The PostgreSQL-backed regression run passed 175 tests with that one browser test deselected.

Detailed delivery record: [Milestone 6 plan](../plans/milestone-6-morning-job-radar.md).
