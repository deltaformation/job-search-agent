# Milestone R5-C — User-Led Manual Acceptance Walkthrough

This 1-page manual acceptance checklist verifies the complete end-to-end local operation of the rebuild across scraping, extraction, compensation badges, AI tailoring, resume review, human approval gate, manual application logging, and backup export.

---

## Prerequisites

1. Ensure `.env.local` contains your OpenRouter API key:
   ```bash
   OPENROUTER_API_KEY="sk-or-v1-..."
   ```
2. Start the local-first application in your terminal:
   ```bash
   npm run dev
   ```
   *Expected output*: Next.js starts on `http://127.0.0.1:3000` and the supervised background queue worker boots on `worker-dev` with 0 deprecation warnings.

---

## 8-Step Walkthrough

### Step 1: Intake a Job Posting
- Navigate to `http://127.0.0.1:3000/intake` (or click **Add Job** in the top navigation).
- Paste a public job posting URL (e.g., from Greenhouse, Lever, Ashby, or Workday).
- Click **Add to Intake**.
- **Verify**: The URL is queued, the background worker fetches and extracts it, and an intake item redirects/links to the Kanban board.

### Step 2: Verify Kanban Card Badges
- Navigate to `http://127.0.0.1:3000/board`.
- Locate the newly scraped job in the **New** column.
- **Verify**:
  - Company name and job title are cleanly displayed.
  - A prominent salary badge displays the compensation range (e.g. `$145k – $195k CAD` or hourly equivalent). If salary is not structured, verified fallback has parsed it from description or AI.

### Step 3: Open Card Workspace Drawer
- Click on the job card to open the slide-over **Card Workspace Drawer**.
- **Verify**:
  - **Compensation Highlights**: Structured tags appear (e.g., *RRSP Match*, *Health Benefits*, *Annual Bonus*).
  - **Top 5 ATS Keywords**: Top keywords extracted from the JD are badged with match indicators.

### Step 4: Verify Background AI Tailoring
- Observe the card on the board or in the drawer.
- **Verify**:
  - The worker automatically claims the `TAILOR` task.
  - The card updates with a badge: `Resumes (1) · Awaiting Review`.

### Step 5: Review Tailored Resume
- In the Card Drawer, navigate to the **Resume** tab (or click **Review Resume**).
- **Verify**:
  - Side-by-side comparison displays tailored claims and exact JD phrase mirroring.
  - Truthfulness guarantee: Every claim references approved immutable `fact_id`s from the candidate profile; unsupported JD requirements remain explicit gaps.
  - Markdown, DOCX, and PDF download buttons are active.

### Step 6: Explicit Human Approval Gate
- Click **Approve Resume**.
- **Verify**:
  - The system records your human approval and binds the exact artifact hashes.
  - The job card automatically transitions from **New** to **Tailored** on the Kanban board.
  - *Invariant*: No autonomous agent can bypass this gate.

### Step 7: Apply & Log Manual Application
- Open the job application link and complete the application on the employer's portal.
- Back in the Card Drawer, click **Apply & Log** (or drag the card to **Applied**).
- Enter an optional confirmation number or notes, and confirm.
- **Verify**: The card moves to **Applied** with an immutable timestamp and audit event.

### Step 8: Backup & Settings Verification
- Click the **Settings (⚙️)** button in the top navigation bar (`AppHeader`).
- Inspect the tabs:
  - **Data Management**: Click **Download Full Backup**. Verify a timestamped `.tar.gz` archive downloads containing the SQLite database, candidate profile, and resume artifacts (excluding `.env.local`).
  - **AI & Models**: Verify primary model (`google/gemma-4-26b-a4b-it:free`) and fallback model (`nvidia/nemotron-3.5-lightning:free`) are listed, and click **Test AI Connection** to verify response latency.
  - **Candidate Profile**: Verify candidate profile facts and skills are summarized.

---

## Success Criteria

All 8 steps complete successfully with zero unhandled errors, no console crashes, and strict enforcement of the local-first truthfulness and human-approval safety contracts.
