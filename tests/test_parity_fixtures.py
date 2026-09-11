"""R4-B parity fixtures check-mode (TEMPORARY — removed with the oracle at R5-D).

Replays every JSON fixture against the Python oracle and fails on drift.
DB-free and browser-free by construction.
"""
from pathlib import Path

import pytest

from scripts.run_parity_fixtures import check, fixture_files

SUITES = [path.stem for path in fixture_files()]


@pytest.mark.parametrize("suite", SUITES)
def test_parity_suite_matches_oracle(suite: str) -> None:
    assert fixture_files(suite), f"suite file for '{suite}' is missing"
    failures = check(suite)
    assert not failures, "\n".join(failures)


def test_fixture_directory_has_no_unexpected_files() -> None:
    root = Path(__file__).resolve().parent / "fixtures" / "parity"
    names = sorted(path.name for path in root.iterdir())
    assert names, "parity fixture directory is empty"
    assert "README.md" in names
    assert "parity-fixtures.schema.json" in names
    suites = [name for name in names if name.endswith(".json") and name != "parity-fixtures.schema.json"]
    assert len(suites) == len(SUITES)
    assert set(names) == {
        "README.md",
        "parity-fixtures.schema.json",
        *(f"{suite}.json" for suite in SUITES),
    }
