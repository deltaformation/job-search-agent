#!/usr/bin/env python3
"""R4-B parity fixture runner (TEMPORARY — removed with the Python oracle at R5-D).

Runs the runtime-neutral JSON fixtures in tests/fixtures/parity/ against the
current Python oracle. ``--record`` executes each case and stores the oracle's
output as ``expected``; ``--check`` re-executes and fails on any drift. The
TypeScript port (R4-C) consumes the same JSON files with its own runner.

Only DB-free, browser-free oracle paths are exercised. Pipeline cases run
``generate_documents`` against an in-memory stub repository and cover the
blocked (stale/invalid input) paths only; the success path needs the
browser renderer and is owned by R4-C/D with new code.
"""
from __future__ import annotations

import argparse
import copy
import dataclasses
import difflib
import hashlib
import json
import math
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from services.documents.keywords import (  # noqa: E402
    CoverageFirstFactRanker,
    KeywordPlanner,
    evidence_qualified_skills,
)
from services.documents.pipeline import generate_documents  # noqa: E402
from services.documents.summary import (  # noqa: E402
    compose_summary,
    unioned_career_months,
    verify_derivation,
)
from services.documents.validator import ClaimValidator  # noqa: E402
from services.documents.view_model import (  # noqa: E402
    build_canonical_baseline_draft,
    build_view_model,
    render_plain_text,
)
from services.intelligence.context import sanitize_value  # noqa: E402

FIXTURES_DIR = BASE_DIR / "tests" / "fixtures" / "parity"
ENVELOPE_VERSION = "parity-fixtures/v1"


class FixtureError(Exception):
    """Fixture, harness, or unexpected oracle failure."""


def _reject_non_finite(value: Any) -> None:
    """Fail closed on NaN/inf instead of recording a lossy null."""
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        raise FixtureError("oracle emitted a non-finite float; fixture it explicitly")
    if isinstance(value, dict):
        for entry in value.values():
            _reject_non_finite(entry)
    elif isinstance(value, (list, tuple)):
        for entry in value:
            _reject_non_finite(entry)


def _normalize_allowed_sets(value: Any) -> Any:
    """Sort `Allowed: {...}` members in oracle error strings.

    The validator embeds Python set reprs whose order varies with hash seed.
    Sorting keeps fixtures byte-stable on every machine; the TypeScript port
    targets this normalized form.
    """
    if isinstance(value, str):
        return re.sub(
            r"Allowed: \{([^}]*)\}",
            lambda m: "Allowed: {" + ", ".join(sorted(p.strip() for p in m.group(1).split(","))) + "}",
            value,
        )
    if isinstance(value, dict):
        return {key: _normalize_allowed_sets(entry) for key, entry in value.items()}
    if isinstance(value, list):
        return [_normalize_allowed_sets(entry) for entry in value]
    return value


