# Candidate import fixtures (R4-A)

## `master-resume.v1.json`

Reviewed conversion of the synthetic seed `db/seeds/001_candidate_seed.sql`
into `candidate-import/v1`. Like the seed, this file is **synthetic test
data**: disposable fixture values (including an `@example.com` address),
never verified career memory. Field mapping:

| Seed table/column | Import field |
|---|---|
| `candidate_profile` identity columns | `identity` |
| `candidate_profile.target_titles/target_locations` | `targetTitles`/`targetLocations` |
| `candidate_profile.summary` | `summary` |
| `work_experience` rows (UUIDs become stable `emp-*` slugs) | `employment[]` |
| `achievements` rows (`fact_id`, category, text, technologies, metrics, verification, source) | `achievements[]`, `fact_id` values preserved verbatim |
| `skills` rows | `skills[]` |
| `education` rows | `education[]` |
| (seed has no credentials) | `credentials: []` |

Intentionally **not** converted: `preferences` (work authorization,
compensation) and `standard_answers`. The MVP never auto-answers legal,
work-authorization, compensation, or self-identification questions, so the
import schema refuses to carry them. Real profile data enters only through
a human-authored file at an ignored path such as
`data/candidate/master-resume.json`, never through this fixture.
