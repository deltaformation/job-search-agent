# Milestone R5-C — User-Led Manual Acceptance Walkthrough

This 1-page manual acceptance checklist verifies the complete end-to-end local operation of the rebuild across scraping, extraction, compensation badges, AI tailoring, resume review, human approval gate, manual application logging, and backup export.

All UI labels below were verified against the implementation on 2026-09-12.
On any failure, note the step number, what you saw, and any error text —
then stop and report back.

---

## Prerequisites

1. Ensure `.env.local` contains your OpenRouter API key, unquoted:
   ```bash
   OPENROUTER_API_KEY=sk-or-v1-your-key-here
   ```
   (Verified present 2026-09-12. Quote characters would be passed through
   literally to the worker — do not wrap the value in quotes.)
2. Candidate profile v2 must be active with approved facts (verified:
   23 approved facts on 2026-09-12; otherwise run
   `npm run candidate:import -- data/candidate/master-resume.json --activate`).
3. Start the local-first application in your terminal:
   ```bash
   npm run dev
   ```
   *Expected*: Next.js serves `http://127.0.0.1:3000` and the supervised
   background queue worker boots with no errors. (A benign
   typeless-package notice may print; the old module-registration
   deprecation warning is gone.)

---

## 8-Step Walkthrough

### Step 1: Intake a Job Posting
- Navigate to `http://127.0.0.1:3000/intake` and paste a public job posting
  URL (e.g., from Greenhouse, Lever, Ashby, or Workday), then click
  **Queue batch** — or click **Add Job** in the top navigation and use the
  *Quick Add Job URL* dialog.
- **Verify**: The URL is queued, the background worker fetches and extracts
  it, and the batch view links through to the Kanban board.

### Step 2: Verify Kanban Card Badges
- Navigate to `http://127.0.0.1:3000/board`.
- Locate the newly scraped job in the **New** column.
- **Verify**:
  - Company name and job title are cleanly displayed.
  - A prominent salary badge displays the compensation range (e.g.
    `$145k – $195k CAD`, full precision in the drawer). Text-only pay
    passes through verbatim; no badge appears when the posting states
    no pay.

### Step 3: Open Card Workspace Drawer
- Click on the job card to open the slide-over card drawer.
- **Verify**:
  - **Compensation highlights**: structured tags appear (e.g., *RRSP Match*,
    *Health Benefits*, *Annual Bonus*).
  - **Top 5 ATS keywords**: keywords from the JD are badged, split into
    *Evidenced in resume* and *Gaps — not on resume*.

### Step 4: Verify Background AI Tailoring
- Observe the card on the board (no click needed — tailoring starts
  automatically after a successful scrape).
- **Verify**:
  - The card briefly shows *Tailoring in progress…*, then a badge reading
    `Resume v1: Awaiting review` with a *Review Resume →* prompt.
  - (If you see *Tailoring failed (open to retry)* instead, open the card
    and retry once.)

### Step 5: Review Tailored Resume
- In the card drawer, open the **Tailoring & Resumes** tab (or follow
  *Review Resume →* from the card).
- **Verify**:
  - **Files** offers Markdown, DOCX, and PDF, each with working
    Preview/Download links.
  - Side-by-side **Proposed changes** vs **Requirements** shows tailored
    claims with exact JD phrase mirroring, and unsupported requirements
    stay explicit gaps.
  - Truthfulness guarantee: every claim references approved immutable
    `fact_id`s from the candidate profile; gaps appear as gaps and
    nowhere in the files.

### Step 6: Explicit Human Approval Gate
- Click **Approve version 1**, review the artifact list, then click
  **Confirm approval** (optional note).
- **Verify**:
  - The system records your human approval and binds the exact artifact hashes.
  - The job card automatically transitions from **New** to **Tailored** on
    the Kanban board with a *Tailored (v1)* badge, and the version becomes
    immutable.
  - *Invariant*: No autonomous agent can bypass this gate.

### Step 7: Apply & Log Manual Application
- Open the job application link and complete the application on the
  employer's portal.
- Back on the Tailored card, click **Apply & Log** (or drag the card to
  **Applied** — the same dialog opens).
- In **Record application**, confirm the timestamp and optionally enter
  the confirmation number, then **Record application**.
- **Verify**: The card moves to **Applied** with an immutable timestamp
  and audit event.

### Step 8: Backup & Settings Verification
- Click the **Settings** button (gear icon) in the top navigation bar.
- Inspect the sections:
  - **Backup & Restore**: Click **Download Backup**. Verify a timestamped
    `.tar.gz` archive downloads containing the SQLite database, candidate
    profile, and resume artifacts (excluding `.env.local`).
  - **AI & OpenRouter**: Verify primary model
    (`google/gemma-4-26b-a4b-it:free`) and fallback model
    (`nvidia/nemotron-3.5-lightning:free`) are listed, and click
    **Test AI Connection** to verify response latency.
  - **Candidate Profile**: Verify candidate profile facts and skills are
    summarized.

---

## Success Criteria

All 8 steps complete successfully with zero unhandled errors, no console
crashes, and strict enforcement of the local-first truthfulness and
human-approval safety contracts.

## Result

- [ ] All 8 steps passed on ________ (date) — MVP accepted.
- [ ] Step __ failed: ______________________________________________
