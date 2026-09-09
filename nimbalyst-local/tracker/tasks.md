# Project Work Board

This is the single Kanban source for milestones and executable work. Completed implementation details stay searchable but are archived so the default board remains focused.

## Milestones

- [x] Milestone 1: Discovery & Ingestion #project-work[id:wrk_01K4Q8ABCDEF1234567890GHA1 status:done kind:milestone milestone:m1 priority:critical created:2026-09-08]
- [x] Milestone 2: Truthful Resume Engine #project-work[id:wrk_01K4Q8ABCDEF1234567890GHA2 status:done kind:milestone milestone:m2 priority:critical created:2026-09-08]
- [x] Milestone 3: Guarded Application Copilot #project-work[id:wrk_01K4Q8ABCDEF1234567890GHA3 status:done kind:milestone milestone:m3 priority:critical created:2026-09-09]
- [x] Milestone 4: Evidence & Preparation Contract #project-work[id:wrk_01K4Q8ABCDEF1234567890GHA4 status:done kind:milestone milestone:m4 priority:high created:2026-09-09]
- [x] Milestone 5: Local Control Service & Bridge #project-work[id:wrk_01K4Q8ABCDEF1234567890GHA5 status:done kind:milestone milestone:m5 priority:high created:2026-09-09]
- [ ] Milestone 6: Morning Job Radar #project-work[id:wrk_01K4Q8ABCDEF1234567890GHA6 status:in-progress kind:milestone milestone:m6 priority:high created:2026-09-09]
  - Backend implementation and scheduled briefing integration are verified; human scheduler activation remains open.

## Milestone 6: Current Work

- [ ] Activate the 07:30 America/Toronto workflow in the human-selected scheduler and verify one real run #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ2 status:blocked kind:task milestone:m6 priority:medium created:2026-09-09]
  - Human choice required. Configuration expresses the intended schedule but is not proof of activation.

## Future Backlog

- [ ] Implement audio briefing podcast synthesis via text-to-speech #project-work[id:wrk_01M23VWF0KASZJ5D3S9JGDXW61 status:backlog kind:task milestone:future priority:low created:2026-09-09]
- [ ] Add Greenhouse and Lever specific auto-fill parsers for the copilot #project-work[id:wrk_01M23VWFZVJE4DPJN8ZCPN26VW status:backlog kind:task milestone:future priority:medium created:2026-09-09]
- [ ] Add email notification digests for urgent high-match opportunities #project-work[id:wrk_01M23VWGZ3STG7499KHM834SY0 status:backlog kind:task milestone:future priority:low created:2026-09-09]

## Archived Completion Evidence

### Milestone 1

- [x] Set up PostgreSQL 16 schema and initial migrations #project-work[id:wrk_01M1F8PQ0K442GJFCD87CGM0N2 status:done kind:task milestone:m1 priority:critical created:2026-09-08 archived:true]
- [x] Implement JobSpy multi-board scraper wrapper with rate-limit backoff #project-work[id:wrk_01M1HV3E0KF9H58F3WNBSEX9SF status:done kind:task milestone:m1 priority:high created:2026-09-08 archived:true]
- [x] Build 5-signal job deduplicator preserving multi-source provenance #project-work[id:wrk_01M1HV3E0K5S3EQ1QTS7XZV2TK status:done kind:task milestone:m1 priority:high created:2026-09-08 archived:true]
- [x] Implement posting age calculation with HOT, FRESH, RECENT, and STALE buckets #project-work[id:wrk_01M1MDG50K3NSS8WBRMRXA0NBB status:done kind:task milestone:m1 priority:medium created:2026-09-08 archived:true]
- [x] Implement FastMCP career-memory server with stdio transport #project-work[id:wrk_01M1MDG50KJDS1E950GA5X0F20 status:done kind:task milestone:m1 priority:critical created:2026-09-08 archived:true]

### Milestone 2

- [x] Build candidate memory with canonical fact-ID verification #project-work[id:wrk_01M1PZWW0KNRM6PG736HSV9QJ4 status:done kind:task milestone:m2 priority:critical created:2026-09-08 archived:true]
- [x] Create strict fact-integrity enforcement #project-work[id:wrk_01M1PZWW0KKKXY35BZ14RK60PW status:done kind:task milestone:m2 priority:critical created:2026-09-08 archived:true]
- [x] Implement ATS-friendly PDF resume rendering #project-work[id:wrk_01M1SJ9K0KQJSEPTKE6K4R3W72 status:done kind:task milestone:m2 priority:high created:2026-09-08 archived:true]
- [x] Build immutable resume versions with SHA256 integrity metadata #project-work[id:wrk_01M1SJ9K0KR4P4GD720HJBMQVZ status:done kind:task milestone:m2 priority:high created:2026-09-08 archived:true]
- [x] Add the interactive human-only resume review command #project-work[id:wrk_01M1SJ9K0KF99ZR1V5MW4VPJ65 status:done kind:task milestone:m2 priority:critical created:2026-09-08 archived:true]

