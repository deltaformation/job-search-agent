# Step 2 user walkthrough (WO-1.3-S2-CP-C checkpoint)

Corrected Step 2 checklist for the user checkpoint. Supersedes the
S2-D walkthrough in the execution log where they differ (provenance
labels, eligible roles, one Generate exit). G review UI is still
held; nothing here approves a resume or submits an application.

## Before you start

- The app runs locally at `http://127.0.0.1:3000`.
- You apply on the employer's site yourself, then record the outcome
  by hand. The app never fills or submits forms.

## The walkthrough

1. **Clip or paste a job URL on Intake.** The batch row shows scrape
   and preparation states per line. Clipping binds the default
   profile version at accept time; switching the default later never
   re-pins an in-flight job (drift offers an explicit rebind).
2. **If preparation is missing or failed**, open batch diagnostics
   from the line or from Step 2; run preparation or retry as
   offered. Diagnosis names the failure; nothing retries silently.
3. **Open Step 2 for a prepared job.** You see the captured profile
   name/version with Preview (Settings edits affect future intake
   only), priority phrases with Supported/Related/Gap badges and
   byte evidence, keep-master plus up to two supported angles, and
   an editable summary seeded from the master text.
4. **Read the provenance labels.** Untouched master rows show
   `Verified source`. Accepting a suggestion unchanged labels it
   `AI suggestion · accepted`. Anything you reword shows
   `User edit`. Your edits are never called verified, and they are
   never blocked for lacking machine support.
5. **Work the proposals.** Each proposal lists the JD priority
   phrases it addresses. Add (Use), Replace a master bullet, Edit
   text, exclude with X / restore with Undo. Add/Replace/drag/
   keyboard controls offer only the roles the server marked
   eligible for that suggestion; a foreign-role drop is refused
   with guidance and saves nothing. Keyboard and button controls
   persist operations identical to drag/drop.
6. **Read validation honestly.** Structural and size problems are
   actionable and block Generate with named segments. Advisory
   provenance checks never queue work: mount, navigation, autosave,
   validation, and cancel enqueue nothing.
7. **Press Generate resume** (the only exit; no Continue-to-Step-3
   action exists). The app flush-saves the draft, resolves
   validation, freezes the exact bytes, submits, and follows
   progress into Step 3 only after the server accepts. Rebind
   banners, identical replay after network loss, and
   uncertain-submit recovery are explicit; nothing navigates or
   POSTs on its own. A 412 keeps your local input with explicit
   reload/overwrite.
8. **Review progress; approve only by explicit human action**
   (G review UI still held). Apply manually on the retained
   posting; record Applied/Interviewed/Rejected by hand, plus any
   confirmation number.

## Checkpoint limits (verified this round)

- **No live-browser PDF visual proof.** Chromium is installed but
  every launch variant crashes at startup in this sandboxed
  session (headless shell, full Chromium, system Chrome, GPU
  flag variants). Real-Chromium PDF rendering stays BLOCKED;
  unit tests use explicit stub renderers and never substitute.
- **Live provider round trip completed with caveats.** A
  configured remote preparation over the Lime pairing runs
  through the production sidecar and handler and files honest
  terminal outcomes. The configured model only sometimes
  produces proposals whose links repeat priority quotes
  verbatim; unlinked samples are rejected as retryable
  `INVALID_RESPONSE` with no plan and no crash. Re-run with
  `S2CPC_LIVE=1 npx vitest run
  tests/unit/acceptance-v1.3/s2cpc-live.test.ts`.
- **G–I reconciled, G unstarted.** Assessment denominators,
  edited-text diff with op attribution, frozen-profile review
  eligibility, v2 revision round-trip, board/v1-v2 parity, and
  the corrected U4 capture journey are specified in
  `docs/acceptance-v1.3.md` (G/H/I/U rows) and
  `docs/work-orders-v1.3.md` (WO-1.3-G/H/I). No G code exists.
