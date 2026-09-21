# v1.2 Acceptance Specifications (WO-1.2-A)

Failing-then-passing pins for the v1.2 user journey, written before the
business implementation they require. Each file names its owning work
order and ledger gates; behavior, not call shape, is what must survive.

## Convention (strengthened by the WO-1.2-A correction pass)

- Target-behavior specs use `it.fails(...)`: the suite stays green
  while the gap is real, and turns **red the moment the behavior
  starts working** — the owning order must then flip the spec to `it`
  (adapting the call path to the new command/route if needed).
- `it.fails` passes on ANY throw, including a setup bug. Each pin
  therefore carries **exactly one isolated failing assertion**, marked
  with an `EXPECTED FAILURE` comment naming the missing behavior.
  Setup/precondition code must not contain expects that can fail for
  incidental reasons: setup helpers throw plain errors, and every pin
  shares its setup helper with a passing **guard** that reproduces the
  identical path. A broken setup fails the guard loudly, so a green
  suite with green guards means each pin fails only at its documented
  assertion.
- Post-flip asserts (checks that execute only after the behavior
  lands) may follow an early return behind the isolated assertion;
  they never execute while the pin is red.
- Behavior that is already correct stays a normal passing regression
  test in the same file — pins and regressions are never mixed in one
  test.
- Never convert these to `.skip`, narrow their assertions to fit
  current behavior, or delete a pin because its behavior is deferred:
  record an unresolved acceptance item in the ledger instead.

## Files and owners

| File | Pins | Owner | Gates |
|---|---|---|---|
| `world.ts` | Shared preflight-valid PM-v1 world (helpers, no tests) | WO-1.2-A | — |
| `explicit-generation.test.ts` | Clipping queues zero tailoring work; retries queue nothing | WO-1.2-D | D1 |
| `cross-profile-v2.test.ts` | Cross-profile new-version run bound to the chosen profile; revision binds parent | WO-1.2-D | D2–D3 |
| `guidance-history.test.ts` | Legacy exposes nothing fabricated (passing); review exposes exact guidance; history survives default/profile mutation | WO-1.2-D, WO-1.2-F | F7 row |
| `profile-source-access.test.ts` | Per-profile master bytes; unknown/traversal ids fail (flipped passing by WO-1.2-B) | WO-1.2-B, WO-1.2-C | B1–B2 |

A pins the behavior; the owning order finalizes APIs, addressing, and
migration details per `docs/lifecycle-contracts-v1.2.md`, then flips
each spec to a normal passing test. `WO-1.2-I` runs the full journey
against the flipped suite.
