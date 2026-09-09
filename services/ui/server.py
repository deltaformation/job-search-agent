"""Loopback Uvicorn server management and dynamic port persistence."""
import json
import os
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
import uvicorn
from services.memory.repository import JobRepository
from services.ui.app import create_app


DEFAULT_STATE_FILE = Path.home() / ".gemini" / "antigravity" / "control_center.json"
WORKSPACE_STATE_FILE = Path(__file__).resolve().parents[2] / ".control_center.json"


def find_free_port(host: str = "127.0.0.1") -> int:
    """Find an available local TCP port on loopback."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        s.listen(1)
        return int(s.getsockname()[1])


def save_state_file(state_file: Path, metadata: Dict[str, Any]) -> None:
    """Safely persist running server state metadata."""
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(metadata, indent=2))


def remove_state_file(state_file: Path) -> None:
    """Remove server state file on shutdown."""
    try:
        if state_file.exists():
            state_file.unlink()
    except Exception:
        pass


def read_state_file(state_file: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Read running control center state metadata."""
    target = state_file or WORKSPACE_STATE_FILE
    if not target.exists():
        target = DEFAULT_STATE_FILE
    if target.exists():
        try:
            return json.loads(target.read_text())
        except Exception:
            return None
    return None


class ControlCenterServer:
    """Manages loopback-only control service lifecycle."""
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 0,
        repo: Optional[JobRepository] = None,
        state_file: Optional[Path] = None
    ) -> None:
        if host not in ("127.0.0.1", "localhost"):
            raise ValueError(f"Loopback violation: host must be '127.0.0.1' or 'localhost', got '{host}'.")

        self.host = host
        self.port = port if port != 0 else find_free_port(host)
        self.repo = repo or JobRepository()
        self.state_file = state_file or WORKSPACE_STATE_FILE
        self.app = create_app(repo=self.repo)

    def write_state(self) -> None:
        metadata = {
            "host": self.host,
            "port": self.port,
            "url": f"http://{self.host}:{self.port}",
            "pid": os.getpid(),
            "started_at": datetime.now(timezone.utc).isoformat()
        }
        save_state_file(self.state_file, metadata)

    def cleanup(self) -> None:
        remove_state_file(self.state_file)

    def run(self) -> None:
        self.write_state()
        try:
            config = uvicorn.Config(
                self.app,
                host=self.host,
                port=self.port,
                log_level="info",
                access_log=False
            )
            server = uvicorn.Server(config)
            server.run()
        finally:
            self.cleanup()
