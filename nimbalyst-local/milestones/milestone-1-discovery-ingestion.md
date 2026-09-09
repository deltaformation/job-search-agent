---
projectDocument:
  type: milestone
title: "Milestone 1: Discovery & Ingestion"
status: done
owner: shared-agent-pool
startDate: "2026-09-08"
targetDate: "2026-09-08"
description: "Multi-board discovery, normalization, durable deduplication, freshness, persistence, and MCP access."
tags: [discovery, data-foundation, completed]
---

# Milestone 1: Discovery & Ingestion

Completed in commit `f50e877`, with corrective hardening in `188d62c`.

## Outcome

The system discovers jobs across configured boards, isolates per-board failures, normalizes records, preserves source provenance during five-signal deduplication, calculates freshness, persists canonical jobs, and exposes the feed through `career-memory`.

## Evidence

- `services/discovery/`
- `services/memory/repository.py`
- `db/migrations/001_initial_schema.sql`
- `tests/test_discovery_isolation.py`
- `tests/test_normalizer_and_dedupe.py`
- `tests/test_freshness.py`

Detailed delivery record: [Milestone 1 plan](../plans/milestone-1-discovery-ingestion.md).
