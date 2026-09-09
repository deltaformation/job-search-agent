---
projectDocument:
  type: milestone
title: "Milestone 5: Local Control Service & Bridge"
status: done
owner: shared-agent-pool
startDate: "2026-09-09"
targetDate: "2026-09-09"
description: "Loopback-only UI sessions, secure action dispatch, durable notifications, and a provider-specific Antigravity bridge."
tags: [control-center, outbox, security, completed]
---

# Milestone 5: Local Control Service & Bridge

Completed in commit `9259b9f`.

## Outcome

The local control service supports scoped, expiring sessions and persist-before-notify actions. The Antigravity sidecar is an edge adapter; Nimbalyst, Codex, or future clients can coordinate around the same domain state without changing core services.

## Evidence

- `services/ui/`
- `integrations/antigravity/`
- `scripts/run_control_center.py`
- `db/migrations/011_ui_sessions_and_actions.sql`
- `tests/test_milestone5_control_service.py`

Detailed delivery record: [Milestone 5 plan](../plans/milestone-5-local-control-bridge.md).
