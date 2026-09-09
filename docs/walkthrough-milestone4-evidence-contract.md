# Walkthrough: Milestone 4 - Evidence and Preparation Contract

## Overview

Milestone 4 establishes an immutable, explicit evidence and preparation contract across discovery, intelligence, document generation, and MCP server layers. It unifies requirement representations into a canonical schema, eliminates silent fallbacks, enforces snapshot lineage for resumes, adds fact-backed keyword coverage, and introduces idempotent preparation request orchestration.

---

## Changes by Component

### 1. Canonical Requirement Model (`services/intelligence/models.py`)
- Created `CanonicalRequirement` Pydantic model with strict validation:
  - Requires `evidence_fact_ids` and exact `evidence_quotes` for `MATCHED` and `PARTIAL` statuses.
  - Forbids evidence IDs for `UNSUPPORTED` and `GAP` statuses to prevent false coverage claims.
  - Rejects `matched_fact_ids` on persistence; legacy inputs are converted to `evidence_fact_ids` and stripped.
  - Automatically defaults agent-generated analyses to `review_status="proposed"`.
  - Added `KeywordCoverageResult` and `PreparationRequestModel` definitions and transition validators.

### 2. Snapshot Lineage & Document Validation (`services/documents/`)
- **`validator.py`**:
  - Validates candidate snapshot identity against canonical memory.
  - Verifies exact JD quotations against the JD snapshot.
  - Verifies exact evidence quotations against approved candidate facts.
  - Rejects claims referencing unapproved or foreign facts.
- **`pipeline.py` & `tailor.py`**:
  - Removed document pipeline fallback that generated application resumes without an `analysis_id`.
  - Rejects resume generation when JD snapshot, candidate snapshot, or analysis binding is missing or stale.
  - Tailor ranks and emphasizes facts backed by `evidence_fact_ids`.

### 3. Transparent Keyword Coverage (`services/intelligence/scorer.py`)
- Added `calculate_keyword_coverage` providing reproducible term matching:
  - Distinguishes verified skills from approved candidate facts (`fact_*`).
  - Separates required requirements from preferred requirements (preferred terms are excluded from the required denominator).
  - Returns coverage percentage, matched terms, unsupported terms, source fact IDs, and algorithm version.
  - Persisted in `job_scores.keyword_coverage`.

### 4. Preparation Request Orchestration (`db/migrations/010_job_control_center.sql` & `services/memory/repository.py`)
- Added `preparation_requests` table with `UNIQUE(job_id, idempotency_key)` constraint.
- State machine: `QUEUED -> ANALYZING -> TAILORING -> READY_FOR_REVIEW` (plus `BLOCKED`, `FAILED`, `SUPERSEDED`).
- Implemented repository methods with `FOR UPDATE` row locking:
  - `create_preparation_request(job_id, idempotency_key, requested_by, briefing_id)`
  - `get_preparation_request(request_id)`
  - `get_preparation_request_by_idempotency(job_id, idempotency_key)`
  - `update_preparation_request_status(request_id, status, ...)`
  - `list_preparation_requests(job_id, status, limit)`

### 5. FastMCP Server Integration (`services/mcp/server.py`)
- Added `create_preparation_request` and `get_preparation_status` tools.
- Preserved `prepare_application` strictly for post-approval ATS workflows.
- Strictly excluded resume approval from MCP tools to maintain the human review boundary.

---

## Verification & Test Results

The milestone is validated by 23 dedicated tests in `tests/test_milestone4_evidence_contract.py` alongside repository and document regressions:

- `test_canonical_requirement_serialization`: Verified canonical field names and values.
- `test_canonical_requirement_legacy_matched_fact_ids_stripped`: Confirmed legacy alias is translated and removed.
- `test_canonical_requirement_unsupported_gap_reject_evidence`: Verified unsupported requirements cannot carry evidence IDs.
- `test_canonical_requirement_matched_partial_require_evidence`: Verified positive matches require fact citations.
- `test_evidence_fact_ids_affect_resume_fact_ranking`: Verified fact ordering prioritizes matched requirements.
- `test_resume_generation_rejects_missing_analysis_id`: Verified fail-closed behavior when analysis ID is omitted.
- `test_resume_generation_rejects_stale_mismatched_snapshots`: Verified rejection of mismatched JD/candidate snapshots.
- `test_keyword_coverage_verified_vs_unverified_terms`: Verified factual attribution in keyword matching.
- `test_preparation_request_idempotency_and_transitions`: Verified unique constraint, retry safety, and lifecycle transitions.

```bash
.venv/bin/pytest tests/test_milestone4_evidence_contract.py tests/test_repository.py tests/test_milestone2_regressions.py
============================== 58 passed in 2.99s ==============================
```
