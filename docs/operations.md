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
npm run candidate:import -- <file> [--profile <id|name>] [--activate] [--json]   import a reviewed candidate master-resume JSON (v1|v2)
npm run desktop:app [-- --dry-run]   build (and install to ~/Desktop) the Job Tracker.app launcher
```

`npm run dev` and `npm run start` apply pending SQLite migrations, supervise
the web and worker processes together, and shut both down cleanly on Ctrl-C.
The app binds loopback-only (`127.0.0.1:3000` by default).

## AI provider configuration

All provider secrets live in `.env.local` only — never in SQLite, Git, logs,
responses, or backups. The active provider is selected by `ACTIVE_AI_PROVIDER`
(`openrouter` default, `google`, `meta`); each provider needs its own key:

```text
OPENROUTER_API_KEY=...   # OpenRouter (default)
GEMINI_API_KEY=...       # Google AI Studio (direct REST)
META_API_KEY=...         # Meta Muse (direct REST)
```

Settings → AI & Models manages providers without terminal work. Per-provider
model chains (Save Models) and write-only API keys (Save Key; blank retains
the stored key, Remove Key needs an explicit confirm) are written to
`.env.local` with owner-only permissions; unrelated entries are preserved.
Test Connection pings the exact entered provider/model/key draft without
saving anything — a blank key field explicitly reuses the stored key — and
reports which model was tested, where the key came from, and an actionable
reason (auth, rate limit, timeout, service error) that keeps the draft.

Saved configuration applies on restart: the dialog distinguishes the draft
selection, the saved file state, the web-active and worker-active
configuration, and shows a restart banner (`<provider> saved — restart
required`) until saved, web, and the last worker report agree. Stop and
restart the app (`npm run dev` / `npm run start`) to activate; if the banner
persists after a restart, a shell-exported variable is overriding the file —
unset it and restart again. Key presence reads “Configured”; only a passing
test reads as a passed test. A passing web test never proves the worker
launch path — the worker starts its own provider command and reports its
view at boot. Providers are strictly optional: with no key the app boots,
runs without AI tailoring (reason-coded blocked states), and the
deterministic no-key fallback keeps the pipeline testable.

## Career profiles

Candidate tracks are managed in Settings → Candidate Profile: create named
profiles with work preferences and executive narrative, switch the default,
upload a validated master document per profile (stored as that version's
immutable source; the legacy single `master-resume.json` is read-only
input preserved as evidence), copy a profile from an existing version,
and re-sync into new immutable versions. The CLI import
(`npm run candidate:import -- <file> [--profile <id|name>]`) targets the
given profile by id or name (default profile otherwise); tailoring runs
resolve the default unless the drawer guidance selects another profile.
Preferences steer emphasis only and never invent resume facts. Backups
include the profile `sources/` tree; reset preserves profiles, facts,
and sources while clearing jobs.

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
