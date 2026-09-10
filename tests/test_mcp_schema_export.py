"""Keep the offline MCP schema package synchronized with the server tools."""

import asyncio
import json
from pathlib import Path

from services.mcp.server import mcp


SCHEMA_DIR = Path(__file__).resolve().parents[1] / "services" / "mcp" / "schemas"


def test_checked_in_mcp_schemas_match_registered_tools() -> None:
    tools = asyncio.run(mcp.list_tools())
    expected_names = {tool.name for tool in tools}
    actual_names = {path.stem for path in SCHEMA_DIR.glob("*.json")}

    assert actual_names == expected_names
    for tool in tools:
        schema = json.loads((SCHEMA_DIR / f"{tool.name}.json").read_text(encoding="utf-8"))
        assert schema == {
            "name": tool.name,
            "description": tool.description or "",
            "parameters": tool.input_schema or {"type": "object", "properties": {}},
        }
