# Job Search Operating System (Antigravity + Nimbalyst)

A local-first, MCP-native job-search and application automation system designed to run under **Antigravity** as the primary agent harness and visualized in **Nimbalyst**.

## Core Architecture
- **Reasoning Harness**: Google Antigravity (Gemini)
- **Visual Workspace**: Nimbalyst (Multi-editor, Kanban, Session tracker)
- **Local Persistence**: PostgreSQL 16 (`job_system`)
- **MCP Server**: FastMCP `career-memory`
- **Scraping**: Multi-board JobSpy wrapper (LinkedIn, Indeed, Glassdoor, ZipRecruiter)
- **Resume Tailoring**: Fact-ID provenance engine with WeasyPrint ATS PDF renderer
- **Application Copilot**: Guarded Playwright browser automation with mandatory human takeover
