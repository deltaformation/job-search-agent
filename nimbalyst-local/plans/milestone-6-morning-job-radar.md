---
planStatus:
  planId: "pln_01J7BH87YGY57VT6JT62ZZFHCQ"
  title: "Milestone 6: Morning Job Radar & Daily Briefing View"
  status: "in-development"
  planType: "feature"
  priority: "high"
  progress: 85
  owner: "Antigravity"
  tags: ["briefing", "radar", "dashboard", "morning-routine"]
  created: "2026-09-09"
  updated: "2026-09-09T15:00:00.000Z"
---

# Milestone 6: Morning Job Radar & Daily Briefing View

## Overview
A morning command-center dashboard and daily briefing generator that presents fresh high-fit opportunities discovered overnight, organized for fast human triaging, review, and single-click application prep.

## Key Deliverables
- **Job Briefings Persistence**: Database migration `012_job_briefings.sql` storing daily digests and candidate notes.
- **Briefing Generator Service**: `services/briefing/service.py` curating top matches, classifying posting age, and highlighting key match reasons.
- **Morning Dashboard View**: `services/ui/briefing_view.py` rendering interactive job cards with score badges, gap summaries, and direct review actions.
- **Automated Scheduling Integration**: Daily cron trigger for 08:00 AM local time.
