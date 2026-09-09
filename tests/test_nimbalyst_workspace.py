"""Regression checks for the file-backed Nimbalyst project control surface."""

from scripts.populate_nimbalyst import validate_workspace


def test_nimbalyst_workspace_is_consistent() -> None:
    """Plans, milestones, and inline tracker metadata must remain in sync."""
    assert validate_workspace() == []
