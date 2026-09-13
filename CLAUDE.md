# Claude Project Entry Point

Follow `AGENTS.md` as the mandatory repository contract.

Before changing code, read the v1.0 core context in this order:

1. `PROJECT.md`
2. `docs/status.md`
3. `docs/architecture.md`
4. `docs/operations.md`
5. `docs/decisions.md` for the area you touch

Nimbalyst is retired. Do not create or update Nimbalyst project-control files.
The rebuild-era work record is frozen at `docs/archive/v1.0/`; Git history is
the long-term archive.

Inspect the actual repository and tests before trusting any completion claim.
The product runtime is Node/TypeScript/Next.js/SQLite; the Python/PostgreSQL
system was retired and removed at v1.0.

Always inspect canonical schema definitions in `src/db/schema/*` before
running diagnostic queries or scripts. Never guess table names, column names,
or enum values via trial-and-error CLI commands.
