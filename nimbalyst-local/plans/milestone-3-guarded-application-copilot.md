---
planStatus:
  planId: "pln_01J7BH850RPWAFN8K1HSVDT3Z8"
  title: "Milestone 3: Guarded Application Copilot & Takeover Boundary"
  status: "completed"
  planType: "feature"
  priority: "critical"
  progress: 100
  owner: "Antigravity"
  tags: ["playwright", "copilot", "field-governance", "safety"]
  created: "2026-09-05"
  updated: "2026-09-06T18:00:00.000Z"
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
