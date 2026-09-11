// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkGenerationInputs } from "../../../src/tailoring/staleness";
import { loadSuite } from "./_loader";

/**
 * Stale-input parity. Two documented carve-outs where byte equality cannot
 * hold: the harness stub invents `new_jd_snapshot_id` values (the port
 * returns the hash R4-E persists; the test maps hash to stub id), and the
 * malformed-requirement message embeds pydantic prose (the port emits a
 * deterministic validator-style detail; the test asserts the shared prefix).
 * Current-profile hashes below were recorded from the oracle's own hashing
 * at R4-B authoring time; hash computation itself is covered by R4-A tests.
 */
const CURRENT_PROFILE_HASH = "7256d5b4d672d3dbbb40d1d3492d64e0ef1007fdf166316760bbc41d172117f5";

const CASES = loadSuite("stale-inputs").cases;

interface SnapshotRow {
  id?: unknown;
  content_hash?: unknown;
  cleaned_text?: unknown;
  raw_text?: unknown;
}

function runGate(input: Record<string, unknown>): unknown {
  const snapshots = (input["jdSnapshots"] ?? []) as SnapshotRow[];
  const byHash: Record<string, unknown> = {};
  for (const snap of snapshots) {
    if (typeof snap.content_hash === "string") {
      byHash[snap.content_hash] = snap;
    }
  }
  const analysis = input["analysis"] as Record<string, unknown> | null;
  const boundId = analysis !== null ? analysis["candidate_snapshot_id"] : undefined;
  const candidates = (input["candidateSnapshots"] ?? []) as Array<Record<string, unknown>>;
  const bound = candidates.find((entry) => String(entry["id"]) === String(boundId)) ?? null;
  const profile = input["profile"] as Record<string, unknown> | null;
  return checkGenerationInputs({
    job: input["job"],
    profile,
    analysis,
    jdSnapshotsByHash: byHash,
    candidateSnapshot: bound,
    currentProfileHash: CURRENT_PROFILE_HASH,
    candidateId: profile !== null ? String(profile["id"]) : "cand-parity-001",
  });
}

describe("stale-input parity (R4-B fixtures)", () => {
  it.each(CASES.map((entry) => [entry.id, entry.input, entry.expected] as const))(
    "%s",
    (id, input, expected) => {
      if (id === "stale-missing-job" || id === "stale-missing-profile") {
        const want = expected as { message: string };
        expect(() => runGate(input)).toThrow(want.message);
        return;
      }
      const actual = runGate(input) as Record<string, unknown>;
      const want = expected as Record<string, unknown>;
      if (id === "stale-invalid-requirement") {
        expect(actual["status"]).toBe(want["status"]);
        expect(actual["blockers"]).toEqual(want["blockers"]);
        expect(actual["message"]).toMatch(/^Invalid requirement in analysis: /);
        expect(actual["message"]).toContain("match_status");
        return;
      }
      if (id === "stale-new-jd-text") {
        expect(actual["status"]).toBe(want["status"]);
        expect(actual["blockers"]).toEqual(want["blockers"]);
        expect(actual["message"]).toBe(want["message"]);
        expect(want["new_jd_snapshot_id"]).toBe(
          `jd-snap-${String(actual["new_jd_snapshot_hash"]).slice(0, 12)}`,
        );
        return;
      }
      expect(actual).toEqual(expected);
    },
  );
});
