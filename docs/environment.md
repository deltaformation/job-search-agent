# Environment Specification & Inspection

This document records the exact system configuration, tooling, and environment details detected on the host machine prior to installation.

## Host System

- **Operating System**: macOS 26.6.2 (Darwin Kernel Version 25.6.0: Fri Jul 31 19:16:20 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T8142)
- **Architecture**: ARM64 (Apple Silicon M-series)
- **CPU Cores**: 10
- **Total Physical Memory**: 16 GB (17,179,869,184 bytes)
- **Current Workspace**: `/Users/mouadatfi/Antigravity/job`
- **User Home Directory**: `/Users/mouadatfi`

## Installed Runtimes & Tooling

| Tool | Version / Location | Status |
| :--- | :--- | :--- |
| **Node.js** | `v26.2.0` (`/Users/mouadatfi/.nvm/versions/node/v26.2.0/bin/node`) | Active & Functional |
| **NPM** | `11.13.0` (`/Users/mouadatfi/.nvm/versions/node/v26.2.0/bin/npm`) | Active & Functional |
| **NPX** | `/Users/mouadatfi/.nvm/versions/node/v26.2.0/bin/npx` | Active & Functional |
| **Python** | `Python 3.11.16` (`/opt/homebrew/opt/python@3.11/libexec/bin/python`) | Active & Functional |
| **Pip** | `/opt/homebrew/opt/python@3.11/libexec/bin/pip` | Active & Functional |
| **PostgreSQL** | `PostgreSQL 16.15` (`/opt/homebrew/opt/postgresql@16/bin/psql`) | Installed & Running |
| **Git** | `git version 2.39.5` (`/opt/homebrew/bin/git`) | Active & Functional |
| **Homebrew** | `/opt/homebrew/bin/brew` (owned by user `mouadatfi:admin`) | Active & Functional |
| **Google Chrome** | `/Applications/Google Chrome.app` | Installed & Available |
| **Docker / Podman** | Not present in PATH | Native PostgreSQL via Homebrew selected |

## Network & Local Ports

- **Port 5432**: Active (PostgreSQL 16 listening on localhost:5432)
- **Port 11434**: Ollama listening (unused; local LLMs avoided per specification)
- **Ports 5000 / 7000**: macOS AirPlay / ControlCenter
- **Antigravity Internal Ports**: 52xxx–59xxx (ephemeral)

## Existing MCP Configuration

Configuration file located at: `/Users/mouadatfi/.gemini/config/mcp_config.json`

Existing servers:
1. `github`: `@modelcontextprotocol/server-github` via npx
2. `cloudflare`: `@cloudflare/mcp-server-cloudflare` via npx
3. `jobspy`: `/Users/mouadatfi/Documents/jobspy-mcp/.venv/bin/python` `/Users/mouadatfi/Documents/jobspy-mcp/server.py`

## Architecture Assumptions

1. **Native over VM**: Running PostgreSQL 16 natively via Homebrew minimizes memory and CPU overhead on a 16GB RAM laptop, avoiding the 4GB+ VM reservation of Docker Desktop. A standard `docker-compose.yml` is provided for container compatibility.
2. **Dedicated Project Virtualenv**: All Python dependencies are contained in `/Users/mouadatfi/Antigravity/job/.venv` using Python 3.11.
3. **No Overwrite of User Config**: Existing MCP servers (`github`, `cloudflare`, `jobspy`) remain intact; new capabilities are cleanly added without disruption.
