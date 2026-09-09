# Architecture Decision Records (ADR)

## Core Architecture Decisions
- ADR-001: Local-First PostgreSQL 16 as Single Source of Truth #decision[id:dec_01J7BH1YS069R8SKHVW90KDJ3S status:approved priority:critical created:2026-09-01]
  - **Status**: Approved
  - **Context**: Needed reliable ACID storage for job postings, deduplication fingerprints, and verified candidate career facts.
  - **Decision**: Adopt PostgreSQL 16 (`job_system`) running locally. Avoid cloud vendor lock-in or proprietary storage.

- ADR-002: Antigravity as the Sole Reasoning Harness #decision[id:dec_01J7BH1ZR86X7CF4SB6KVZVZNY status:approved priority:critical created:2026-09-01]
  - **Status**: Approved
  - **Context**: Wanted to minimize infrastructure overhead and maximize reasoning capability without managing local Ollama or vLLM instances.
  - **Decision**: Antigravity is the primary LLM reasoning layer and agent harness, interfacing with the system exclusively via FastMCP tools.

- ADR-003: FastMCP Python Server with Native Tool Schemas #decision[id:dec_01J7BH20QGMZZB7H07A9H7YRZK status:approved priority:high created:2026-09-02]
  - **Status**: Approved
  - **Context**: Need a protocol for Antigravity to discover jobs, score fits, update statuses, and retrieve candidate facts.
  - **Decision**: Implemented FastMCP (`career-memory`) exposing stdio tools.

- ADR-004: Strict Fact-ID Provenance Engine (No Hallucinations) #decision[id:dec_01J7BH21PR409Z3GHD4N6HH4Y4 status:approved priority:critical created:2026-09-03]
  - **Status**: Approved
  - **Context**: Generative resume tools frequently hallucinate credentials, dates, or tools.
  - **Decision**: Every generated bullet point must explicitly trace back to an immutable `fact_id` in candidate memory. Unmatched JD requirements must be labeled as `gap` or `unsupported`.

- ADR-005: Strict Human Takeover Boundary for Application Submission #decision[id:dec_01J7BH22P09DPXC9CHN4Q5T38Y status:approved priority:critical created:2026-09-05]
  - **Status**: Approved
  - **Context**: Automated bots submitting applications risk violating terms of service, misrepresenting work authorization, or submitting bad data.
  - **Decision**: The agent stops at `WAITING_FOR_HUMAN`. Human must take over in a headed browser to inspect and confirm final submission.

- ADR-006: Immutable Resume Versioning with SHA256 Integrity Checks #decision[id:dec_01J7BH23N8XQB660T20ERZQSW0 status:approved priority:high created:2026-09-06]
  - **Status**: Approved
  - **Context**: Need auditability and tamper protection for resumes submitted to employers.
  - **Decision**: Approved resumes are locked with SHA256 hashes. Any revision creates a new version; previous reviewed artifacts are never overwritten.
