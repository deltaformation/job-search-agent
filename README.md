# Local Job Application Tracker

Single-user, local-first web app for preparing and manually tracking job
applications. Everything runs on your machine: a Next.js UI, a background
worker, SQLite storage, and Playwright for public job pages and PDF output.

```text
clip a job in the browser (or paste URLs)
  → normalize → New
  → generate and review a fact-grounded resume → Tailored
  → apply manually on the original site
  → manually track Applied / Interviewed / Rejected
```

## Quick start

Prerequisites: Node.js 24 (see `.nvmrc`) and npm.

```sh
npm install
npx playwright install chromium
npm run dev
```

Then open <http://127.0.0.1:3000>. One command starts the web app and the
worker together, applies pending SQLite migrations, and shuts both down
cleanly on Ctrl-C.

## Configuration

Copy the settings you need into `.env.local` (never committed):

```sh
# Required for AI resume tailoring and connection diagnostics.
OPENROUTER_API_KEY=your-key-here
```

Without a key the app still runs: intake, scraping, the board, and
backup/restore all work, while tailoring runs report
`PROVIDER_UNAVAILABLE` until a key is configured. Active models are shown
in Settings.

## Everyday commands

```text
npm run dev              develop: web + worker with graceful shutdown
npm run start            production web + worker (runs migrations first)
npm run build            production build
npm test                 unit and integration suite
npm run test:e2e         Playwright product acceptance suite
npm run db:migrate       apply pending SQLite migrations
npm run candidate:import -- <file> [--activate]   import a reviewed
                         candidate master-resume JSON as a new profile version
```

## Backup, restore, and reset

Open Settings (gear icon in the header):

- **Download Full Backup** exports a timestamped `.tar.gz` with the SQLite
  database (checkpointed first), generated resume artifacts, and the
  candidate profile. It never includes `.env.local`.
- **Restore Backup** uploads an archive, saves an automatic pre-restore
  safety copy, verifies the staged database, then swaps it in.
- **Clear All Jobs** wipes jobs and tailoring history after a typed
  confirmation, while keeping the candidate profile and schema.

## Where data lives

All product data stays under ignored local directories:

- `data/rebuild/job-tracker.sqlite` — jobs, board, queue, reviews
- `data/rebuild/evidence/` — raw fetched page evidence
- `data/rebuild/artifacts/` — immutable generated resume versions
- `data/candidate/master-resume.json` — reviewed candidate source file

## Safety boundary

- The app never fills or submits application forms. You open the retained
  job URL, apply yourself, and record the outcome.
- Every resume claim traces to reviewed candidate facts; unsupported job
  requirements stay visible gaps and never enter a resume.
- Only an explicit human approval moves a job to `Tailored`, binding the
  exact reviewed resume version and artifact hashes.
- Only public job pages you supply are fetched; logins, CAPTCHAs, and
  restricted pages stop with a reason code instead of a bypass.

## Documentation

- [Product scope and MVP acceptance](docs/product-rebuild/README.md)
- [Architecture and safety contracts](docs/product-rebuild/architecture.md)
- [Milestones](docs/product-rebuild/milestones.md)
- [Coding-agent work orders](docs/product-rebuild/agent-work-orders.md)
- [Active decisions](docs/product-rebuild/decisions.md)
- [Reuse and decommission map](docs/product-rebuild/reuse-map.md)
- [Current status](docs/product-rebuild/status.md)
