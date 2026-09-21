# MAX prompts — Step 2 correction sequence

Run these prompts in order with one MAX agent. Do not start the next prompt
until the prior handoff is complete and reviewed. All work happens in
`/Users/mouadatfi/Antigravity/job`.

## Prompt 1 — WO-1.3-S2-CP-A

Implement **WO-1.3-S2-CP-A — Correction contracts and adversarial pins**. Stop
after CP-A; do not implement runtime code or start CP-B/G. Work alone; do not
delegate or parallelize.

Follow `AGENTS.md` and read its required repository context. Then read:

- `docs/work-orders-v1.3.md`: release invariants and S2-CP-A only
- `docs/step2-correction-scope-v1.3.md`: controlling product/engineering scope
- `docs/acceptance-v1.3.md`: S2CPA1–S2CPA5
- `docs/contracts/v1.3-step2-contracts.md` and the S2-D handoff in
  `docs/execution-log-v1.2.md`
- R-ADR-026 in `docs/decisions.md`

First inspect git status, migrations and actual Step 2 domain/policy/generation/UI
code. Preserve every unrelated uncommitted change. Publish
`docs/contracts/v1.3-step2-correction-contracts.md` with exact strict Zod
schemas, canonical hashes, SQL/Drizzle specification, endpoints/statuses,
transactions, compatibility readers and UI-operation mapping. Reserve the next
unused migration after 0010 without applying it.

The contract must derive, server-side, `VERIFIED_SOURCE`, `USER_ACCEPTED_AI`
and `USER_EDITED`; user edits are generatable verbatim and not counted as
machine-verified. Providers/public clients cannot assign provenance, acceptance,
eligible roles, evidence verdicts or scores. Require exact priority links,
source anchors, eligible-role derivation, selected-summary-only anchors and one
Generate transition. Add focused expected-failure pins for every S2CPA row;
ensure failures reach target assertions rather than setup.

Run the focused contract tests plus typecheck, lint and project-context checks.
Update the acceptance ledger with observed evidence and append the mandatory
handoff to `docs/execution-log-v1.2.md`. Stop and state readiness for CP-B.

## Prompt 2 — WO-1.3-S2-CP-B

Implement **WO-1.3-S2-CP-B — Provenance-aware preparation and generation
backend**. Stop after CP-B; do not redesign the UI or start CP-C/G. Work alone;
do not delegate or parallelize.

Follow `AGENTS.md` and read its required repository context. Then read the
completed CP-A contract/handoff, `docs/step2-correction-scope-v1.3.md`, the
S2-CP-B order in `docs/work-orders-v1.3.md`, criteria S2CPB1–S2CPB6 in
`docs/acceptance-v1.3.md`, and R-ADR-026. Inspect git status first and preserve
unrelated changes.

Implement the reserved ordered migration, Drizzle/repositories, immutability
guards, backup/restore/reset and historical readers. Upgrade preparation so AI
angles/suggestions persist exact same-plan priority IDs, valid candidate
anchors and server-derived eligible roles; reject provider trust claims and
foreign ownership. Upgrade workspace/generation resolution so unchanged master
text is `VERIFIED_SOURCE`, explicitly selected unchanged AI text is
`USER_ACCEPTED_AI`, and any saved text change is `USER_EDITED`. User edits,
including unverified metrics, technologies or responsibilities, must save,
freeze and generate verbatim subject only to structural/ownership/size rules.
They must not inflate verified coverage. Preserve only the selected summary
origin/anchors.

Maintain CAS, idempotent replay, retries, lease fencing, immutable versions and
old hashes. Prove adversarial provenance, foreign-role refusal, migration,
compatibility, crash recovery and Markdown/DOCX/PDF parity. Run focused suites,
the full non-browser suite, typecheck, lint and project-context checks. Update
S2CPB evidence and append the mandatory handoff. Stop and state readiness for
CP-C.

## Prompt 3 — WO-1.3-S2-CP-C

Implement **WO-1.3-S2-CP-C — Corrected Step 2 UX and real-flow checkpoint**.
Stop after CP-C; do not start G. Work alone; do not delegate or parallelize.

Follow `AGENTS.md` and read its required repository context. Then read CP-A/B
contracts and latest handoffs, `docs/step2-correction-scope-v1.3.md`, the
S2-CP-C order, S2CPC1–S2CPC6, R-ADR-026, and the S2-D G–I impact report.
Inspect git status first and preserve unrelated changes.

Update Step 2 to show concise `Verified source`, `AI suggestion · accepted`
and `User edit` labels. User edits must not show an evidence blocker or disable
Generate solely for lacking machine support. Show which persisted JD priority
phrases each proposal addresses and expose only server-returned eligible roles
for Add/Replace/drag/keyboard actions. Replace Continue plus Generate with one
primary **Generate resume** action that flushes CAS, resolves/finalizes, freezes,
submits idempotently and enters Step 3 only on accepted/replayed success.
Navigation, mount, autosave and cancel must enqueue nothing.

Add a faithful redacted Lime JD/master fixture and drive real routes plus the
supervised worker through intake → preparation → edit/save/reload → generation.
Record all IDs and hashes. Attempt a configured remote-provider run and a real
Chromium PDF visual check; report each separately and leave environmental
failures BLOCKED rather than substituting fixtures/stubs. Reconcile G–I and U
criteria for provenance-aware assessment/diff/revision and compatibility, then
publish the user walkthrough.

Run focused UI/integration tests, full non-browser suite, typecheck, lint and
project-context checks. Update S2CPC evidence and append the mandatory handoff.
Stop for the user checkpoint with G unstarted.
