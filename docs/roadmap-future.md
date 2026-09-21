# Potential future roadmap

## Tailoring feedback and evaluation dataset

**Status:** candidate / unscheduled; captured 2026-09-17. Not a v1.3 Step 2 acceptance requirement and not authorized for implementation by WO-1.3-S2-A–D.

Allow the user to rate a tailoring result good/bad and optionally explain why. Link feedback to the exact retained JD, captured master/profile version, tailored resume version, preparation plan, user edits, and provider/model/prompt/policy versions. Build a local collection of real examples for regression evaluation and future extraction/tailoring improvements.

Before scheduling: define feedback granularity (whole result or specific suggestion), consent for any export, retention/deletion and backup behavior, sensitive-data handling, dataset deduplication and quality labels. Keep feedback separate from factual verification and human resume approval. No automatic uploads, training or master-fact edits.

Current Step 2 work preserves ordinary immutable lineage useful to this feature; do not add feedback tables, screens or telemetry now. Fixed implementation test fixtures are still required independently of this potential module.
