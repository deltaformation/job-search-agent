# Multi-Agent Handoff Contract

Use this contract for Codex and Gemini/Antigravity sessions launched from Nimbalyst. A session owns a bounded slice of work, not the whole repository.

## Before starting

1. Read `AGENTS.md` and this file.
2. Read `project-summary.md`, the matching milestone document, the matching plan, and the relevant tracker item.
3. Inspect the repository and tests before trusting a completion claim.
4. Set the chosen `project-work` item to `in-progress`. Do not claim a second implementation task unless it is independent.
5. Use a Nimbalyst worktree for parallel implementation when another session may touch the same files.

## While working

- Keep application safety, human consent, and `fact_id` provenance invariant across every provider.
- Use the repository's deterministic services for validation. An agent may propose analysis, but it cannot manufacture verified facts or human consent.
- Record new scope with `#project-work[...]` and the appropriate `kind` instead of silently expanding the active task.
- Record architecture choices in `tracker/decisions.md` with `kind:decision`. If a new choice replaces an old one, preserve the old decision and mark it superseded in its narrative.
- Keep provider-specific code at integration boundaries. Shared domain logic must not depend on a model vendor or session product.

## Finishing a task

1. Run the smallest relevant tests, then the full suite for service or logic changes: `.venv/bin/pytest tests/`.
2. Record the evidence in the matching plan or milestone: files, migration, test result, and commit when available.
3. Move the task to `in-review` when implementation is ready but human or integration verification remains.
4. Move it to `done` only when acceptance criteria are met. External scheduler activation, live ATS behavior, resume approval, and application submission are never inferred from configuration files.
5. Update milestone progress and `project-summary.md` in the same change so Nimbalyst does not drift. Do not add built-in tracker markers or `trackerStatus` frontmatter to reference documents; all Kanban work belongs to `project-work`.

## Handoff note template

Leave this concise note in the task description or linked session:

```text
Objective:
Status: in-progress | in-review | blocked
Changed files:
Verification performed:
Decisions made:
Remaining work:
Safety or human checkpoint:
```

## Current handoff

- Active milestone: Milestone 6, Morning Job Radar.
- Backend status: scheduled runs now create an idempotent, discovery-run-bound briefing; partial board failures remain visible and dashboard job content is escaped.
- Human checkpoint: choose and activate the scheduler in the desired harness, then verify one real 07:30 America/Toronto run. Configuration alone is not activation evidence.
