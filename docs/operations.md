# Current Project Operations

## Project-context check

Validate the active documentation harness (required files, local links,
retired-harness absence):

```text
node scripts/check-project-context.mjs
```

## Product commands

```text
npm run dev              develop: web + worker with graceful shutdown
npm run start            production web + worker (runs migrations first)
npm run build            production build
npm test                 unit and integration suite
npm run test:e2e         Playwright product acceptance suite
npm run typecheck        strict TypeScript check
npm run lint             eslint over the repo
npm run db:migrate       apply pending SQLite migrations
npm run candidate:import -- <file> [--activate]   import a reviewed candidate master-resume JSON
npm run desktop:app [-- --dry-run]   build (and install to ~/Desktop) the Job Tracker.app launcher
```

`npm run dev` and `npm run start` apply pending SQLite migrations, supervise
the web and worker processes together, and shut both down cleanly on Ctrl-C.
The app binds loopback-only (`127.0.0.1:3000` by default).

## AI provider configuration

All provider secrets live in `.env.local` only — never in SQLite, Git, logs,
or backups. The active provider is selected by `ACTIVE_AI_PROVIDER`
(`openrouter` default, `google`, `meta`); each provider needs its own key:

```text
OPENROUTER_API_KEY=...   # OpenRouter (default)
GEMINI_API_KEY=...       # Google AI Studio (direct REST)
META_API_KEY=...         # Meta Muse (direct REST)
```

Primary/fallback models per provider are managed in Settings → AI & Models,
which writes `OPENROUTER_MODEL`, `GEMINI_MODEL`, `META_MODEL` (plus
`*_FALLBACK_MODEL`) back to `.env.local`; the Test Connection button pings
the selected provider without exposing keys (the UI shows fingerprints
only). Providers are strictly optional: with no key the app boots, runs
without AI tailoring (reason-coded blocked states), and the deterministic
no-key fallback keeps the pipeline testable.

## Career profiles

Candidate tracks are managed in Settings → Candidate Profile: create named
profiles with work preferences and executive narrative, switch the default,
upload/replace `master-resume.json` (schema-validated before anything is
written), and re-sync into new immutable versions. The CLI import
(`npm run candidate:import`) targets the default profile; tailoring runs
resolve the default unless the drawer guidance selects another profile.
Preferences steer emphasis only and never invent resume facts.

## Backup, restore, and reset

From Settings (gear icon in the header): Download Full Backup (timestamped
`.tar.gz`, never includes `.env.local`), Restore Backup (automatic
pre-restore safety copy, staged verification, atomic swap), Clear All Jobs
(typed confirmation, keeps candidate profile and schema).

## Retired runtimes

The Python/PostgreSQL tree was removed at v1.0; its runbook survives only as
history at [`legacy/operations.md`](legacy/operations.md). Never reinstall a
second database runtime or dual-write path.

## Safety

- New tests and development use an isolated temporary or `data/rebuild` root,
  never another user's live data by default.
- No project operation submits applications, answers protected questions, or
  approves a resume without the human review flow.
- Destructive import/restore/cleanup work requires an exact target and a
  verified backup.
