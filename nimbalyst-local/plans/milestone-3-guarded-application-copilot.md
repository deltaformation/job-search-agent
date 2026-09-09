---
projectDocument:
  type: plan
planId: "pln_01J7BH850RPWAFN8K1HSVDT3Z8"
title: "Milestone 3: Guarded Application Copilot & Takeover Boundary"
status: completed
planType: feature
priority: critical
progress: 100
owner: shared-agent-pool
stakeholders: [human, codex, gemini-antigravity]
tags: [playwright, copilot, field-governance, safety]
created: "2026-09-09"
updated: "2026-09-09T20:00:00.000Z"
---

# Milestone 3: Guarded Application Copilot & Takeover Boundary

## Overview
A browser-assisted application copilot built on Playwright that navigates ATS portals, pre-fills verified candidate details, enforces strict field governance, and unconditionally halts for human takeover before submission.

## Key Deliverables
- **Deterministic Field Safety Governance**:
  - `SAFE`: Name, email, phone, location, LinkedIn URL, portfolio, and approved resume upload.
  - `HUMAN_REVIEW`: Work authorization, salary expectations, custom screening questions.
  - `PROHIBITED`: Autonomous clicking of final "Submit Application" buttons.
- **Strict Takeover Checkpoint**: The copilot halts in a headed browser at status `WAITING_FOR_HUMAN`. The candidate inspects all fields and performs the final click.
- **SHA256 Approved Artifact Binding**: Forbids unapproved resume versions, symlinks, or path traversal.
- **Interactive Outcome Recorder**: `scripts/record_application_outcome.py` with human TTY confirmation.

## Acceptance evidence

- Delivered in commit `e4dfab4` with migrations `007`-`009`.
- Primary files: `services/applications/`, `services/documents/browser.py`, `docs/playwright_workflow.md`, and the application MCP tools.
- Synthetic Greenhouse, Lever, and generic ATS fixtures verify planning and policy without live submission.
- Current full-suite verification: 160 tests passed on 2026-09-09.

## Permanent boundary

All agents stop at `WAITING_FOR_HUMAN`. Final submission, legal disclosures, work authorization, voluntary self-identification, and human-only outcome recording remain prohibited to automation.
