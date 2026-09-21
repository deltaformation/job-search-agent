# Lime S2CPC4 fixtures

Faithful redacted fixtures for the WO-1.3-S2-CP-C real-flow checkpoint
(S2CPC4): a real public Lime posting paired with a redacted master record.

## Provenance

- `lime-jd.txt` — verbatim `descriptionText` of `LIME_JOB_FIXTURE` in
  `app/mockup/fixtures/jobDescription.ts` (authentic posting wording for job
  `3f79665a`, batch `69f3ccfd`; a public posting, no personal data).
  Extracted byte-exact by `build-lime-fixtures.py` (no added trailing
  newline); independently verified by importing the TypeScript module in
  Node and comparing digests.
- `lime-master.json` — the authentic Mouad Atfi master record
  (`candidate-import/v2`, 6 roles, 17 achievements) with contact identity
  redacted: `identity.email`, `identity.phone`, `identity.location`
  replaced with `mouad.atfi@example.com`, `+1-647-000-0000`,
  `Toronto, ON, Canada` (same convention as
  `tests/fixtures/candidate/master-resume.v1.json`). Every other byte —
  summary, titles, dates, achievement texts, technologies, metrics,
  skills, education — is verbatim from the ignored local source
  `data/rebuild/sources/local/32a2ce20-*.json` (verified: the transform
  changes exactly the three redacted fields). The `_redaction` key
  documents the substitution and is stripped before candidate import.
- `lime-clip.html` — minimal clip-route page embedding the verbatim JD
  in JSON-LD plus a `<pre>` fallback.

## Digests (sha256 of the committed bytes)

- lime-jd.txt: 364cfc8081ada407ea9585599723204650e666714f75c2eab01a1106b3a9772f
- lime-master.json: a7e8626fb06cbbc09d7670df4cba42ea50419637b1bd027f898e43a395370a28
- lime-clip.html: d375905e4881645141957e6853b94f2ba545bb4bdf838d98b2d40784afefe461
