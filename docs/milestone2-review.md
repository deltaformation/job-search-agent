# Milestone 2 review and corrections

The implementation in `2f0db9e` allowed unsupported text to pass validation by selecting an unchecked generation strategy or using a summary section. It also supplied a hard-coded eight-year summary, trusted draft role/date fields, merged different roles at the same employer, and exposed human approval as an agent tool.

## Corrected behavior

- Experience and summary claims must quote exactly one approved fact verbatim. Unsupported strategies, empty drafts, malformed claims, altered dates/roles/employers, and fabricated education are rejected. Summaries select an approved fact; they do not infer years of experience.
- Employment grouping uses employment IDs. Missing employment locations and end dates are left blank rather than invented. Only explicitly verified skills are rendered.
- Requirements must quote the current JD exactly. Semantic matches with approved fact references remain `partial` proposals requiring review; valid IDs alone do not establish semantic entailment. JD delimiters are escaped, and downstream draft validation remains mandatory.
- MCP and CLI use the same document pipeline. Versions retain profile/JD snapshot references, baseline text, requirement snapshots, and parent lineage. Database locks serialize per-job version allocation. Content and input snapshots cannot be updated through ordinary SQL updates.
- Rendering failures mark the version failed. Each Chrome process uses an isolated temporary profile. Temporary files are removed, paths are constrained, and published artifacts cannot be overwritten. HTML autoescaping and a content security policy prevent submitted text from becoming active markup.
- Approval is no longer an MCP tool. A person uses `scripts/review_resume.py` in an interactive local terminal after inspecting the document. Approval checks text, HTML, and PDF digests. A failed/unrendered version cannot be approved, approved rows cannot be modified, and a newly generated version starts unapproved.
- The legacy `approval_signature` column stores a deterministic audit receipt, **not a digital signature or proof of identity**. The local OS/user and database administrator remain trusted. Nothing in this workflow authorizes application submission.

## Operations

Apply `db/migrations/003_document_integrity.sql` to an existing Milestone 2 database before using the updated pipeline. It adds integrity metadata and update guards; it does not regenerate documents or approve anything. The full initialization command also runs seeds, so use migration-only execution when upgrading an existing installation.

Generate a draft:

```sh
.venv/bin/python scripts/tailor_resume.py --job-id JOB_UUID
```

Human-operated review (agents must not run this autonomously):

```sh
.venv/bin/python scripts/review_resume.py --resume-id RESUME_UUID --reviewer YOUR_NAME
```

Restart the MCP server to load its updated tool list. Previously exported tool-schema files are not authoritative; remove the obsolete `confirm_human_approval` export if the harness uses cached JSON schemas.

## Existing artifacts and limits

Old generated documents and approval records are retained as historical records. The pasted execution notes show that a programmatic smoke test marked a real resume approved; that is not evidence of human consent. Regenerate and personally review a new version before using those outputs. Existing rows without artifact digests do not qualify for the new approval flow.

This release uses canonical profile records for identity, skills, and education. It does not independently verify whether user-entered canonical career data is true. Arbitrary paraphrasing, complete automatic semantic requirement matching, and cover-letter generation remain outside the implemented workflow. PDF extraction and page limits are compatibility checks, not a guarantee of behavior in every ATS.

## Validation completed

- Full suite: **58 tests passed** (`python -m pytest tests/ --tb=short`), including isolated PostgreSQL integration tests and real Chrome PDF generation.
- Regression coverage includes unsupported generation strategies, altered roles/dates, fabricated summaries and education, requirement quotations, version allocation under concurrency, immutable content, artifact tampering, explicit approval, and rendering failure cleanup.
- Generated PDF text was checked against expected HTML body text; the rendered test document was visually inspected for clipping, overlap, and readability.
- `git diff --check` passed.
- Migration 003 was applied locally without rerunning seeds. Eleven MCP tool schemas were refreshed and the obsolete approval tool schema was removed. Restart the MCP server to load the updated implementation.
