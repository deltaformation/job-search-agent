from pathlib import Path
import subprocess
from unittest.mock import MagicMock

import pytest

from services.documents.browser import (
    headless_browser_candidates,
    resolve_headless_browser,
)
from services.documents.renderer import terminate_browser_process


def test_resolver_uses_first_executable_candidate(tmp_path: Path) -> None:
    unavailable = tmp_path / "missing-browser"
    executable = tmp_path / "headless-browser"
    executable.write_text("browser", encoding="utf-8")
    executable.chmod(0o700)

    assert resolve_headless_browser([str(unavailable), str(executable)]) == str(executable)


def test_resolver_rejects_missing_browser() -> None:
    with pytest.raises(FileNotFoundError, match="HEADLESS_BROWSER_PATH"):
        resolve_headless_browser([])


def test_explicit_browser_override_has_priority(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    override = tmp_path / "configured-browser"
    monkeypatch.setenv("HEADLESS_BROWSER_PATH", str(override))

    assert headless_browser_candidates()[0] == str(override)


def test_branded_macos_chrome_is_not_an_automatic_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HEADLESS_BROWSER_PATH", raising=False)
    monkeypatch.delenv("CHROME_PATH", raising=False)

    assert (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        not in headless_browser_candidates()
    )


def test_renderer_falls_back_when_process_group_signal_is_denied(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = MagicMock(spec=subprocess.Popen)
    process.pid = 123
    process.poll.return_value = None
    monkeypatch.setattr(
        "services.documents.renderer.os.killpg",
        MagicMock(side_effect=PermissionError),
    )

    terminate_browser_process(process)

    process.terminate.assert_called_once_with()
    process.wait.assert_called_once_with(timeout=3)
