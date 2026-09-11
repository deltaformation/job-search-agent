"""Trusted resume template registry for Milestone 8.

Only allow-listed, checked-in templates may render. The reference HTML
(``Mouad_Atfi_Resume_Editable.html``) is untrusted design input only and is
never read at runtime. Unknown IDs and path traversals fail closed.
"""
import hashlib
from pathlib import Path
from typing import Any, Dict, Tuple

import yaml

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "config"

ALLOWED_TEMPLATES: Dict[str, str] = {
    "mouad_standard_v1": "mouad_standard_v1.html.j2",
}

RESUME_CONFIG_DEFAULTS: Dict[str, Any] = {
    "default_template": "mouad_standard_v1",
    "template_version": "v1",
    "render_schema_version": "v1",
    "ranking_policy_version": "coverage-first/v1",
    "page_budget": 2,
    "max_experience_bullets": 5,
    "max_prior_role_bullets": 3,
    "max_total_bullets": 14,
    "max_detailed_roles": 3,
    "max_earlier_career_entries": 6,
    "variants_enabled": False,
}


class TemplateRegistry:
    def __init__(self, templates_dir: Path | None = None) -> None:
        self.templates_dir = templates_dir or TEMPLATES_DIR

    def get_template(self, template_id: str) -> Tuple[str, str]:
        """Return (template_source, sha256_hex) for a trusted template ID."""
        filename = ALLOWED_TEMPLATES.get(template_id)
        if filename is None:
            raise ValueError(f"Unknown resume template: {template_id!r}.")
        if "/" in filename or "\\" in filename or ".." in filename:
            raise ValueError(f"Invalid template path for {template_id!r}.")
        path = (self.templates_dir / filename).resolve()
        base = self.templates_dir.resolve()
        if path.parent != base or not path.is_file():
            raise ValueError(f"Resume template not found: {template_id!r}.")
        source = path.read_text(encoding="utf-8")
        digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
        return source, digest

    def allowed_ids(self) -> list[str]:
        return sorted(ALLOWED_TEMPLATES)


def load_resume_config(config_dir: Path | None = None) -> Dict[str, Any]:
    """Load presentation-only resume config; the JD can never influence this."""
    merged = dict(RESUME_CONFIG_DEFAULTS)
    path = (config_dir or CONFIG_DIR) / "resume.yaml"
    if path.is_file():
        with path.open("r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
        if not isinstance(data, dict):
            raise ValueError("resume.yaml root must be a mapping.")
        for key, value in data.items():
            if key not in RESUME_CONFIG_DEFAULTS:
                raise ValueError(f"resume.yaml: unsupported key '{key}'.")
            merged[key] = value
    template_id = merged.get("default_template")
    if template_id not in ALLOWED_TEMPLATES:
        raise ValueError(f"resume.yaml: untrusted default_template '{template_id}'.")
    return merged
