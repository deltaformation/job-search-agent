# v1.3 Acceptance Specifications (WO-1.3-A)

Executable specifications for `docs/acceptance-v1.3.md` criteria A1–A6
plus isolated expected-failure pins for the B–G behavior those
criteria anticipate. Written before the production implementation;
each file names its owning work order.

## Convention (from the v1.2 acceptance suite)

- Passing specs use `it(...)`: they prove A-delivered contracts
  (schemas, hashes, inventory, baselines) against the current tree.
- Future-behavior pins use `it.fails(...)`: the suite stays green
  while the gap is real and turns **red the moment the behavior
  starts working** — the owning order must then flip the pin to `it`
  (adapting the call path to the new route/service if needed).
- `it.fails` passes on ANY throw, including a setup bug. Each pin
  therefore carries **exactly one isolated failing assertion**,
  marked with an `EXPECTED FAILURE` comment naming the missing
  behavior, and shares its setup helper with a passing **guard**
  that reproduces the identical path. Pins that can already execute
  the real target assertion against current code (e.g. lease-expiry
  predicates) do so; pins for wholly absent surfaces (routes/tables
  B has not created) fail at a single marked `missingBehavior(...)`
  throw after their green setup assertions.
- Never convert these to `.skip`, narrow their assertions to fit
  current behavior, or delete a pin because its behavior is
  deferred: record an unresolved acceptance item in the ledger
  instead.

## Files and owners

| File | Specs | Owner | Gates |
|---|---|---|---|
| `a1-mockup-inventory.test.tsx` | Every mockup control maps to contracts §5; no production mockup import | WO-1.3-A | A1 |
| `a2-operation-bindings.test.ts` | W/G/R/A/D owners + ADR bindings; no contradictory semantics | WO-1.3-A | A2 |
| `a3-strict-schemas.test.ts` | Strict bounds, extra-field rejection, semantic checks | WO-1.3-A | A3 |
| `a4-assessment-canonical.test.ts` | Canonical assessment bytes; not_assessed rules | WO-1.3-A | A4 |
| `a5-future-behavior.test.ts` | Pins for 412/409/LEASE_LOST/assessment-mismatch/selected-download | WO-1.3-B/F/G/H | A5 |
| `a6-baselines.test.ts` | Query baselines; accessible role/name coverage | WO-1.3-A | A6 |

A pins the behavior; the owning order finalizes APIs, addressing,
and migration details per `docs/tailoring-contracts-v1.3.md`, then
flips each pin to a normal passing test. `WO-1.3-I` runs the full
journey against the flipped suite.
