"""
Antigravity-managed sidecar process.
Supervises the loopback control service and runs the leased outbox delivery worker.
Guarantees agentapi availability within Antigravity harness execution.
"""
import asyncio
import os
import signal
import sys
import threading
from pathlib import Path
import uvicorn

# Ensure project root is on sys.path
BASE_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE_DIR))

from services.memory.repository import JobRepository
from services.ui.app import create_app
from services.ui.notifier import AgentApiSender, LeasedOutboxWorker
from services.ui.server import find_free_port, save_state_file, remove_state_file, WORKSPACE_STATE_FILE


class SidecarSupervisor:
    def __init__(self, port: int = 0, poll_interval_seconds: float = 2.0) -> None:
        self.host = "127.0.0.1"
        self.port = port if port != 0 else find_free_port(self.host)
        self.poll_interval = poll_interval_seconds
        self.repo = JobRepository()
        self.app = create_app(repo=self.repo)
        self.worker = LeasedOutboxWorker(repo=self.repo, sender=AgentApiSender())
        self._stop_event = threading.Event()
        self._server: Optional[uvicorn.Server] = None

    def _run_outbox_loop(self) -> None:
        # Initial recovery of stranded leases
        self.worker.recover_stranded_leases()
        while not self._stop_event.is_set():
            try:
                self.worker.process_batch(limit=10)
            except Exception as exc:
                sys.stderr.write(f"[sidecar-outbox] Error processing batch: {exc}\n")
            self._stop_event.wait(self.poll_interval)

    def start(self) -> None:
        # Write state file
        metadata = {
            "host": self.host,
            "port": self.port,
            "url": f"http://{self.host}:{self.port}",
            "pid": os.getpid(),
            "mode": "antigravity_sidecar"
        }
        save_state_file(WORKSPACE_STATE_FILE, metadata)

        outbox_thread = threading.Thread(target=self._run_outbox_loop, daemon=True)
        outbox_thread.start()

        config = uvicorn.Config(
            self.app,
            host=self.host,
            port=self.port,
            log_level="warning",
            access_log=False
        )
        self._server = uvicorn.Server(config)

        try:
            self._server.run()
        finally:
            self.stop()

    def stop(self) -> None:
        self._stop_event.set()
        if self._server:
            self._server.should_exit = True
        remove_state_file(WORKSPACE_STATE_FILE)


def main() -> int:
    supervisor = SidecarSupervisor()

    def sig_handler(signum, frame):
        supervisor.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)
    supervisor.start()
    return 0


if __name__ == "__main__":
    sys.exit(main())
