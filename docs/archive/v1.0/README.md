> **Archived 2026-09-13 at v1.0.** This directory is the frozen rebuild-era (R0–R6) work record: plans, milestones, work orders, and handoffs. Read-only; do not extend. For current context start at [`AGENTS.md`](../../AGENTS.md) and [`PROJECT.md`](../../PROJECT.md); the durable contracts now live at [`docs/architecture.md`](../../docs/architecture.md), [`docs/decisions.md`](../../docs/decisions.md), and [`docs/ui-ux-design-spec.md`](../../docs/ui-ux-design-spec.md).

# Local Job Tracker Product Rebuild

This directory is the implementation brief for replacing the current
Nimbalyst-managed, Python/PostgreSQL operating system with a focused local job
application tracker.

The target product is a single-user local web application with this primary
flow:

```text
paste public job URLs
        ↓
validate, deduplicate, queue, scrape, normalize
        ↓
New card + immutable source evidence
        ↓
fact-grounded resume proposal + generated artifacts
        ↓
human review and explicit resume approval
        ↓
Tailored card
        ↓
human applies on the original site
        ↓
human moves the card to Applied, Interviewed, or Rejected
```

The rebuild is not a blank-slate rewrite. The current repository contains a
valuable deterministic safety core, especially candidate fact provenance,
snapshot binding, requirement-gap handling, immutable resume versions,
template lineage, artifact hashing, and human approval boundaries. Those
contracts must be ported and proven with parity fixtures before the legacy
runtime is removed.

## Canonical planning documents

1. [Product and architecture contract](../../docs/architecture.md) (promoted to core docs at v1.0)
2. [Current-code reuse and decommission map](reuse-map.md)
3. [Milestones and acceptance gates](milestones.md)
4. [Bounded coding-agent work orders](agent-work-orders.md)

These documents replace Nimbalyst as the planning context for the rebuild.
They are plans, not proof of implementation. Runtime state, tests, generated
artifacts, migrations, and commits remain the evidence of completion.

## Fixed product decisions

- The application is local-first and single-user.
- The product database is SQLite, with local files for raw evidence and resume
  artifacts.
- The product shell is Node.js with TypeScript, Next.js, React, and Tailwind.
- The app is started from the repository root with one command after initial
  dependency/browser installation.
- Only user-supplied, publicly accessible job URLs are scraped in MVP.
- Scrapers never bypass authentication, CAPTCHAs, rate limits, or board
  protections.
- The board has exactly `New`, `Tailored`, `Applied`, `Interviewed`, and
  `Rejected` columns.
- Worker state is separate from board state; scrape or tailoring failures do
  not create extra Kanban columns.
- Resume generation is fact-grounded and versioned. A job cannot become
  `Tailored` until a human approves the exact active resume version.
- Applying and post-application status changes are manual. No MVP component
  fills or submits an ATS form.
- Nimbalyst, the Nimbalyst tracker schema, and the Nimbalyst population checker
  are removed after the current uncommitted work is preserved.

## Definition of MVP complete

MVP is complete only when a clean local checkout can be initialized and the
following scenario passes end to end:

1. Start the application with the documented root command.
2. Paste a valid public job URL and one invalid URL.
3. See the invalid URL rejected and the valid URL queued once, including on a
   repeated submission.
4. See the public page scraped into normalized fields with traceable raw
   evidence and an inspectable scrape attempt.
5. See the job appear in `New` and survive a restart.
6. Generate a structured, fact-grounded resume proposal.
7. See unsupported requirements reported as gaps and absent from resume claims.
8. Preview/download immutable Markdown, DOCX, and PDF artifacts.
9. Approve the exact version as a human and see the card move to `Tailored`.
10. Open the original job URL, apply manually, then manually record `Applied`
    and an optional confirmation number.
11. Move the card to `Interviewed` or `Rejected` and inspect the complete status
    history.
12. Restart the app and verify that jobs, events, evidence, approvals, and
    artifacts remain intact.

No scheduled job discovery, job alerts, login automation, application form
filling, or final submission is required for this acceptance path.
