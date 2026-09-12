# Local Job Tracker Rebuild

This is the human and coding-agent entrypoint for project state.

## Read in order

1. [`docs/product-rebuild/status.md`](docs/product-rebuild/status.md) — what is
   true now and what is ready next.
2. [`docs/product-rebuild/README.md`](docs/product-rebuild/README.md) — product
   scope and end-to-end MVP definition.
3. [`docs/product-rebuild/architecture.md`](docs/product-rebuild/architecture.md)
   — data, state, safety, and runtime contracts.
4. [`docs/product-rebuild/milestones.md`](docs/product-rebuild/milestones.md) —
   delivery gates.
5. [`docs/product-rebuild/agent-work-orders.md`](docs/product-rebuild/agent-work-orders.md)
   — bounded implementation ownership.
6. [`docs/product-rebuild/decisions.md`](docs/product-rebuild/decisions.md) —
   active architectural decisions.

`AGENTS.md` contains mandatory execution and human-safety rules.

## Current reality

The local Node.js/Next.js/SQLite application is the active product runtime.
Milestones R1 through R5-B are complete; legacy Python and PostgreSQL
runtimes have been retired and removed from the active tree.

## Project truth order

1. Verified candidate facts, immutable snapshots/approvals, and artifact hashes.
2. Current code, migrations, database state, and generated files.
3. Reproducible test or human-acceptance evidence tied to the current revision.
4. `status.md` as a concise projection of that evidence.
5. Plans and historical documents.

## Starting a coding session

- Select one ready work order and verify its dependencies.
- Inspect the working tree before editing; preserve unrelated changes.
- Use a branch/worktree when parallel changes could overlap.
- Finish with the handoff format in `AGENTS.md` and exact verification results.

Validate the active project harness with:

```text
node scripts/check-project-context.mjs
```
