# Gemini Project Entry Point

Gemini and Antigravity sessions use the same project rules as every other agent.

Before changing code or project status, read:

1. `AGENTS.md` for mandatory engineering and human-safety rules.
2. `nimbalyst-local/project-summary.md` for the verified milestone dashboard.
3. `nimbalyst-local/agent-handoff.md` for task claiming, handoff, and evidence rules.
4. `nimbalyst-local/tracker/tasks.md` for the current work queue.

Do not treat older Gemini-specific implementation plans as current status. PostgreSQL, repository artifacts, tests, and the current Nimbalyst project files are authoritative in that order.

Follow the **Operational Rehearsal UX** rules in `AGENTS.md`: never narrate internal repository exploration, schema inspections, port scans, or debugging steps in user-visible output; never modify `~/.gemini` or external directories during workflows; always emit one concise progress message, followed by the outcome or a single actionable blocker.
