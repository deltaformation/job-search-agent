# Current Project Operations

## Project-context check

The replacement harness is dependency-free and can be checked before the new
application scaffold exists:

```text
node scripts/check-project-context.mjs
```

## Product commands

The target product commands (`npm run setup`, `npm run dev`, `npm run build`,
and `npm run start`) are planned but not available until milestone R1. Do not
claim or document them as working before their acceptance evidence exists.

## Legacy oracle

The Python/PostgreSQL tree remains temporarily for contract fixtures and later
read-only data import. Its historical runbook is at
[`legacy/operations.md`](legacy/operations.md). Use it only when an assigned work
order explicitly calls for legacy verification, and never run the human-only
resume approval or application outcome commands autonomously.

## Safety

- New tests and development use an isolated temporary or `data/rebuild` root,
  never the user's legacy artifacts/database by default.
- No project operation submits applications, answers protected questions, or
  approves a resume without the human review flow.
- Destructive import/restore/cleanup work requires an exact target, a verified
  backup, and the owning work order.
