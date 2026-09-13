# Preserved Legacy Baseline

Recorded on 2026-09-11 before removing the Nimbalyst project-control files.
This is preservation context, not a claim that the legacy runtime or unfinished
features are accepted.

## Repository point

- Branch at inspection: `main`
- HEAD: `9ce1a93` (`fix: harden operational rehearsal workflow`)
- Upstream observed: `origin/main` at `8b4122c`
- The working tree was already dirty before the rebuild planning changes.
- Tracked Nimbalyst history remains recoverable through Git. Unique untracked
  Milestone 7/8 planning decisions are summarized below; the actual runtime
  implementation files remain in place.
- Immediately before deletion, the exact final Nimbalyst directories, checker,
  and test were archived outside the repository at
  `/private/tmp/job-nimbalyst-preservation.zrRw3v/nimbalyst-final-state.tgz`.
  Its SHA-256 is
  `70e32cfb0fd58cf31aa221d26855f80376c8fb55f32a5be540aa03f9073578e6`.
  This temporary-machine archive captures modified and untracked project-control
  files that are not present at HEAD.
- The 29 non-Nimbalyst dirty Milestone 7/8 runtime paths were separately
  archived at
  `/private/tmp/job-nimbalyst-preservation.zrRw3v/milestone7-8-runtime-working-tree.tgz`
  with SHA-256
  `b44f8845d652cc0f2b73ba3a519b4e3744b25a81987bcca8c8174645d8332560`.
  This provides recovery independent of the still-dirty working tree without
  committing or resetting the user's changes.
- Both verified archives were then copied to the durable ignored local path
  `data/preservation/2026-09-11/` under the same filenames. Their SHA-256 values
  were rechecked after copying and match those recorded above. The `/private/tmp`
  paths are convenience copies; the `data/preservation` copies are the retained
  local checkpoint.

## Verified historical delivery anchors

The following legacy commits were present in repository history:

| Legacy outcome | Commit |
|---|---|
| Discovery and ingestion | `f50e877` |
| Truthful resume engine | `2f0db9e`, `c62678b` |
| Guarded application copilot | `e4dfab4` |
| Evidence and preparation contract | `79cc6de` |
| Local control service and bridge | `9259b9f` |
| Morning job radar | `e1bcb7b`, hardened by later commits |

These commits prove that code was committed, not that their runtime features
belong in the rebuilt MVP.

## Uncommitted implementation preserved in place

The pre-cleanup working tree contained the following non-Nimbalyst Milestone 7
and 8 additions/changes. They were intentionally not deleted or reset:

### Milestone 7 — agent discovery kickstart

- `services/discovery/agent_workflow.py`
- `services/intelligence/context.py`
- `scripts/run_agent_discovery.py`
- `services/mcp/schemas/get_job_analysis_context.json`
- `services/mcp/schemas/get_next_analysis_context.json`
- `services/mcp/schemas/start_default_discovery.json`
- `tests/test_agent_discovery_kickstart.py`
- Related changes in `services/mcp/server.py` and
  `services/memory/repository.py`

Useful contract to harvest: an immutable, exact-JD/candidate-snapshot input
envelope, deterministic configuration hashing, bounded queue progression, and
schema-constrained agent responses. Automated job discovery itself is deferred
from the rebuilt MVP.

### Milestone 8 — standard resume and evidence-grounded tailoring

- `config/resume.yaml`
- `db/migrations/014_standard_resume_keyword_lineage.sql`
- `services/documents/templates/mouad_standard_v1.html.j2`
- `services/documents/template_registry.py`
- `services/documents/view_model.py`
- `services/documents/keywords.py`
- `services/documents/summary.py`
- `scripts/review_wording_variant.py`
- `tests/test_milestone8_standard_resume.py`
- Related changes in the document pipeline, renderer, tailor, validator,
  application validators/services, MCP server, repository, and provenance tests

Useful contracts to port: trusted allowlisted templates, one canonical view
model, coverage-first fact ranking, evidence-qualified keywords, mechanically
reconstructable summaries, append-only wording variants, immutable lineage,
artifact hashes, and separate human approvals.

## Decisions harvested from uncommitted project-control files

1. **Reference HTML is presentation only.** Reuse visual and semantic layout,
   never its embedded personal content, editing controls, scripts, or injected
   nodes. Generated content comes only from snapshot-bound candidate memory.
2. **JD terminology requires candidate evidence.** Selection, ordering, and
   terminology may use approved facts or separately human-approved variants.
   Unsupported terms remain gaps and never enter the resume.
3. **Summary composition is mechanically reconstructable.** Allow only verbatim
   facts, separately approved variants, or versioned typed templates with a
   persisted manifest that reconstructs output byte-for-byte.
4. **Human visual acceptance was still outstanding.** Existing code/tests did
   not prove that one generated HTML/PDF pair had been reviewed and accepted as
   the standard layout.

These decisions are carried forward by the rebuild architecture, milestones,
and active decision log.

## Test evidence and current limitation

The deleted project-status files claimed that, on 2026-09-10, 26 focused
Milestone 8 tests and a 210-test full suite passed. That result was not
independently reproduced during this cleanup.

On 2026-09-11, a sandboxed full-suite attempt completed with `127 passed`,
`3 failed`, and `80 errors`. The database-backed failures reported that access
to local PostgreSQL on port 5432 was not permitted, and the headless PDF test
could not start its browser in the sandbox. Permission to rerun outside the
sandbox was declined, so the result is recorded as an environment-blocked
baseline, not as proof of a code regression or a passing suite.

## Recovery statement

- Tracked deleted project-control files can be recovered from Git history.
- The final dirty project-control state can be recovered from the external
  archive identified above while that temporary-machine path is retained.
- The dirty Milestone 7/8 runtime files have a separate external archive and
  remain untouched in the repository.
- Untracked Milestone 7/8 implementation remains in the working tree.
- The essential untracked plan decisions and acceptance gaps are preserved in
  this file.
- No candidate profile, database, evidence file, or generated resume artifact
  was intentionally removed during the Nimbalyst cleanup.
