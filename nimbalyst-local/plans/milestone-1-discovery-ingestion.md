---
planStatus:
  planId: "pln_01J7BH8328QHHCPTNBJG7KKMWD"
  title: "Milestone 1: Local Job Discovery & Ingestion"
  status: "completed"
  planType: "feature"
  priority: "critical"
  progress: 100
  owner: "Antigravity"
  tags: ["discovery", "jobspy", "postgresql", "mcp"]
  created: "2026-09-01"
  updated: "2026-09-02T18:00:00.000Z"
---

# Milestone 1: Local Job Discovery & Ingestion

## Overview
A local-first, multi-board job scraper and ingestion engine that interfaces with PostgreSQL 16 and exposes core capabilities to Antigravity via FastMCP.

## Key Deliverables
- **JobSpy Multi-Board Scraper**: Unified wrapper scraping LinkedIn, Indeed, Glassdoor, and ZipRecruiter with anti-blocking and jitter.
- **5-Signal Deduplication**: Robust fingerprinting (canonical URL, normalized company, job title, clean location, description hash) preserving multi-board provenance in `job_sources`.
- **Posting Age & Freshness Bucketing**: Classification into `HOT` (0-24h), `FRESH` (24-48h), `RECENT` (48-72h), and `STALE` (>72h).
- **PostgreSQL 16 Schema**: Migration-managed tables for jobs, sources, raw postings, and candidate profiles.
- **FastMCP Stdio Server**: Native tool integration (`career-memory`) exposing `get_jobs_feed`, `get_job_details`, `update_job_status`, and `search_and_ingest_jobs`.
