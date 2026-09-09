"""Locate a non-GUI Chromium runtime for deterministic PDF rendering."""

import os
import shutil
from pathlib import Path
from typing import List, Optional, Sequence


def headless_browser_candidates() -> List[str]:
    """Return browser candidates with dedicated headless runtimes first."""
    candidates: List[str] = []
    explicit_path = os.getenv("HEADLESS_BROWSER_PATH") or os.getenv("CHROME_PATH")
    if explicit_path:
        candidates.append(explicit_path)

    cache_roots = (
        Path.home() / "Library" / "Caches" / "ms-playwright",
        Path.home() / ".cache" / "ms-playwright",
    )
    for playwright_cache in cache_roots:
        cached_shells = sorted(
            playwright_cache.glob(
                "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell"
            ),
            reverse=True,
        )
        candidates.extend(str(path) for path in cached_shells)

    for executable in ("chrome-headless-shell", "chromium", "google-chrome"):
        located = shutil.which(executable)
        if located:
            candidates.append(located)

    return list(dict.fromkeys(candidates))


def resolve_headless_browser(candidates: Optional[Sequence[str]] = None) -> str:
    """Return the first executable browser candidate or raise a clear error."""
    paths = list(candidates) if candidates is not None else headless_browser_candidates()
    for candidate in paths:
        path = Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise FileNotFoundError(
        "No headless browser executable was found. Install Playwright Chromium "
        "or set HEADLESS_BROWSER_PATH to an executable headless browser. The "
        "branded macOS Google Chrome app is not selected automatically."
    )
