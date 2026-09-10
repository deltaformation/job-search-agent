# Job Search Operating System

This is the shared project dashboard for Codex and Gemini/Antigravity sessions running in Nimbalyst. The product is local-first: PostgreSQL and verified artifacts hold runtime truth, while these files make delivery state, evidence, and next work visible to humans and agents.

## Current milestone status

| Milestone | Status | Progress | Evidence | Remaining work |
|---|---:|---:|---|---|
| 1. Discovery & ingestion | Completed | 100% | Commit `f50e877`; discovery, normalization, dedupe, freshness, MCP, and tests | None |
| 2. Truthful resume engine | Completed | 100% | Commits `2f0db9e`, `c62678b`; provenance, immutable versions, PDF rendering, human review | None |
| 3. Guarded application copilot | Completed | 100% | Commit `e4dfab4`; readiness, field policy, ATS fixtures, checkpoint and audit tests | None |
| 4. Evidence & preparation contract | Completed | 100% | Commit `79cc6de`; validated analysis lineage, evidence scoring, preparation requests | None |
| 5. Local control bridge | Completed | 100% | Commit `9259b9f`; loopback service, scoped sessions, outbox, Antigravity adapter | None |
| 6. Morning job radar | In development | 95% | Commit `e1bcb7b`; migrations 012-013, run-bound scheduled briefings, hardened dashboard, MCP/API integration, tests | Human selects/activates the scheduler and verifies one real run |

Last verified on 2026-09-09: `.venv/bin/pytest tests/ -q` completed with **165 passed** and 7 deprecation warnings.

Current rehearsal UX hardening has passing coverage for the attached rehearsal lifecycle, cleanup ownership, bounded job diagnostics, MCP schema synchronization, and CLI analysis safety. The latest regression run completed with **175 passed and 1 headless-browser PDF test deselected** because test authorization was limited to local PostgreSQL access.

## Core architecture

- **Workspace and coordination**: One Nimbalyst `project-work` Kanban, readable plan/milestone documents, sessions, and optional worktrees.
- **Reasoning clients**: Codex and Gemini/Antigravity. Either may analyze, implement, review, or operate the system within the same safety rules.
- **Deterministic core**: Python 3.11 services for discovery, normalization, scoring, document generation, application policy, briefings, and local UI control.
- **Persistence**: Local PostgreSQL 16 database `job_system` with migration and audit history.
- **Tool boundary**: FastMCP `career-memory` exposes candidate facts, job state, scoring, tailoring, application preparation, and morning briefing tools.
- **Provider-specific edge**: `integrations/antigravity/` delivers same-conversation notifications for Antigravity. It does not make Antigravity the owner of core state.

## Source-of-truth order

When sources disagree, use this order:

1. Verified candidate facts, immutable snapshots, approvals, and workflow state in PostgreSQL.
2. Checked-in implementation, migrations, tests, and immutable generated artifacts.
3. The unified `project-work` tracker and the matching milestone/plan document metadata as the project-status projection.
4. Historical implementation plans and conversation summaries.

Never promote a task or milestone because an agent said it was complete. Record the concrete file, migration, command result, or commit that proves it.

## Hard human boundaries

- Never invent candidate facts or fill a job requirement with unsupported experience.
- Every resume claim must map to verified `fact_id` evidence; gaps remain explicit.
- Never run `scripts/review_resume.py` or assert `human_confirmed=True` autonomously.
- Never submit a job application or answer legal, work-authorization, salary, or voluntary self-identification questions for the user.
- Browser automation stops at `WAITING_FOR_HUMAN`; only the human records the final application outcome.

## Where to work

- Start with [agent-handoff.md](agent-handoff.md) and [tracker/tasks.md](tracker/tasks.md).
- Use [tracker/tasks.md](tracker/tasks.md) for the single Kanban workflow. Filter by `kind` or `milestone` instead of creating another tracker type.
- Open `milestones/` and `plans/` for readable delivery details and acceptance evidence; they intentionally do not create extra Kanban columns.
- Use [ai-actions.md](ai-actions.md) for reusable session prompts.
- Run `scripts/populate_nimbalyst.py --check` after editing project-control files.
