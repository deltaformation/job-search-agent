# Nimbalyst Project Control

This folder is the file-backed control surface for the Job Search Operating System.

- `project-summary.md` is the current dashboard and source-of-truth policy.
- `.nimbalyst/trackers/project-work.yaml` defines the only Kanban lifecycle: Backlog, In Progress, In Review, Blocked, and Done.
- `milestones/` contains readable milestone evidence documents; they do not create extra Kanban columns.
- `plans/` contains the implementation and verification record for each milestone; plans are reference documents rather than a second workflow.
- `tracker/tasks.md` holds visible milestones, current work, backlog, and archived completion evidence.
- `tracker/decisions.md` and `tracker/ideas.md` use the same `project-work` type with `kind:decision` or `kind:idea`.
- `agent-handoff.md` defines how Codex and Gemini/Antigravity sessions coordinate.
- `ai-actions.md` contains reusable prompts for new Nimbalyst sessions.

Run `.venv/bin/python scripts/populate_nimbalyst.py --check` after editing these files. The checker is non-destructive: it rejects legacy tracker types that would reintroduce competing Kanban columns and reports invalid statuses, identifiers, missing documents, and milestone drift.
