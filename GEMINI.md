# Gemini and Antigravity Project Entry Point

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

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
