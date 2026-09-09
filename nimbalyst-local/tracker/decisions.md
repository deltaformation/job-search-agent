# Architecture Decision Records (ADR)

## Core Architecture Decisions
- ADR-001: Local-First PostgreSQL 16 as Single Source of Truth #project-work[id:wrk_01J7BH1YS069R8SKHVW90KDJ3S status:done kind:decision milestone:m1 priority:critical created:2026-09-08 archived:true]
  - **Status**: Implemented
  - **Context**: Needed reliable ACID storage for job postings, deduplication fingerprints, and verified candidate career facts.
  - **Decision**: Adopt PostgreSQL 16 (`job_system`) running locally. Avoid cloud vendor lock-in or proprietary storage.

- ADR-002: Antigravity as the Sole Reasoning Harness #project-work[id:wrk_01J7BH1ZR86X7CF4SB6KVZVZNY status:done kind:decision milestone:m1 priority:critical created:2026-09-08 archived:true]
  - **Status**: Implemented historically; superseded by ADR-007 for orchestration ownership.
  - **Context**: Wanted to minimize infrastructure overhead and maximize reasoning capability without managing local Ollama or vLLM instances.
  - **Decision**: Antigravity is the primary LLM reasoning layer and agent harness, interfacing with the system exclusively via FastMCP tools.

- ADR-003: FastMCP Python Server with Native Tool Schemas #project-work[id:wrk_01J7BH20QGMZZB7H07A9H7YRZK status:done kind:decision milestone:m1 priority:high created:2026-09-08 archived:true]
  - **Status**: Implemented
  - **Context**: Need a protocol for compatible agents to discover jobs, score fits, update statuses, and retrieve candidate facts.
  - **Decision**: Implemented FastMCP (`career-memory`) exposing stdio tools without putting model-provider logic in the domain core.

- ADR-004: Strict Fact-ID Provenance Engine (No Hallucinations) #project-work[id:wrk_01J7BH21PR409Z3GHD4N6HH4Y4 status:done kind:decision milestone:m2 priority:critical created:2026-09-08 archived:true]
  - **Status**: Implemented
  - **Context**: Generative resume tools frequently hallucinate credentials, dates, or tools.
  - **Decision**: Every generated bullet point must explicitly trace back to an immutable `fact_id` in candidate memory. Unmatched JD requirements must be labeled as `gap` or `unsupported`.

- ADR-005: Strict Human Takeover Boundary for Application Submission #project-work[id:wrk_01J7BH22P09DPXC9CHN4Q5T38Y status:done kind:decision milestone:m3 priority:critical created:2026-09-09 archived:true]
  - **Status**: Implemented
  - **Context**: Automated bots submitting applications risk violating terms of service, misrepresenting work authorization, or submitting bad data.
  - **Decision**: The agent stops at `WAITING_FOR_HUMAN`. Human must take over in a headed browser to inspect and confirm final submission.

- ADR-006: Immutable Resume Versioning with SHA256 Integrity Checks #project-work[id:wrk_01J7BH23N8XQB660T20ERZQSW0 status:done kind:decision milestone:m2 priority:high created:2026-09-08 archived:true]
  - **Status**: Implemented
  - **Context**: Need auditability and tamper protection for resumes submitted to employers.
  - **Decision**: Approved resumes are locked with SHA256 hashes. Any revision creates a new version; previous reviewed artifacts are never overwritten.

- ADR-007: Nimbalyst as the Multi-Agent Project Control Plane #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ6 status:done kind:decision milestone:workspace priority:high created:2026-09-09 archived:true]
  - **Status**: Implemented
  - **Context**: The project now needs Codex and Gemini/Antigravity sessions to share plans, status, evidence, and handoffs without making either model the owner of runtime truth.
  - **Decision**: Use Nimbalyst for file-backed milestones, plans, trackers, sessions, and worktree coordination. Keep PostgreSQL and verified artifacts authoritative. Treat model providers as interchangeable reasoning clients and keep provider-specific integrations at the edges.
  - **Supersedes**: ADR-002 only with respect to orchestration ownership; existing Antigravity integrations remain supported adapters.

- ADR-008: Evidence-Based Milestone Status Projection #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ7 status:done kind:decision milestone:workspace priority:high created:2026-09-09 archived:true]
  - **Status**: Implemented
  - **Context**: Generated Nimbalyst files had invalid status values and claimed unfinished work was complete or in progress.
  - **Decision**: Milestones and tasks change status only with repository, test, runtime, or human-verification evidence. Configuration expresses intent and is not proof that an external scheduler or live integration is active.