### Milestone 3

- [x] Implement Playwright browser integration for guarded navigation #project-work[id:wrk_01M1W4PA0KWVWG0D9138J75V08 status:done kind:task milestone:m3 priority:high created:2026-09-09 archived:true]
- [x] Define deterministic SAFE, HUMAN_REVIEW, and PROHIBITED field policy #project-work[id:wrk_01M1W4PA0KKG6G2HVMFQ9HKJEJ status:done kind:task milestone:m3 priority:critical created:2026-09-09 archived:true]
- [x] Enforce the WAITING_FOR_HUMAN checkpoint #project-work[id:wrk_01M1W4PA0KQBAVTWZZKKNWW1VT status:done kind:task milestone:m3 priority:critical created:2026-09-09 archived:true]
- [x] Validate approved resume digests and reject symlinks or traversal #project-work[id:wrk_01M1YQ310KCNNJVZW2SQC27A7J status:done kind:task milestone:m3 priority:high created:2026-09-09 archived:true]
- [x] Build the interactive human-only outcome recorder #project-work[id:wrk_01M1YQ310KXP9X59XMKA7EFP49 status:done kind:task milestone:m3 priority:high created:2026-09-09 archived:true]

### Milestone 4

- [x] Implement evidence-based candidate fit scoring #project-work[id:wrk_01M1YQ310K11D5ETP7DKPSGVDK status:done kind:task milestone:m4 priority:high created:2026-09-09 archived:true]
- [x] Build explicit supported and unsupported requirement analysis #project-work[id:wrk_01M1YQ310K7E5TN3VJ9HA9Z4X4 status:done kind:task milestone:m4 priority:high created:2026-09-09 archived:true]
- [x] Create auditable, idempotent preparation requests #project-work[id:wrk_01M219FR0KSVJ8WQMK6ZKGG060 status:done kind:task milestone:m4 priority:medium created:2026-09-09 archived:true]

### Milestone 5

- [x] Build the loopback-only control service with secure tokens #project-work[id:wrk_01M219FR0K9TH0P8AW85XJBSVE status:done kind:task milestone:m5 priority:high created:2026-09-09 archived:true]
- [x] Implement scoped UI sessions and status endpoints #project-work[id:wrk_01M219FR0KM126EP0CXQDKR930 status:done kind:task milestone:m5 priority:medium created:2026-09-09 archived:true]
- [x] Build the same-conversation Antigravity bridge adapter #project-work[id:wrk_01M22JP3GKAXZKSZK87WSA7FKG status:done kind:task milestone:m5 priority:high created:2026-09-09 archived:true]

### Milestone 6 Delivered

- [x] Integrate persisted briefing creation with the successful morning scheduled runner #project-work[id:wrk_01M23N0QRKKC6Z51R8BAEEPSMD status:done kind:task milestone:m6 priority:high created:2026-09-09 archived:true]
  - Migration 013 binds one immutable briefing to each discovery run; scheduled-run and dry-run behavior are covered by the 165-test suite.
- [x] Add immutable job briefing persistence in migration 012 #project-work[id:wrk_01M237998KNQFB3DW0Y1V5319H status:done kind:task milestone:m6 priority:high created:2026-09-09 archived:true]
- [x] Implement the briefing generation service #project-work[id:wrk_01M23AQ4WKNPPJMYZFJRQPYSN2 status:done kind:task milestone:m6 priority:high created:2026-09-09 archived:true]
- [x] Build the accessible morning dashboard and safe batch preparation #project-work[id:wrk_01M23E50GKZF520STA7CQMQRER status:done kind:task milestone:m6 priority:high created:2026-09-09 archived:true]
- [x] Expose briefing creation and retrieval through MCP and the local API #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ1 status:done kind:task milestone:m6 priority:high created:2026-09-09 archived:true]
- [x] Add end-to-end morning dashboard contract tests #project-work[id:wrk_01M23REKCKR42SNDX0PV3Q9TAT status:done kind:task milestone:m6 priority:high created:2026-09-09 archived:true]

### Workspace Migration

- [x] Normalize Nimbalyst project tracking onto one workflow #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ3 status:done kind:task milestone:workspace priority:high created:2026-09-09 archived:true]
- [x] Add evidence-backed project documents and the shared agent handoff #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ4 status:done kind:task milestone:workspace priority:high created:2026-09-09 archived:true]
- [x] Add a non-destructive workspace consistency checker #project-work[id:wrk_01K4Q8ABCDEF1234567890GHJ5 status:done kind:task milestone:workspace priority:medium created:2026-09-09 archived:true]
