// @vitest-environment node
import { describe, expect, it } from "vitest";
import { newId } from "../../../src/db";
import { readStep2GenerationInputs } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import {
  Step2EditedInputsV2,
  type Step2Provenance,
} from "../../../src/domain/step2Correction";
import { validateDraftV2 } from "../../../src/server/preparation";
import { submitGeneration } from "../../../src/server/generations";
import { correctionVerifiedCoverage } from "../../../src/tailoring/step2CorrectionPolicy";
import {
  s2dDraftV2,
  s2dSaveDraftV2,
  seedS2dAcceptedV2,
  withS2dDatabase,
  S2D_KEYED_ENV,
  type S2dAcceptedV2,
} from "./s2d-world";
import type { DatabaseHandle } from "../../../src/db";

/**
 * WO-1.3-S2-CP-B provenance legs (S2CPB4 + the S2CPB3 gate):
 * exact master text freezes VERIFIED_SOURCE, explicitly
 * selected unchanged AI text freezes USER_ACCEPTED_AI, and any
 * saved change freezes USER_EDITED; validation verdicts and the
 * frozen manifest agree segment by segment; replay, retries, and
 * stale validations cannot alter server-derived provenance; user
 * edits with unverified metrics/technology/responsibilities save
 * and submit verbatim without touching master/facts or inflating
 * verified coverage.
 */

const EDITED =
  "Led customer discovery with 40+ buyers, owning NetSuite rollout and P&L, lifting revenue 300%.";

function submitV2(
  handle: DatabaseHandle,
  accepted: S2dAcceptedV2,
  input: { requestId?: string; workspaceRevision: number; observedRowVersion?: number },
): { requestId: string; result: ReturnType<typeof submitGeneration> } {
  const live = getTailoringJob(handle, accepted.basics.jobId);
  if (live === null) {
    throw new Error("S2-CP-B setup lost the job");
  }
  const requestId = input.requestId ?? newId();
  const observedRowVersion = input.observedRowVersion ?? live.rowVersion;
  const result = submitGeneration(
    handle,
    {
      jobId: accepted.basics.jobId,
      requestId,
      workspaceRevision: input.workspaceRevision,
      observedRowVersion,
      actor: "human",
      now: accepted.now,
    },
    { env: S2D_KEYED_ENV },
  );
  return { requestId, result };
}

function fittingOps(accepted: S2dAcceptedV2, editedText: string | null) {
  return [
    {
      op: "add" as const,
      operationId: newId(),
      suggestionId: accepted.usableSuggestion.suggestionId,
      roleId: accepted.usableSuggestion.roleId,
      editedText,
    },
    { op: "exclude" as const, operationId: newId(), targetFactId: "pm-fact-discovery" },
    { op: "exclude" as const, operationId: newId(), targetFactId: "pm-fact-pricing" },
    { op: "exclude" as const, operationId: newId(), targetFactId: "pm-fact-cadence" },
  ];
}

function provenanceOf(
  segments: Array<{ segmentId: string; provenance: Step2Provenance }>,
  segmentId: string,
): Step2Provenance {
  const found = segments.find((segment) => segment.segmentId === segmentId);
  if (found === undefined) {
    throw new Error(`S2-CP-B setup produced no ${segmentId} verdict`);
  }
  return found.provenance;
}

