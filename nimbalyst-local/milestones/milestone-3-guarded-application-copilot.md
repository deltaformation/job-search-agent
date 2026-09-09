---
projectDocument:
  type: milestone
title: "Milestone 3: Guarded Application Copilot"
status: done
owner: shared-agent-pool
startDate: "2026-09-09"
targetDate: "2026-09-09"
description: "Readiness gates, deterministic field governance, safe browser assistance, immutable checkpoints, and mandatory human submission."
tags: [applications, browser, safety, completed]
---

# Milestone 3: Guarded Application Copilot

Completed in commit `e4dfab4`.

## Outcome

The copilot can prepare a verified application, inspect ATS forms, validate safe field plans, record observed actions, and stop at `WAITING_FOR_HUMAN`. It cannot answer gated disclosures or submit an application.

## Evidence

- `services/applications/`
- `db/migrations/007_application_copilot.sql`
- `db/migrations/008_application_copilot_integrity.sql`
- `docs/playwright_workflow.md`
- `tests/test_application_copilot.py`
- `tests/test_browser_runtime.py`

Detailed delivery record: [Milestone 3 plan](../plans/milestone-3-guarded-application-copilot.md).
