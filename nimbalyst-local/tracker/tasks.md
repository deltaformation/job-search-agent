# Project Tasks

## Milestone 1: Local Job Discovery & Ingestion (Completed)
- [x] Set up PostgreSQL 16 schema and initial migrations #task[id:tsk_01M1F8PQ0K442GJFCD87CGM0N2 status:done priority:critical created:2026-09-01]
- [x] Implement JobSpy multi-board scraper wrapper with rate-limit backoff #task[id:tsk_01M1HV3E0KF9H58F3WNBSEX9SF status:done priority:high created:2026-09-01]
- [x] Build 5-signal job deduplicator preserving multi-source provenance #task[id:tsk_01M1HV3E0K5S3EQ1QTS7XZV2TK status:done priority:high created:2026-09-02]
- [x] Implement posting age calculation with freshness bucketing (HOT, FRESH, RECENT, STALE) #task[id:tsk_01M1MDG50K3NSS8WBRMRXA0NBB status:done priority:medium created:2026-09-02]
- [x] Implement FastMCP career-memory server with stdio transport #task[id:tsk_01M1MDG50KJDS1E950GA5X0F20 status:done priority:critical created:2026-09-02]

## Milestone 2: Truthful Resume Tailoring & Provenance (Completed)
- [x] Build candidate career memory repository with canonical fact-ID verification #task[id:tsk_01M1PZWW0KNRM6PG736HSV9QJ4 status:done priority:critical created:2026-09-03]
- [x] Create strict fact integrity engine ensuring zero fabricated experience #task[id:tsk_01M1PZWW0KKKXY35BZ14RK60PW status:done priority:critical created:2026-09-03]
- [x] Implement WeasyPrint ATS-friendly PDF resume renderer #task[id:tsk_01M1SJ9K0KQJSEPTKE6K4R3W72 status:done priority:high created:2026-09-04]
- [x] Build tamper-proof resume approval with SHA256 integrity metadata #task[id:tsk_01M1SJ9K0KR4P4GD720HJBMQVZ status:done priority:high created:2026-09-04]
- [x] Add interactive CLI review tool (scripts/review_resume.py) with human-only consent boundary #task[id:tsk_01M1SJ9K0KF99ZR1V5MW4VPJ65 status:done priority:critical created:2026-09-04]

## Milestone 3: Guarded Application Copilot (Completed)
- [x] Implement Playwright browser integration for automated navigation #task[id:tsk_01M1W4PA0KWVWG0D9138J75V08 status:done priority:high created:2026-09-05]
- [x] Define deterministic field safety governance (SAFE, HUMAN_REVIEW, PROHIBITED) #task[id:tsk_01M1W4PA0KKG6G2HVMFQ9HKJEJ status:done priority:critical created:2026-09-05]
- [x] Enforce strict human takeover boundary (WAITING_FOR_HUMAN checkpoint) #task[id:tsk_01M1W4PA0KQBAVTWZZKKNWW1VT status:done priority:critical created:2026-09-05]
- [x] Implement SHA256 digest validation forbidding unapproved or symlinked resumes #task[id:tsk_01M1YQ310KCNNJVZW2SQC27A7J status:done priority:high created:2026-09-06]
- [x] Build interactive application outcome recorder (scripts/record_application_outcome.py) #task[id:tsk_01M1YQ310KXP9X59XMKA7EFP49 status:done priority:high created:2026-09-06]

## Milestone 4: Evidence and Preparation Contract (Completed)
- [x] Implement candidate fit scoring engine evaluating JDs against verified facts #task[id:tsk_01M1YQ310K11D5ETP7DKPSGVDK status:done priority:high created:2026-09-07]
- [x] Build requirement gap analysis explicitly flagging unsupported skills #task[id:tsk_01M1YQ310K7E5TN3VJ9HA9Z4X4 status:done priority:high created:2026-09-07]
- [x] Create interview preparation briefing generator with company research #task[id:tsk_01M219FR0KSVJ8WQMK6ZKGG060 status:done priority:medium created:2026-09-07]

## Milestone 5: Local Control Service and Bridge (Completed)
- [x] Build local control service web server with FastAPI and secure token authentication #task[id:tsk_01M219FR0K9TH0P8AW85XJBSVE status:done priority:high created:2026-09-08]
- [x] Implement background worker session management and status endpoints #task[id:tsk_01M219FR0KM126EP0CXQDKR930 status:done priority:medium created:2026-09-08]
- [x] Build same-conversation agent bridge for Antigravity integration #task[id:tsk_01M22JP3GKAXZKSZK87WSA7FKG status:done priority:high created:2026-09-08]

## Milestone 6: Morning Job Radar & Daily Briefing (In Development)
- [/] Design job briefings database schema and migration 012_job_briefings.sql #task[id:tsk_01M237998KNQFB3DW0Y1V5319H status:in-progress priority:high created:2026-09-09]
- [/] Implement briefing generation service (services/briefing/service.py) #task[id:tsk_01M23AQ4WKNPPJMYZFJRQPYSN2 status:in-progress priority:high created:2026-09-09]
- [/] Build rich morning dashboard view with job cards and actions (services/ui/briefing_view.py) #task[id:tsk_01M23E50GKZF520STA7CQMQRER status:in-progress priority:high created:2026-09-09]
- [ ] Add automated morning radar scheduled trigger in schedule.yaml #task[id:tsk_01M23N0QRKKC6Z51R8BAEEPSMD status:to-do priority:medium created:2026-09-09]
- [ ] Write end-to-end integration tests for morning dashboard (test_milestone6_morning_dashboard.py) #task[id:tsk_01M23REKCKR42SNDX0PV3Q9TAT status:to-do priority:high created:2026-09-09]

## Backlog / Future Enhancements
- [ ] Implement audio briefing podcast synthesis via text-to-speech #task[id:tsk_01M23VWF0KASZJ5D3S9JGDXW61 status:to-do priority:low created:2026-09-09]
- [ ] Add Greenhouse and Lever specific auto-fill parsers for copilot #task[id:tsk_01M23VWFZVJE4DPJN8ZCPN26VW status:to-do priority:medium created:2026-09-09]
- [ ] Add email notification digests for urgent high-match opportunities #task[id:tsk_01M23VWGZ3STG7499KHM834SY0 status:to-do priority:low created:2026-09-09]
