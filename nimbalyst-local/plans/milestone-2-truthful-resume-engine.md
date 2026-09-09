---
projectDocument:
  type: plan
planId: "pln_01J7BH841G71KQA87EEYYDEPQM"
title: "Milestone 2: Truthful Resume Tailoring & ATS Rendering"
status: completed
planType: feature
priority: critical
progress: 100
owner: shared-agent-pool
stakeholders: [human, codex, gemini-antigravity]
tags: [resume, fact-id, provenance, pdf, human-review]
created: "2026-09-08"
updated: "2026-09-09T20:00:00.000Z"
---

# Milestone 2: Truthful Resume Tailoring & ATS Rendering

## Overview
A deterministic, zero-hallucination resume tailoring engine that maps candidate career facts directly to target job requirements, renders ATS-compliant single-page PDFs, and enforces human sign-off before any artifact is approved.

## Key Deliverables
- **Fact-ID Provenance Engine**: Immutable fact registry where every claim, bullet point, technology, and metric maps to a verified `fact_id` (e.g. `fact_001`).
- **Strict Anti-Hallucination Policy**: Hard rules preventing the invention of employers, degrees, dates, clearances, or skills. Unmatched JD requirements are explicitly recorded as `gap`.
- **ATS PDF Rendering**: High-fidelity, parseable PDF generation with clean typographic hierarchy.
- **Tamper-Proof Approval Workflow**: Resumes are versioned immutably and stamped with SHA256 digests.
- **Human Review Boundary**: Interactive CLI (`scripts/review_resume.py`) requiring human approval before marking artifacts `APPROVED`.

## Acceptance evidence

- Delivered in `2f0db9e`; provenance, integrity, and consent regressions corrected in `c62678b` and `087011b`.
- Primary files: `services/documents/`, migrations `002`, `003`, and `009`, `scripts/tailor_resume.py`, `scripts/review_resume.py`.
- Coverage: `test_documents.py`, `test_provenance.py`, `test_milestone2_regressions.py`, and `test_review_resume_cli.py`.
- Current full-suite verification: 160 tests passed on 2026-09-09.

## Permanent boundary

An agent may generate a new immutable resume version, but it may not run the human review command, forge confirmation, overwrite a reviewed artifact, or treat resume approval as permission to submit an application.
