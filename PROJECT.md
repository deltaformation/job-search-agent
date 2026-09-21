# Local Job Tracker v1.0

This is the human and coding-agent entrypoint for project state.

## Read in order

1. [`docs/status.md`](docs/status.md) — what is true now and what is known next.
2. [`docs/architecture.md`](docs/architecture.md) — data, state, safety, and
   runtime contracts.
3. [`docs/operations.md`](docs/operations.md) — commands, backup/restore, and
   runbook pointers.
4. [`docs/decisions.md`](docs/decisions.md) — active architectural decisions.
5. [`docs/ui-ux-design-spec.md`](docs/ui-ux-design-spec.md) — visual and
   interaction contract for UI work.

`AGENTS.md` contains mandatory execution and human-safety rules. The
rebuild-era work record (milestones, work orders, handoffs) is frozen at
[`docs/archive/v1.0/`](docs/archive/v1.0/).

## Current reality

The local Node.js/Next.js/SQLite application is the v1.0 product runtime:
intake and scraping, a five-column board, truthful resume tailoring with
human approval, backup/restore, and a desktop launcher
(`npm run desktop:app`). Legacy Python and PostgreSQL runtimes were retired
and removed from the active tree.

## Project truth order

1. Verified candidate facts, immutable snapshots/approvals, and artifact hashes.
2. Current code, migrations, database state, and generated files.
3. Reproducible test or human-acceptance evidence tied to the current revision.
4. `docs/status.md` as a concise projection of that evidence.
5. Plans and historical documents.

## Starting a coding session

- State the one bounded task and verify its scope before editing.
- Inspect the working tree before editing; preserve unrelated changes.
- Use a branch/worktree when parallel changes could overlap.
- Read the assigned order in [`docs/work-orders-v1.2.md`](docs/work-orders-v1.2.md)
  and its criteria in [`docs/acceptance-v1.2.md`](docs/acceptance-v1.2.md).
- Finish with the handoff format in `AGENTS.md` and append the task record,
  prompt, and verification results to the active execution log,
  [`docs/execution-log-v1.2.md`](docs/execution-log-v1.2.md)
  ([`docs/work-orders-v1.1.md`](docs/work-orders-v1.1.md) is preserved
  history).

Validate the active project context with:

```text
node scripts/check-project-context.mjs
```
