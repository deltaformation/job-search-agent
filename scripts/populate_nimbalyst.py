#!/usr/bin/env python3
"""Validate the file-backed Nimbalyst project control surface.

The original bootstrap script rewrote every plan and tracker file from embedded
strings. That made normal edits in Nimbalyst unsafe and allowed the generator to
reintroduce stale milestone claims. This replacement is deliberately read-only:
it checks the committed files against the unified project-work schema and the
project's milestone invariants.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

import yaml


ROOT = Path(__file__).resolve().parent.parent
NIMBALYST_ROOT = ROOT / "nimbalyst-local"

PLAN_STATUSES: Set[str] = {
    "draft",
    "ready-for-development",
    "in-development",
    "in-review",
    "changes-requested",
    "approved",
    "completed",
    "rejected",
    "blocked",
}
MILESTONE_STATUSES: Set[str] = {"planned", "active", "done", "cancelled"}
WORK_STATUSES: Set[str] = {"backlog", "in-progress", "in-review", "blocked", "done"}
WORK_KINDS: Set[str] = {"milestone", "task", "decision", "idea"}
WORK_MILESTONES: Set[str] = {"m1", "m2", "m3", "m4", "m5", "m6", "workspace", "future"}


@dataclass(frozen=True)
class InlineSchema:
    id_prefix: str
    statuses: Set[str]
    priorities: Optional[Set[str]] = None


INLINE_SCHEMAS: Mapping[str, InlineSchema] = {
    "project-work": InlineSchema(
        id_prefix="wrk",
        statuses=WORK_STATUSES,
        priorities={"low", "medium", "high", "critical"},
    ),
}

LEGACY_TRACKER_TYPES: Set[str] = {"task", "decision", "idea", "plan", "milestone"}

REQUIRED_FILES: Sequence[Path] = (
    ROOT / ".nimbalyst" / "trackers" / "project-work.yaml",
    NIMBALYST_ROOT / "README.md",
    NIMBALYST_ROOT / "project-summary.md",
    NIMBALYST_ROOT / "agent-handoff.md",
    NIMBALYST_ROOT / "ai-actions.md",
    NIMBALYST_ROOT / "tracker" / "tasks.md",
    NIMBALYST_ROOT / "tracker" / "decisions.md",
    NIMBALYST_ROOT / "tracker" / "ideas.md",
)

MARKER_RE = re.compile(r"#(?P<type>[a-z][\w-]*)\[(?P<props>[^\]]+)\]")
PROP_RE = re.compile(r"(?P<key>\w+):(?P<value>\"[^\"]*\"|[^\s]+)")
ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def parse_frontmatter(path: Path) -> Dict[str, Any]:
    """Return YAML frontmatter from a Markdown file."""
    content = path.read_text(encoding="utf-8")
    if not content.startswith("---\n"):
        raise ValueError("missing opening YAML frontmatter delimiter")
    parts = content.split("---", 2)
    if len(parts) != 3:
        raise ValueError("missing closing YAML frontmatter delimiter")
    parsed = yaml.safe_load(parts[1])
    if not isinstance(parsed, dict):
        raise ValueError("frontmatter must be a mapping")
    return parsed


def parse_props(raw_props: str) -> Dict[str, str]:
    """Parse compact Nimbalyst inline marker properties."""
    props: Dict[str, str] = {}
    for match in PROP_RE.finditer(raw_props):
        value = match.group("value")
        props[match.group("key")] = value[1:-1] if value.startswith('"') else value
    return props


def validate_identifier(item_type: str, raw_id: str, schema: InlineSchema) -> Optional[str]:
    """Validate the prefix and ULID portion of an inline tracker identifier."""
    expected_prefix = f"{schema.id_prefix}_"
    if not raw_id.startswith(expected_prefix):
        return f"#{item_type} id {raw_id!r} must start with {expected_prefix!r}"
    ulid = raw_id[len(expected_prefix) :]
    if not ULID_RE.fullmatch(ulid):
        return f"#{item_type} id {raw_id!r} must end with a 26-character Crockford ULID"
    return None


def validate_inline_file(path: Path, seen_ids: Set[str]) -> List[str]:
    """Validate inline tracker markers against Nimbalyst built-in schemas."""
    errors: List[str] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        for match in MARKER_RE.finditer(line):
            item_type = match.group("type")
            schema = INLINE_SCHEMAS.get(item_type)
            if schema is None:
                if item_type in LEGACY_TRACKER_TYPES:
                    errors.append(
                        f"{path.relative_to(ROOT)}:{line_number}: #{item_type} would "
                        "reintroduce a separate Kanban workflow; use #project-work"
                    )
                continue
            props = parse_props(match.group("props"))
            location = f"{path.relative_to(ROOT)}:{line_number}"

            raw_id = props.get("id")
            if not raw_id:
                errors.append(f"{location}: #{item_type} marker is missing id")
            else:
                id_error = validate_identifier(item_type, raw_id, schema)
                if id_error:
                    errors.append(f"{location}: {id_error}")
                if raw_id in seen_ids:
                    errors.append(f"{location}: duplicate tracker id {raw_id!r}")
                seen_ids.add(raw_id)

            status = props.get("status")
            if status not in schema.statuses:
                errors.append(
                    f"{location}: invalid #{item_type} status {status!r}; "
                    f"expected one of {sorted(schema.statuses)}"
                )

            priority = props.get("priority")
            if priority is not None and schema.priorities is None:
                errors.append(f"{location}: #{item_type} does not define a priority field")
            elif priority is not None and priority not in (schema.priorities or set()):
                errors.append(f"{location}: invalid priority {priority!r}")

            kind = props.get("kind")
            if kind not in WORK_KINDS:
                errors.append(f"{location}: invalid or missing project-work kind {kind!r}")
            milestone = props.get("milestone")
            if milestone not in WORK_MILESTONES:
                errors.append(f"{location}: invalid or missing milestone {milestone!r}")

            if kind in {"task", "milestone"}:
                checked = line.lstrip().startswith("- [x]")
                unchecked = line.lstrip().startswith("- [ ]")
                if status == "done" and not checked:
                    errors.append(f"{location}: done {kind} must use a checked Markdown box")
                if status != "done" and checked:
                    errors.append(f"{location}: non-done {kind} must not use a checked Markdown box")
                if not checked and not unchecked:
                    errors.append(f"{location}: {kind} must use a standard [x] or [ ] Markdown box")
    return errors


def validate_full_document(path: Path, expected_type: str) -> Tuple[List[str], Dict[str, Any]]:
    """Validate canonical Nimbalyst full-document tracker frontmatter."""
    errors: List[str] = []
    try:
        data = parse_frontmatter(path)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        return [f"{path.relative_to(ROOT)}: {exc}"], {}

    relative = path.relative_to(ROOT)
    if "trackerStatus" in data:
        errors.append(
            f"{relative}: trackerStatus would create a separate Nimbalyst Kanban "
            "workflow; use projectDocument instead"
        )
    project_document = data.get("projectDocument")
    if project_document != {"type": expected_type}:
        errors.append(f"{relative}: projectDocument must equal {{'type': '{expected_type}'}}")

    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append(f"{relative}: title is required")

    status = data.get("status")
    allowed = PLAN_STATUSES if expected_type == "plan" else MILESTONE_STATUSES
    if status not in allowed:
        errors.append(f"{relative}: invalid {expected_type} status {status!r}")

    if expected_type == "plan":
        plan_id = data.get("planId")
        if not isinstance(plan_id, str) or not plan_id.startswith("pln_"):
            errors.append(f"{relative}: planId must start with 'pln_'")
        progress = data.get("progress")
        if not isinstance(progress, (int, float)) or isinstance(progress, bool) or not 0 <= progress <= 100:
            errors.append(f"{relative}: progress must be a number from 0 to 100")
        if status == "completed" and progress != 100:
            errors.append(f"{relative}: completed plan must have progress 100")
        if status != "completed" and progress == 100:
            errors.append(f"{relative}: incomplete plan cannot claim progress 100")

    return errors, data


def numbered_files(folder: Path) -> Dict[int, Path]:
    """Map milestone number to its Markdown file."""
    result: Dict[int, Path] = {}
    for path in sorted(folder.glob("milestone-*.md")):
        match = re.match(r"milestone-(\d+)-", path.name)
        if match:
            result[int(match.group(1))] = path
    return result


def validate_workspace() -> List[str]:
    """Return every detected Nimbalyst workspace consistency error."""
    errors: List[str] = []
    for path in REQUIRED_FILES:
        if not path.is_file():
            errors.append(f"missing required file: {path.relative_to(ROOT)}")

    schema_path = ROOT / ".nimbalyst" / "trackers" / "project-work.yaml"
    if schema_path.is_file():
        try:
            schema_data = yaml.safe_load(schema_path.read_text(encoding="utf-8"))
            status_field = next(
                field for field in schema_data.get("fields", []) if field.get("name") == "status"
            )
            schema_statuses = {option.get("value") for option in status_field.get("options", [])}
            if schema_data.get("type") != "project-work" or schema_statuses != WORK_STATUSES:
                errors.append(
                    ".nimbalyst/trackers/project-work.yaml: type or workflow statuses "
                    "do not match the unified board contract"
                )
        except (OSError, TypeError, StopIteration, yaml.YAMLError) as exc:
            errors.append(f".nimbalyst/trackers/project-work.yaml: invalid schema: {exc}")

    seen_ids: Set[str] = set()
    tracker_dir = NIMBALYST_ROOT / "tracker"
    if tracker_dir.is_dir():
        for path in sorted(tracker_dir.glob("*.md")):
            errors.extend(validate_inline_file(path, seen_ids))

    plans = numbered_files(NIMBALYST_ROOT / "plans")
    milestones = numbered_files(NIMBALYST_ROOT / "milestones")
    expected_numbers = set(range(1, 7))
    if set(plans) != expected_numbers:
        errors.append(f"plan documents must cover milestones 1-6; found {sorted(plans)}")
    if set(milestones) != expected_numbers:
        errors.append(f"milestone documents must cover milestones 1-6; found {sorted(milestones)}")

    plan_data: Dict[int, Dict[str, Any]] = {}
    milestone_data: Dict[int, Dict[str, Any]] = {}
    for number, path in plans.items():
        file_errors, data = validate_full_document(path, "plan")
        errors.extend(file_errors)
        plan_data[number] = data
    for number, path in milestones.items():
        file_errors, data = validate_full_document(path, "milestone")
        errors.extend(file_errors)
        milestone_data[number] = data

    for number in sorted(set(plan_data) & set(milestone_data)):
        plan_status = plan_data[number].get("status")
        milestone_status = milestone_data[number].get("status")
        if plan_status == "completed" and milestone_status != "done":
            errors.append(
                f"milestone {number}: completed plan requires milestone status 'done', "
                f"found {milestone_status!r}"
            )
        if plan_status != "completed" and milestone_status == "done":
            errors.append(f"milestone {number}: active plan cannot have milestone status 'done'")

    summary_path = NIMBALYST_ROOT / "project-summary.md"
    if summary_path.is_file():
        summary = summary_path.read_text(encoding="utf-8")
        for number in expected_numbers:
            if f"| {number}." not in summary:
                errors.append(f"project-summary.md: missing milestone {number} dashboard row")

    return errors


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    parser = argparse.ArgumentParser(
        description="Validate Nimbalyst project files without overwriting human edits."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate the workspace (also the default behavior).",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the non-destructive Nimbalyst workspace validation."""
    parser = build_parser()
    parser.parse_args(argv)
    errors = validate_workspace()
    if errors:
        print("Nimbalyst workspace validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    work_count = sum(
        len(MARKER_RE.findall(path.read_text(encoding="utf-8")))
        for path in (NIMBALYST_ROOT / "tracker").glob("*.md")
    )
    print(
        "Nimbalyst workspace is consistent: "
        f"6 milestones, 6 plans, {work_count} unified project-work items, and one Kanban workflow."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
