# Local Job Application Tracker

This repository is being rebuilt as a single-user, local-first application for
preparing and manually tracking job applications.

```text
paste public job URLs
  → scrape and normalize
  → review a truthful tailored resume
  → approve the exact resume version
  → apply manually on the original site
  → manually track Applied / Interviewed / Rejected
```

## Current state

The rebuild specification and project harness are complete enough to begin the
foundation milestone. The target Node/Next.js/SQLite application is **not yet
implemented**. Existing Python/PostgreSQL source remains temporarily as a
behavioral oracle and read-only migration source; its documentation is isolated
under [`docs/legacy/`](docs/legacy/).

Start with [`PROJECT.md`](PROJECT.md) for current status, reading order, and the
next ready work order.

## MVP commitments

- One multiline intake for user-supplied public job URLs.
- Public-page scraping with adapter-first extraction and a guarded Playwright
  fallback.
- Separate raw evidence, normalized job data, and structured agent output.
- Exactly five persisted board columns: `New`, `Tailored`, `Applied`,
  `Interviewed`, and `Rejected`.
- Automatic resume preparation after a successful scrape when profile/provider
  prerequisites exist.
- Immutable, fact-grounded Markdown, DOCX, and PDF resume versions.
- Explicit human approval before a card becomes `Tailored`.
- Manual application, manual post-application status movement, and complete
  event history.
- SQLite plus local filesystem storage, with backup/restore as one integrity
  unit.
- One root command for the web process and worker after one-time setup.

## Explicitly outside MVP

- Searching job boards, alerts, scheduled discovery, or morning briefings.
- Login automation, CAPTCHAs, stealth, proxies, or protection bypasses.
- ATS form filling, protected screening answers, uploads, or final submission.
- Cloud sync, required hosted services, teams, or multi-user permissions.
- Arbitrary AI-authored candidate claims or autonomous resume approval.

## Documentation

- [Product scope and MVP acceptance](docs/product-rebuild/README.md)
- [Architecture and safety contracts](docs/product-rebuild/architecture.md)
- [Milestones](docs/product-rebuild/milestones.md)
- [Coding-agent work orders](docs/product-rebuild/agent-work-orders.md)
- [Active decisions](docs/product-rebuild/decisions.md)
- [Reuse and decommission map](docs/product-rebuild/reuse-map.md)
- [Current status](docs/product-rebuild/status.md)

## Available command today

```text
node scripts/check-project-context.mjs
```

The future `npm run setup`, `npm run dev`, `npm run build`, and `npm run start`
commands become supported only when milestone R1 records passing acceptance
evidence.

## Non-negotiable safety boundary

Every resume statement must come from reviewed candidate data with immutable
provenance. Unsupported job requirements remain visible gaps. Agents and workers
cannot approve resumes or apply to jobs. The human reviews the exact artifacts,
opens the retained source URL, submits manually, and records the outcome.
