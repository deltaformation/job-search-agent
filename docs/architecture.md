# Active Architecture

The canonical target architecture is
[`product-rebuild/architecture.md`](product-rebuild/architecture.md).

The rebuild is a Node.js 24 LTS TypeScript modular monolith with a Next.js local
web process, a separately compiled/supervised worker, SQLite/Drizzle persistence,
guarded Playwright extraction, a provider-neutral structured tailoring boundary,
and local evidence/artifact roots.

The target runtime has not been implemented yet. The old Python/PostgreSQL
architecture is quarantined at [`legacy/architecture.md`](legacy/architecture.md)
only as migration history and an executable-contract reference.
