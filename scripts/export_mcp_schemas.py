#!/usr/bin/env python3
"""
Export checked-in JSON schemas for all career-memory MCP tools.
Ensures tool definitions are tracked in version control and can be packaged
or registered without modifying client internals during agent workflows.
"""
import asyncio
import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))

from services.mcp.server import mcp

OUTPUT_DIR = BASE_DIR / "services" / "mcp" / "schemas"


def export_schemas() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tools = asyncio.run(mcp.list_tools())
    print(f"Exporting {len(tools)} MCP tool schemas to {OUTPUT_DIR}...")

    tool_names = {tool.name for tool in tools}
    for stale_path in OUTPUT_DIR.glob("*.json"):
        if stale_path.stem not in tool_names:
            stale_path.unlink()

    for tool in tools:
        schema = {
            "name": tool.name,
            "description": tool.description or "",
            "parameters": tool.input_schema or {"type": "object", "properties": {}}
        }
        target_path = OUTPUT_DIR / f"{tool.name}.json"
        target_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")

    print(f"Successfully exported {len(tools)} schemas.")
    return 0


if __name__ == "__main__":
    sys.exit(export_schemas())
