# Release 1.3 — Step 2 correction scope

**Status:** authorized planning target, 2026-09-18.
**Execution:** MAX agent only, sequentially: S2-CP-A → S2-CP-B → S2-CP-C → user checkpoint.
**Boundary:** correction work occurs after S2-D and before G. G, H and I remain held.

This scope replaces only the S2-D behavior named below. Existing persisted
formats and completed evidence remain historical compatibility targets. New
semantics require new versioned contracts; do not reinterpret old bytes.

## 1. Product decisions

1. The user is the authority for text they deliberately edit. A user edit is
   allowed into the generated resume and is never blocked merely because the
   system cannot prove it from candidate evidence.
2. User-authored text is preserved verbatim and visibly labeled **User edit**.
   It is not described as verified, provider-grounded or machine-supported.
3. AI suggestions remain proposals. The app must show their candidate-source
   anchors and the JD priority phrases they address. Selecting **Use** records
   **AI suggestion — accepted by user**; it does not turn the prose into a
   machine-verified fact.
4. Exact master-resume text and allowlisted deterministic derivations may be
   labeled **Verified source** when their approved fact lineage is intact.
5. The provider cannot set human authorship, user acceptance, evidence status,
   scores or eligibility. The server derives provenance from the saved editor
   operation, exact text comparison and immutable source identities.
6. Provenance describes how text entered this job-local draft. It is not an
   authentication claim or a substitute for the later explicit resume approval.
7. Job-local edits never mutate the master resume or candidate profile.

## 2. Provenance and evidence contract

Every included summary or experience segment freezes one server-derived value:

| Provenance | Trigger | May generate? | Counts as machine-verified? | Review label |
|---|---|---:|---:|---|
| `VERIFIED_SOURCE` | Exact approved master text or allowlisted derivation | yes | yes | Verified source |
| `USER_ACCEPTED_AI` | Exact accepted plan suggestion/angle selected by the user | yes | no | AI suggestion · accepted |
| `USER_EDITED` | Saved text differs from its master/plan origin | yes | no | User edit |

- Each segment retains its origin ID, anchor fact IDs, linked priority IDs,
  exact text hash and saved operation ID. Anchors provide context and lineage;
  they do not assert that arbitrary prose is entailed by the facts.
- A user edit may add a metric, technology or responsibility. Keep it
  non-blocking and user-labeled. Existing structural, ownership, size, control
  character and immutable-binding checks still block invalid input.
- An AI suggestion may not render unless the user explicitly selected it. It
  must pass deterministic structural safeguards: valid role ownership, valid
  source anchors, no foreign employer attribution, and exact links to one or
  more persisted JD priorities. These safeguards establish traceability, not
  semantic proof.
- The evidence-integrity assessment reports verified-source coverage and
  separate counts for user-authored/user-accepted text. Neither non-verified
  category inflates the verified numerator or denominator.
- A provider response that declares itself verified, approved or user-authored
  is rejected or ignored at the trust boundary.

## 3. Priority-to-suggestion and role eligibility contract

- Every positioning option and experience suggestion links to one or more
  immutable priority phrase IDs from the same accepted plan. The UI shows the
  linked phrases beside the proposal.
- Featured priorities remain 3–5 when enough meaningful requirements exist;
  sparse plans return fewer rather than padding.
- Experience suggestions remain 3–5 overall, not per role.
- `eligibleRoleIds` is server-derived. A suggestion with employment-owned facts
  may target only the employment(s) owning all such facts. A suggestion using
  only transferable profile facts may target any eligible employment. Mixed or
  ambiguous ownership fails closed.
- The UI displays and accepts only eligible target roles for Use, Add, Replace,
  drag/drop and keyboard movement. The save and generation services enforce the
  same rule independently.
- Summary positioning keeps the master summary plus at most two distinct
  plan options. Editing retains the selected origin and anchors even though the
  resulting text becomes `USER_EDITED`.

## 4. Generate transition

Step 2 has one primary action: **Generate resume**.

1. Flush the current draft under workspace CAS.
2. Resolve server-derived provenance and structural validation for the exact
   saved bytes.
3. Freeze the plan, priorities, profile/master/evidence, ordered operations,
   provenance manifest and hashes.
4. Submit the idempotent generation request.
5. Navigate to Step 3 only after an accepted or byte-identical replay response.

Remove the separate Continue path that can navigate to Step 3 without starting
generation. Reads, mount, navigation and autosave never enqueue work.

## 5. Versioned contract target

S2-CP-A must publish exact Zod and persistence contracts before runtime edits.
Use new versions (proposed names below; the contract order may refine fields but
must preserve these semantics):

- `step2-plan/v2`: priority links, source anchors and server-derived eligible
  roles for each angle/suggestion.
- `step2-draft/v3`: stable origin identity and ordered user operations; no
  client-supplied provenance or evidence verdict.
- `step2-validation/v3`: structural results separated from provenance.
- `step2-edited-inputs/v3`: immutable frozen provenance manifest.
- `step2-claims/2`: verified, user-accepted-AI and user-edited categories.

Inspect the migration tree and reserve the next unused migration (currently
after `0010_step2_publish_fence.sql`). Never rewrite 0008–0010 or old hashes.

## 6. Verification target

The correction checkpoint must prove:

- adversarial provider prose cannot become `VERIFIED_SOURCE` from fact IDs,
  token overlap or a provider assertion;
- an edited metric/technology/responsibility generates verbatim as
  `USER_EDITED`, while master and source facts remain unchanged;
- accepting untouched AI prose generates as `USER_ACCEPTED_AI` and is linked to
  the exact selected JD priorities;
- the provider cannot forge either user category;
- foreign-role targeting is absent from the UI and rejected by the server;
- Step 2 has one generation transition, with replay/CAS/no-phantom-queue tests;
- summary evidence uses only its chosen origin/anchors, never the union of all
  unselected options;
- Add/Replace/Exclude order and provenance agree across canonical text,
  Markdown, DOCX and PDF;
- a faithful redacted Lime/master fixture runs intake → live preparation seam →
  edit/reload → explicit generation. Separately record whether an actual remote
  provider call and Chromium PDF visual pass occurred; fixtures cannot satisfy
  those two checks.

## 7. Exclusions and checkpoint

- No feedback-collection module, KeyBERT, Python runtime, Transformers.js,
  approval changes, ATS submission or master-resume mutation.
- Do not start G during these orders. S2-CP-C publishes the exact G–I contract
  amendments implied by provenance-aware assessment and diff, then stops for a
  user walkthrough.
