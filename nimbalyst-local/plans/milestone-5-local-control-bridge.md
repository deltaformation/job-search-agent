---
projectDocument:
  type: plan
planId: "pln_01J7BH86Z82EHQBAJDH21M5A94"
title: "Milestone 5: Local Control Service & Same-Conversation Bridge"
status: completed
planType: feature
priority: high
progress: 100
owner: shared-agent-pool
stakeholders: [human, codex, gemini-antigravity]
tags: [service, loopback, outbox, bridge, notifications]
created: "2026-09-09"
updated: "2026-09-09T20:00:00.000Z"
---

# Milestone 5: Local Control Service & Same-Conversation Bridge

## Overview
A lightweight local control service and durable outbox enabling browser views and background workers to report progress safely. The current notification adapter targets Antigravity; the core service remains agent-neutral.

## Key Deliverables
- **Local Control API**: FastAPI service on localhost with token security and structured session control.
- **Worker Session Lifecycle**: Tracking active, completed, and waiting background jobs.
- **Real-Time Event Streaming**: SSE endpoint delivering state changes and human-takeover alerts.
- **Provider Adapter**: `integrations/antigravity/` binds events back to the originating Antigravity conversation without placing provider logic in the domain core.

## Acceptance evidence

- Delivered in commit `9259b9f` with migration `011_ui_sessions_and_actions.sql`.
- Primary files: `services/ui/`, `integrations/antigravity/`, and `scripts/run_control_center.py`.
- Tests verify loopback-only binding, host/origin protection, scoped one-time tokens, idempotency, outbox fencing/retries, conversation isolation, and the absence of approval/submission endpoints.
- Current full-suite verification: 160 tests passed on 2026-09-09.
