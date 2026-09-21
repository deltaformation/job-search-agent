# Release 1.3 — Step 2 scope amendment

Approved product direction: 2026-09-17. Status: planning only. Implement through WO-1.3-S2-A–D between F and G in [work orders](work-orders-v1.3.md). Exact technical contracts are a required S2-A output; this document does not pretend unspecified APIs/DDL already exist.

## 1. Authority / changed contracts

| Previous contract | New target | Owner |
|---|---|---|
| D: deterministic GET recommendations, no additional AI call | Intake schedules worker preparation; GET reads accepted plans with no side effects | S2-A/B |
| E: job-local profile selection and active-version checks | One Settings selection; immutable version captured at intake; later edits affect future intake only | S2-A/B/C |
| E: phrase-to-role steering and summary direction | Exact draft summary and ordered role-specific Add/Replace/Exclude/edit operations, with claim validation | S2-A/C/D |
| ADR-015: extraction enqueues nothing | Extraction may enqueue preparation only; final resume generation stays explicit | S2-A/B |
| Existing 0008/v3 schemas, five generation progress stages | Preserve historical readers; add versioned preparation/editor contracts and separate preparation stages | S2-A/B/D |
| G/H/I and U4 job-local profile switch | Deferred downstream reconciliation after Step 2 checkpoint; U4 is historical baseline, not target UX | S2-D handoff / next planning task |

Existing truthfulness, exact-version approval, application history, security and immutable artifact contracts continue. These exceptions do not reactivate automatic resume generation. Architecture's prohibition on arbitrary claims remains; bounded text editing is not an HTML/template editor.

## 2. Intake and profile binding

- Capture the globally selected profile version and immutable approved-evidence/master inputs when intake accepts new work, before asynchronous scraping. Pin the batch's selection consistently; retries reuse it. Settings retain multiple stored profiles but only one global choice. Editing or switching it changes future intake only.
- Once retained JD exists, prepare a candidate-specific plan using existing cloud provider adapters. No new local Python runtime, KeyBERT or Transformers.js dependency in this increment. Extraction quality is evaluated through fixed fixtures; embeddings remain a later option, not promised implementation.
- Separate preparation lifecycle from scrape outcome, final generation state and board status. Preserve New card on failure. Diagnose/retry at `/intake/batches/[id]`; preparation never creates a resume or moves the card.
- Missing profile/provider does not discard a clip. S2-A specifies explicit recovery: never silently adopt a later default for already accepted work. Existing jobs without captured bindings need an explicit preparation command showing the chosen profile; no automatic mass backfill or paid calls on upgrade. Deduplicated clips reuse existing binding and diagnostic lineage rather than retargeting the job.
- Global profile edits do not stale a legitimately captured plan merely because the active version changed. Actual evidence revocation, corruption, foreign ownership, changed JD or explicit supersession require defined failure/recovery semantics. Freeze evidence and record policy; no stale-evidence bypass.
- Persist accepted plan, exact JD/profile/master identities and hashes, provider/model, schema/prompt/policy versions, attempt provenance and validation result. Secret-free diagnostics. Reuse a saved plan on navigation; no provider call in GET, autosave or an open SQLite transaction.

## 3. Editor behavior

- Profile is visible text with version, Preview and Edit profile; preview resolves captured input. Editing clearly says it affects future queued jobs.
- Priorities: best 3–5 JD phrases, importance independent from candidate support, exact source quotations, Supported / Related experience / Gap badges. Keep meaningful single-token technologies. Additional requirements behind disclosure; fewer than three is allowed when evidence is sparse. Gaps stay visible but cannot insert invented experience.
- Positioning: keep master summary plus up to two distinct evidence-supported angles. Editable proposed summary. No padded or duplicate themes; keep-master selection restores baseline only through explicit action, never overwrites a dirty edit silently.
- Experience: display existing master bullets by role, plus 3–5 high-impact suggestions total. Add is default; Replace names target bullet. Use / Skip / Edit, drag/drop, X exclusion, Undo and keyboard/button equivalents. Drop only into evidence-eligible roles. Changes affect this job's draft only.
- Track stable source/suggestion/draft IDs, origin, role, fact citations, selected action and order. Repeated Use/drop is idempotent. Source bullets are never destroyed; exclusions and replacements are reversible draft operations. A settings edit cannot alter the displayed baseline.
- Save free text without interpreting it as approved evidence. Validation binds exact bytes/normalized hash plus evidence/policy. New edits invalidate old verdicts; late validation cannot bless newer text. Needs evidence content is recoverable and editable, but cannot generate unsupported claims. A factual addition must use the existing explicit evidence-governance path, not an implicit master update.
- Generation uses the accepted edited plan; bullet counts are advisory length guidance surfaced before submission (Resume length notice), never a generation block — only genuine structural/ownership/evidence/CAS/stale-plan/live-run/payload-size failures refuse. Never silently drop chosen additions, reinstate excluded bullets or rewrite approved user wording. All three formats share one canonical projection.

## 4. Scope exclusions and checkpoint

No feedback collection UI/storage, model-training pipeline, semantic-search service, new board columns, auto-approval or legacy drawer cutover. [Future roadmap](roadmap-future.md) holds the feedback idea.

After S2-D, user tests clipping/batch diagnostics, frozen profile preview, phrase quality, positioning, direct edits, add/replace/exclude/undo and saved generation. Then reconcile G–I with the actual implementation and feedback. Existing G–I scope remains parked until that task; no release-complete claim from S2 tests alone.
