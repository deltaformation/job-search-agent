# Architectural Decision Records (ADRs)

This document tracks all candidate tool evaluations, trade-offs, and final architectural selections for the Job Search Operating System.

---

## ADR 001: Job Discovery Layer Selection

### Context
We required a local-first, multi-source job discovery mechanism targeting Canada (Ontario, GTA, and Remote Canada), supporting recent-posting filters (<=24h, <=72h), source deduplication, canonical URLs, and full job descriptions without relying on commercial SaaS APIs.

### Candidates Evaluated
1. **JobWorkFlow** (`DengNaichen/JobWorkFlow`)
   - *Pros*: Excellent local-first design philosophy; built around FastMCP; integrates JobSpy for scraping.
   - *Cons*: Tightly coupled to SQLite (`data/capture/jobs.db`) and Obsidian markdown frontmatter files as tracker projections; lacks the comprehensive relational audit schema, unified candidate fact store, and multi-faceted fit scoring required.
2. **jobsearch-mcp** (`vijay-prabhu/jobsearch-mcp`, `TadMSTR/jobsearch-mcp`)
   - *Pros*: MCP server interfaces for job querying.
   - *Cons*: Limited country/regional filtering for Canada; heavily relies on external LLM APIs (OpenAI/Anthropic) instead of exposing raw tools to Antigravity.
3. **jobops** (`mohith-das/jobops`, `DaKheera47/job-ops`)
   - *Pros*: CI/CD framing for job search.
   - *Cons*: Immature MCP tool definitions; fragmented dependencies; lacks robust Canadian job board adapters.
4. **JobSpy** (`cullenwatson/JobSpy` / `python-jobspy`)
   - *Pros*: Mature, actively maintained Python library directly scraping LinkedIn, Indeed, Glassdoor, and ZipRecruiter; natively supports country filtering (`Canada`), location filtering (`Ontario`, `Toronto`, `Remote`), age filtering (`hours_old`), and extracts direct employer ATS URLs (`job_url_direct`) alongside full job descriptions. Already verified functional on host.

### Decision
**Adopt JobSpy as the core discovery engine wrapped in a dedicated, high-fidelity discovery service**. We implement:
- Multi-query aggregation (Senior Product Manager, Technical Product Manager, Product Manager, Technical).
- Canadian regional & remote parameterization.
- Clean separation between raw scraping, title/location normalization, URL canonicalization, and deduplication.
- Direct persistence into our PostgreSQL store.

---

## ADR 002: Candidate Memory & Persistence Engine

### Context
Candidate memory requires strict relational integrity: every bullet, metric, and skill must map to an immutable, verified career fact (`fact_id`) with audit state. In addition, jobs, scores, application events, and agent runs must be recorded in an ACID store.

### Candidates Evaluated
1. **SQLite**:
   - *Pros*: Zero server setup, single file.
   - *Cons*: Concurrency limitations during parallel agent operations; weaker JSON query operators compared to PostgreSQL JSONB; lacks robust array and full-text search extensions out of the box.
2. **PostgreSQL 16 (Native Homebrew)**:
   - *Pros*: Native Apple Silicon execution; rich JSONB indexing and constraints; foreign-key cascading and transactional consistency; zero VM memory overhead on a 16GB RAM laptop.
   - *Cons*: Requires local service management (`brew services`).
3. **Docker Compose PostgreSQL**:
   - *Pros*: Containerized portability.
   - *Cons*: Docker is not installed in the host environment; running a Docker VM would consume 3–4GB of RAM unnecessarily.

### Decision
**Implement a custom PostgreSQL 16 schema running natively via Homebrew**. A `docker-compose.yml` is provided for portability, but the native Homebrew service is the primary local runtime.

---

## ADR 003: AI Reasoning & Orchestration Layer

### Context
The user requested an agentic system that analyzes fit, triages jobs, tailors resumes, and drives application workflows.

### Evaluation
External local LLMs (e.g. Ollama, vLLM) or external API keys (OpenAI, Anthropic) introduce latency, hardware contention, and duplicate the intelligence already provided by Antigravity.

### Decision
**Use Antigravity itself as the sole reasoning, planning, and evaluation layer**. All underlying services are exposed via MCP tools (or direct CLI execution), returning structured facts, scores, and context for Antigravity to act upon.

**Status update (2026-09-09): Superseded by ADR 006 for orchestration ownership.** Antigravity remains a supported reasoning client and retains its provider-specific bridge, but it is no longer the sole project harness.

---

## ADR 004: Browser Automation Layer (Milestone 3)

### Candidates Evaluated
1. **Microsoft Playwright MCP** (`@playwright/mcp`):
   - *Pros*: Official Microsoft MCP implementation; uses accessibility tree snapshots; supports structured DOM interaction, screenshot verification, human-in-the-loop pauses.
2. **ExecuteAutomation Playwright MCP** (`@executeautomation/playwright-mcp-server`):
   - *Pros*: High feature count.
   - *Cons*: Community maintained, heavier dependency graph.

### Decision
**Select `@playwright/mcp` as the primary browser automation MCP server**.

---

## ADR 005: Resume Tailoring & Provenance Control (Milestone 2)

### Candidates Evaluated
1. **Tailored / SimplyApply**:
   - Evaluated for local-first ATS compatibility.
   - *Trade-off*: Many existing open-source resume tailor tools inject unverified assertions or lack strict `fact_id` provenance tracking.

### Decision
**Own the document generation and provenance verification pipeline**. Verified candidate facts are stored in PostgreSQL with unique IDs (`fact_001`, `fact_002`, etc.). The tailoring engine requires that every generated bullet explicitly links to a valid `fact_id`. Any requirement not grounded in a verified fact is classified as an explicit gap.

---

## ADR 006: Nimbalyst Multi-Agent Project Control

### Context
The project is now operated through both Codex and Gemini/Antigravity sessions. Milestone state, handoffs, and implementation evidence must be visible to either agent without treating conversation history or a particular model as authoritative.

### Decision
Use Nimbalyst as the file-backed project control plane for milestones, plans, tracker items, sessions, and optional worktrees. Codex and Gemini/Antigravity are interchangeable reasoning clients over the same deterministic Python services and PostgreSQL state. Provider-specific behavior stays in integration adapters such as `integrations/antigravity/`.

Runtime truth remains in PostgreSQL and immutable artifacts. Nimbalyst files are the evidence-backed project-status projection, and configuration alone is not proof that an external integration or scheduler is active.
