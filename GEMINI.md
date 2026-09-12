# Gemini and Antigravity Project Entry Point

Follow `AGENTS.md` as the mandatory repository contract.

Before changing code, read the canonical rebuild context in this order:

1. `docs/product-rebuild/README.md`
2. `docs/product-rebuild/architecture.md`
3. `docs/product-rebuild/reuse-map.md`
4. `docs/product-rebuild/milestones.md`
5. The single assigned work order in
   `docs/product-rebuild/agent-work-orders.md`

Nimbalyst is retired. Do not create or update Nimbalyst project-control files.
The Nimbalyst directories were removed by work order R0-B; recovery context is
in `docs/product-rebuild/legacy-baseline.md` and Git history.

Inspect the actual repository and tests before trusting any completion claim.
The target runtime is Node/TypeScript/Next.js/SQLite; the existing
Python/PostgreSQL system remains a temporary executable oracle and import source
until parity and cutover gates pass.

Always inspect canonical schema definitions in `src/persistence/schema.ts` before
running diagnostic queries or scripts. Never guess table names, column names, or
enum values via trial-and-error CLI commands.
