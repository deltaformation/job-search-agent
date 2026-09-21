# Documentation Map

## Active v1.0 documentation

- [`../PROJECT.md`](../PROJECT.md): current project entrypoint.
- [`status.md`](status.md): evidence-backed current state and known items.
- [`architecture.md`](architecture.md): runtime, data, state, security, and
  artifact contracts.
- [`operations.md`](operations.md): commands, backup/restore, and runbook
  pointers.
- [`decisions.md`](decisions.md): active ADRs.
- [`ui-ux-design-spec.md`](ui-ux-design-spec.md): visual and interaction
  contract for UI work.

## Active v1.2 alignment material

- [feedback-g-provider-settings.md](feedback-g-provider-settings.md): user-reported G blocker and regression scenarios for provider save/test/key management and worker activation.

- [work-orders-v1.2.md](work-orders-v1.2.md): builder scope, dependencies and assigned work.
- [acceptance-v1.2.md](acceptance-v1.2.md): per-order pass criteria, user journeys and evidence ledger.
- [lifecycle-contracts-v1.2.md](lifecycle-contracts-v1.2.md): technical state/data/upgrade contracts; read relevant sections.
- [execution-log-v1.2.md](execution-log-v1.2.md): active append-only handoffs, prompts and reviews; read relevant recent records.
- [release-context-v1.2.md](release-context-v1.2.md): intent, rationale, PR commentary and old-section map; background on demand.
- [alignment-audit-v1.1.md](alignment-audit-v1.1.md): original evidence for F1–F10; background on demand.
- [work-orders-v1.1.md](work-orders-v1.1.md): preserved execution history.

## Planned Release 1.3

- [work-orders-v1.3.md](work-orders-v1.3.md): architecture, release contract, dependency sequence, and bounded work orders for the production job-board and four-step tailoring-flow overhaul.
- [acceptance-v1.3.md](acceptance-v1.3.md): evidence rules, per-order acceptance criteria, integrated user journeys, checkpoints, and release decision ledger.
- [tailoring-contracts-v1.3.md](tailoring-contracts-v1.3.md): normative Zod/API contracts, UI operation mapping, transaction algorithms, worker fences and assessment definitions; links to exact migration SQL and Drizzle specifications.
- [contracts/v1.3-a-mockup-inventory.md](contracts/v1.3-a-mockup-inventory.md): WO-1.3-A control-by-control mockup → §5 mapping with recorded gaps.
- [contracts/v1.3-a-baseline.md](contracts/v1.3-a-baseline.md): WO-1.3-A migration list, measured query baselines, blockers, v1.2 handoff pointers, and the B contract handoff.
- [contracts/v1.3-b-handoff.md](contracts/v1.3-b-handoff.md): WO-1.3-B persistence/workspace API interfaces, per-order notes, and test evidence for C, E, F, G.
- [contracts/v1.3-step2-correction-contracts.md](contracts/v1.3-step2-correction-contracts.md): WO-1.3-S2-CP-A frozen correction contracts — server-derived provenance, priority links, eligible roles, one Generate transition, 0011 DDL spec, and adversarial pins.

The verified `/mockup` route is the v1.3 interaction reference. It remains fixture-backed and local-state-only; it is not evidence that the production workflow, persistence, worker, artifacts, or review lifecycle are complete.

## Additional Step 2 scope and future ideas

- [step2-scope-v1.3.md](step2-scope-v1.3.md): authorized intake preparation and editable-plan amendment; S2-A–D execute between F and G.
- [step2-correction-scope-v1.3.md](step2-correction-scope-v1.3.md): authorized MAX-only S2-CP-A–C correction sequence for provenance, priority links, eligible roles, one Generate transition and real-flow verification before G.
- [prompts-v1.3-step2-correction.md](prompts-v1.3-step2-correction.md): copy-ready MAX prompts for the sequential S2-CP-A, S2-CP-B and S2-CP-C implementation sessions.
- [roadmap-future.md](roadmap-future.md): unscheduled feedback collection and evaluation dataset; excluded from current build.

## Planned follow-up after v1.2 closure

- [work-order-post-j-elapsed.md](work-order-post-j-elapsed.md): preserved problem record for stable elapsed time, worker progress stages, and actionable failures; folded into WO-1.3-F (R-ADR-023).

- [work-order-post-j-salary.md](work-order-post-j-salary.md): capture explicit JD compensation missed during clipping; Quo regression and existing-job recovery. Planned after J, not an added v1.2 gate.

## Historical material

- [`archive/v1.0/`](archive/v1.0/): frozen rebuild-era work record
  (milestones, work orders, handoffs, acceptance checklist). Read-only;
  do not extend.
- [`legacy/`](legacy/): documentation for the retired Python/PostgreSQL
  implementation. Evidence and migration context only, not the target
  architecture or current plan.