describe("S2CPB4 provenance matrix", () => {
  it("master-exact, AI-accepted, and edited text derive distinct provenance", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const masterSummary = accepted.plan.positioning.keepMasterSummary;
      const { revision } = s2dSaveDraftV2(
        t.handle,
        accepted,
        s2dDraftV2(accepted, fittingOps(accepted, null), masterSummary, "master"),
        0,
      );

      // Unchanged AI add + master-exact summary.
      const clean = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: masterSummary,
          summaryOrigin: "master",
          operations: fittingOps(accepted, null),
        },
        now: accepted.now,
      });
      if (!clean.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${clean.error}`);
      }
      expect(provenanceOf(clean.value.validation.segments, "summary")).toBe("VERIFIED_SOURCE");
      const added = clean.value.validation.segments.find((segment) => segment.kind === "bullet");
      expect(added?.provenance).toBe("USER_ACCEPTED_AI");

      // Edited add + edited summary.
      const edited = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: EDITED,
          summaryOrigin: "master",
          operations: fittingOps(accepted, EDITED),
        },
        now: accepted.now,
      });
      if (!edited.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${edited.error}`);
      }
      expect(provenanceOf(edited.value.validation.segments, "summary")).toBe("USER_EDITED");
      const editedBullet = edited.value.validation.segments.find(
        (segment) => segment.kind === "bullet",
      );
      expect(editedBullet?.provenance).toBe("USER_EDITED");
    });
  });

  it("the frozen manifest agrees with validation verdicts segment by segment", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const draft = s2dDraftV2(accepted, fittingOps(accepted, EDITED), EDITED, "master");
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const validated = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: EDITED,
          summaryOrigin: "master",
          operations: draft.operations,
        },
        now: accepted.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${validated.error}`);
      }
      const { requestId, result } = submitV2(t.handle, accepted, { workspaceRevision: revision });
      expect(result).toMatchObject({ ok: true, replayed: false });
      const inputs = readStep2GenerationInputs(t.handle, requestId);
      if (inputs === null) {
        throw new Error("S2-CP-B submit left no frozen inputs");
      }
      const frozen = Step2EditedInputsV2.parse(JSON.parse(inputs.editedInputsJson) as unknown);
      for (const entry of frozen.provenanceManifest) {
        expect(entry.provenance).toBe(
          provenanceOf(validated.value.validation.segments, entry.segmentId),
        );
      }
      expect(provenanceOf(frozen.provenanceManifest, "summary")).toBe("USER_EDITED");
    });
  });
});

describe("S2CPB4 replay and stale validation", () => {
  it("idempotent replay converges byte-identically without new rows", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const draft = s2dDraftV2(
        accepted,
        fittingOps(accepted, EDITED),
        EDITED,
        "master",
      );
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const requestId = newId();
      const rowVersion = getTailoringJob(t.handle, accepted.basics.jobId)?.rowVersion ?? 0;
      const counts = (table: string): number =>
        (
          t.handle.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count;
      const requestsBefore = counts("generation_requests");
      const inputsBefore = counts("step2_generation_inputs");
      const first = submitV2(t.handle, accepted, {
        requestId,
        workspaceRevision: revision,
        observedRowVersion: rowVersion,
      });
      expect(first.result).toMatchObject({ ok: true, replayed: false });
      const frozenBefore = readStep2GenerationInputs(t.handle, requestId)?.editedInputsJson;
      // The lost-202 replay reuses the ORIGINAL observed bytes.
      const replayed = submitV2(t.handle, accepted, {
        requestId,
        workspaceRevision: revision,
        observedRowVersion: rowVersion,
      });
      expect(replayed).toMatchObject({
        result: { ok: true, replayed: true },
      });
      expect(readStep2GenerationInputs(t.handle, requestId)?.editedInputsJson).toBe(frozenBefore);
      expect(counts("generation_requests")).toBe(requestsBefore + 1);
      expect(counts("step2_generation_inputs")).toBe(inputsBefore + 1);
    });
  });

  it("a stale async validation refuses and cannot alter the frozen result", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const masterSummary = accepted.plan.positioning.keepMasterSummary;
      const first = s2dDraftV2(accepted, fittingOps(accepted, null), masterSummary, "master");
      const saved1 = s2dSaveDraftV2(t.handle, accepted, first, 0);
      // A slow validator answers for revision 1 after the user
      // already saved revision 2: it refuses instead of writing.
      const second = s2dDraftV2(accepted, fittingOps(accepted, EDITED), EDITED, "master");
      const saved2 = s2dSaveDraftV2(t.handle, accepted, second, saved1.revision);
      const stale = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: saved1.revision,
          summaryText: masterSummary,
          summaryOrigin: "master",
          operations: first.operations,
        },
        now: accepted.now,
      });
      expect(stale).toMatchObject({ ok: false, error: "workspace-conflict" });
      const { requestId, result } = submitV2(t.handle, accepted, {
        workspaceRevision: saved2.revision,
      });
      expect(result).toMatchObject({ ok: true, replayed: false });
      const inputs = readStep2GenerationInputs(t.handle, requestId);
      if (inputs === null) {
        throw new Error("S2-CP-B submit left no frozen inputs");
      }
      const frozen = Step2EditedInputsV2.parse(JSON.parse(inputs.editedInputsJson) as unknown);
      expect(frozen.summaryText).toBe(EDITED);
      expect(provenanceOf(frozen.provenanceManifest, "summary")).toBe("USER_EDITED");
    });
  });
});

describe("S2CPB3 user-edit gate", () => {
  it("unverified edits submit verbatim without touching master/facts or coverage", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const masterSummary = accepted.plan.positioning.keepMasterSummary;
      const payloadBefore = t.handle.sqlite
        .prepare("SELECT payload_json AS payload FROM candidate_profile_versions WHERE id = ?")
        .get(accepted.basics.profileVersionId) as { payload: string };
      const factsBefore = t.handle.sqlite
        .prepare("SELECT * FROM candidate_facts ORDER BY fact_id")
        .all();

      const { revision } = s2dSaveDraftV2(
        t.handle,
        accepted,
        s2dDraftV2(accepted, fittingOps(accepted, null), masterSummary, "master"),
        0,
      );
      // Baseline coverage over the unedited draft.
      const baseline = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: masterSummary,
          summaryOrigin: "master",
          operations: fittingOps(accepted, null),
        },
        now: accepted.now,
      });
      if (!baseline.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${baseline.error}`);
      }
      const baselineCoverage = correctionVerifiedCoverage({ validation: baseline.value.validation });

      // The unverified edit saves and validates as USER_EDITED.
      const edited = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: EDITED,
          summaryOrigin: "master",
          operations: fittingOps(accepted, EDITED),
        },
        now: accepted.now,
      });
      if (!edited.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${edited.error}`);
      }
      const editedCoverage = correctionVerifiedCoverage({ validation: edited.value.validation });
      // No new verified segment: user edits never inflate
      // verified coverage (the edited summary legitimately leaves
      // the verified set).
      for (const segmentId of editedCoverage.verifiedSegmentIds) {
        expect(baselineCoverage.verifiedSegmentIds).toContain(segmentId);
      }
      expect(editedCoverage.verifiedSegmentIds.length).toBeLessThanOrEqual(
        baselineCoverage.verifiedSegmentIds.length,
      );
      const editedBullet = edited.value.validation.segments.find(
        (segment) => segment.kind === "bullet",
      );
      expect(editedBullet?.provenance).toBe("USER_EDITED");
      expect(editedCoverage.nonVerifiedSegmentIds).toContain(editedBullet?.segmentId);

      // Saving + submitting the edit keeps master/facts frozen.
      const saved2 = s2dSaveDraftV2(
        t.handle,
        accepted,
        s2dDraftV2(accepted, fittingOps(accepted, EDITED), EDITED, "master"),
        revision,
      );
      const { requestId, result } = submitV2(t.handle, accepted, {
        workspaceRevision: saved2.revision,
      });
      expect(result).toMatchObject({ ok: true, replayed: false });
      const inputs = readStep2GenerationInputs(t.handle, requestId);
      if (inputs === null) {
        throw new Error("S2-CP-B submit left no frozen inputs");
      }
      const frozen = Step2EditedInputsV2.parse(JSON.parse(inputs.editedInputsJson) as unknown);
      expect(frozen.operations[0]).toMatchObject({ op: "add", editedText: EDITED });
      expect(
        (
          t.handle.sqlite
            .prepare("SELECT payload_json AS payload FROM candidate_profile_versions WHERE id = ?")
            .get(accepted.basics.profileVersionId) as { payload: string }
        ).payload,
      ).toBe(payloadBefore.payload);
      expect(t.handle.sqlite.prepare("SELECT * FROM candidate_facts ORDER BY fact_id").all()).toEqual(
        factsBefore,
      );
    });
  });
});
