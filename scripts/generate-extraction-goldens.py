"""Generate oracle goldens for R2-D normalization ports.

Reads tests/unit/extraction/fixtures/oracle-inputs.json, runs the legacy
Python oracle (services/discovery/normalizer.py), and writes
oracle-goldens.json beside it. Re-run to re-verify; the TypeScript tests
assert parity except for documented truthfulness fixes (no invented
"Unknown Role"/location expansions).
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "discovery"))

from normalizer import (  # noqa: E402
    generate_content_hash,
    normalize_location,
    normalize_title,
)


def main() -> None:
    fixtures = REPO_ROOT / "tests" / "unit" / "extraction" / "fixtures"
    inputs = json.loads((fixtures / "oracle-inputs.json").read_text())
    goldens = {
        "contentHash": [
            generate_content_hash(c["company"], c["title"], c["description"])
            for c in inputs["contentHashCases"]
        ],
        "arrangement": [
            {
                "location": c["location"],
                "isRemote": c["isRemote"],
                "legacy": list(normalize_location(c["location"], c["isRemote"])),
            }
            for c in inputs["arrangementCases"]
        ],
        "title": [normalize_title(t) for t in inputs["titleCases"]],
    }
    (fixtures / "oracle-goldens.json").write_text(
        json.dumps(goldens, indent=2) + "\n"
    )
    print(f"wrote {len(goldens['contentHash'])} hash, "
          f"{len(goldens['arrangement'])} arrangement, "
          f"{len(goldens['title'])} title goldens")


if __name__ == "__main__":
    main()