def to_jsonable(value: Any) -> Any:
    """Convert oracle output to deterministic JSON-safe data."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        value = dataclasses.asdict(value)
    _reject_non_finite(value)
    return _normalize_allowed_sets(sanitize_value(value))


# ---------------------------------------------------------------------------
# Suite runners: (case_id, input) -> JSON-safe oracle output.
# ---------------------------------------------------------------------------

def run_validate_requirements(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    validator = ClaimValidator(data["profile"])
    valid, errors = validator.validate_requirement_analysis(
        data["requirements"], jd_text=data.get("jdText")
    )
    return {"valid": valid, "errors": errors}


def run_validate_draft(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    validator = ClaimValidator(data["profile"], variants=data.get("variants"))
    valid, report = validator.validate_draft(data["draft"])
    return {"valid": valid, "report": report}


def run_validate_submission(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    validator = ClaimValidator(data["profile"])
    valid, errors = validator.validate_analysis_submission(
        data["analysisData"], data["jdSnapshot"], data["candidateSnapshot"]
    )
    return {"valid": valid, "errors": errors}


def run_rank_facts(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    config = data.get("config", {})
    ranker = CoverageFirstFactRanker(
        max_per_role=int(config.get("maxPerRole", 5)),
        max_prior_role=int(config.get("maxPriorRole", 3)),
        max_total=int(config.get("maxTotal", 14)),
    )
    return {"factIds": ranker.rank(data["requirements"], data["profile"])}


def run_qualified_skills(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    return {"skills": evidence_qualified_skills(data["profile"], data["citedFactIds"])}


def run_keyword_plan(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    return KeywordPlanner().plan(
        data["requirements"],
        data["rankedFactIds"],
        data["profile"],
        data.get("skillTerms"),
    )


def run_career_months(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    total, intervals = unioned_career_months(
        data["workExperiences"], date.fromisoformat(data["asOf"])
    )
    return {"total_months": total, "intervals": intervals}


def run_compose_summary(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    return compose_summary(
        data["profile"],
        data["rankedFactIds"],
        data.get("jobTitle", ""),
        date.fromisoformat(data["asOf"]),
        max_domain_terms=int(data.get("maxDomainTerms", 4)),
    )


def run_verify_derivation(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    valid, errors = verify_derivation(data["manifest"], data["profile"])
    return {"valid": valid, "errors": errors}


def run_build_view_model(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    return build_view_model(
        data["profile"], data["draft"], max_detailed_roles=int(data.get("maxDetailedRoles", 3))
    )


def run_render_resume_text(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    view_model = build_view_model(
        data["profile"], data["draft"], max_detailed_roles=int(data.get("maxDetailedRoles", 3))
    )
    return {"text": render_plain_text(view_model)}


def run_baseline_draft(case_id: str, data: Dict[str, Any]) -> Any:
    del case_id
    return build_canonical_baseline_draft(data["profile"])


class StubRepository:
    """In-memory stand-in for the DB-backed JobRepository (pipeline preconditions)."""

    def __init__(self, data: Dict[str, Any]) -> None:
        self._data = data

    def get_candidate_profile(self) -> Optional[Dict[str, Any]]:
        return copy.deepcopy(self._data.get("profile"))

    def get_job_by_id(self, job_id: str) -> Optional[Dict[str, Any]]:
        del job_id
        return copy.deepcopy(self._data.get("job"))

    def get_job_analysis(self, job_id: str) -> Optional[Dict[str, Any]]:
        del job_id
        return copy.deepcopy(self._data.get("analysis"))

    def get_jd_snapshot_by_hash(self, job_id: str, content_hash: str) -> Optional[Dict[str, Any]]:
        del job_id
        for snap in self._data.get("jdSnapshots", []):
            if snap.get("content_hash") == content_hash:
                return copy.deepcopy(snap)
        return None

    def save_jd_snapshot(self, job_id: str, raw_text: str, cleaned_text: str) -> str:
        del job_id, raw_text
        digest = hashlib.sha256(cleaned_text.encode("utf-8")).hexdigest()
        return f"jd-snap-{digest[:12]}"

    def get_candidate_snapshot(self, snapshot_id: str) -> Optional[Dict[str, Any]]:
        for snap in self._data.get("candidateSnapshots", []):
            if str(snap.get("id")) == str(snapshot_id):
                return copy.deepcopy(snap)
        return None


def run_generate_documents(case_id: str, data: Dict[str, Any]) -> Any:
    repo = StubRepository(data)
    try:
        return generate_documents(repo, data.get("jobId", "job-parity-001"))  # type: ignore[arg-type]
    except ValueError as exc:
        return {"raised": "ValueError", "message": str(exc)}


RUNNERS: Dict[str, Callable[[str, Dict[str, Any]], Any]] = {
    "validate_requirements": run_validate_requirements,
    "validate_draft": run_validate_draft,
    "validate_submission": run_validate_submission,
    "rank_facts": run_rank_facts,
    "qualified_skills": run_qualified_skills,
    "keyword_plan": run_keyword_plan,
    "career_months": run_career_months,
    "compose_summary": run_compose_summary,
    "verify_derivation": run_verify_derivation,
    "build_view_model": run_build_view_model,
    "render_resume_text": run_render_resume_text,
    "baseline_draft": run_baseline_draft,
    "generate_documents": run_generate_documents,
}


def fixture_files(suite: Optional[str] = None) -> List[Path]:
    files = sorted(
        path for path in FIXTURES_DIR.glob("*.json") if path.name != "parity-fixtures.schema.json"
    )
    if suite is not None:
        files = [path for path in files if path.stem == suite]
        if not files:
            raise FixtureError(f"unknown suite '{suite}'")
    return files


def load_suite(path: Path) -> Dict[str, Any]:
    try:
        suite = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise FixtureError(f"{path.name}: invalid JSON: {exc}") from exc
    if not isinstance(suite, dict):
        raise FixtureError(f"{path.name}: suite must be an object")
    if suite.get("version") != ENVELOPE_VERSION:
        raise FixtureError(f"{path.name}: expected version '{ENVELOPE_VERSION}'")
    cases = suite.get("cases")
    if not isinstance(cases, list) or not cases:
        raise FixtureError(f"{path.name}: 'cases' must be a non-empty list")
    seen = set()
    for case in cases:
        if not isinstance(case, dict):
            raise FixtureError(f"{path.name}: every case must be an object")
        for key in ("id", "function", "input"):
            if key not in case:
                raise FixtureError(f"{path.name}: case missing '{key}'")
        if case["id"] in seen:
            raise FixtureError(f"{path.name}: duplicate case id '{case['id']}'")
        seen.add(case["id"])
        if case["function"] not in RUNNERS:
            known = ", ".join(sorted(RUNNERS))
            raise FixtureError(f"{path.name}: unknown function '{case['function']}' ({known})")
        if not isinstance(case["input"], dict):
            raise FixtureError(f"{path.name}: case '{case['id']}' input must be an object")
    return suite


def execute(suite_name: str, case: Dict[str, Any]) -> Any:
    runner = RUNNERS[case["function"]]
    try:
        raw = runner(case["id"], copy.deepcopy(case["input"]))
    except FixtureError:
        raise
    except Exception as exc:  # noqa: BLE001 - oracle failures are fixture failures
        raise FixtureError(f"{suite_name}/{case['id']}: oracle raised {type(exc).__name__}: {exc}") from exc
    try:
        return to_jsonable(raw)
    except FixtureError as exc:
        raise FixtureError(f"{suite_name}/{case['id']}: {exc}") from exc


def record(suite: Optional[str] = None) -> int:
    count = 0
    for path in fixture_files(suite):
        data = load_suite(path)
        for case in data["cases"]:
            case["expected"] = execute(path.stem, case)
            count += 1
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return count


def check(suite: Optional[str] = None) -> List[str]:
    failures: List[str] = []
    for path in fixture_files(suite):
        data = load_suite(path)
        for case in data["cases"]:
            if "expected" not in case:
                failures.append(f"{path.stem}/{case['id']}: missing 'expected' (run --record)")
                continue
            try:
                actual = execute(path.stem, case)
            except FixtureError as exc:
                failures.append(str(exc))
                continue
            if actual != case["expected"]:
                want = json.dumps(case["expected"], indent=2, sort_keys=True).splitlines()
                got = json.dumps(actual, indent=2, sort_keys=True).splitlines()
                diff = "\n".join(difflib.unified_diff(want, got, lineterm=""))
                failures.append(f"{path.stem}/{case['id']}: oracle output drifted:\n{diff}")
    return failures


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run R4-B parity fixtures against the Python oracle.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--record", action="store_true", help="store oracle outputs as expected")
    group.add_argument("--check", action="store_true", help="fail on any oracle drift")
    parser.add_argument("--suite", default=None, help="run one suite file (stem name)")
    args = parser.parse_args(argv)
    try:
        if args.record:
            count = record(args.suite)
            print(f"recorded {count} case(s)")
            return 0
        failures = check(args.suite)
        if failures:
            print(f"{len(failures)} failure(s):\n" + "\n".join(failures))
            return 1
        print("all parity fixtures match the oracle")
        return 0
    except FixtureError as exc:
        print(f"fixture error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
