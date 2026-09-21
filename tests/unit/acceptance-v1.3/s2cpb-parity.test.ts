// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  newId,
  resumeVersions,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import { readStep2GenerationInputs } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { readWorkspace } from "../../../src/db/tailoringWorkspace";
import { readPlanForJob } from "../../../src/server/preparation";
import { getRecommendations } from "../../../src/server/recommendations";
import { submitGeneration } from "../../../src/server/generations";
import { retryGeneration } from "../../../src/server/retries";
import { activateProfileVersion, importCandidate } from "../../../src/server/candidates";
import { ProviderError } from "../../../src/tailoring/contract";
import {
  claimFRun,
  fHandler,
  makeArtifactsDir,
  proposalForRun,
  throwingProvider,
} from "./f-world";
import { S2B_JD } from "./s2b-world";
import {
  s2dDraftV2,
  s2dSaveDraftV2,
  s2dSubmit,
  s2dTailorProposal,
  s2dTailorProvider,
  finishS2dAttempt,
  readS2dArtifactTexts,
  runS2dTailor,
  seedS2dAccepted,
  seedS2dAcceptedV2,
  versionForRequest,
  withS2dDatabase,
  S2D_KEYED_ENV,
  type S2dAcceptedV2,
} from "./s2d-world";

/**
 * WO-1.3-S2-CP-B execution legs (S2CPB3 renderers + S2CPB6): the
 * v2 freeze executes through the real TAILOR worker with exact
 * USER_EDITED bytes in canonical, Markdown, DOCX, and PDF;
 * submit CAS/concurrency guards hold on the v2 path; a crashed
 * attempt retries on exact frozen bytes and provenance with one
 * version and no duplicate provider call; later workspace saves
 * and Settings rotations neither alter nor strand the frozen
 * run; v1 readers keep serving historical rows.
 */

const EDITED =
  "Led customer discovery with 40+ buyers, owning NetSuite rollout and P&L, lifting revenue 300%.";

function fittingOpsV2(accepted: S2dAcceptedV2, editedText: string | null) {
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

describe("S2CPB3 correction renderers", () => {
  it("canonical, Markdown, DOCX, and PDF contain the exact edited bytes", async () => {
    await withS2dDatabase(async (t, world) => {
      // Wall-clock seed: the worker re-verifies chronology
      // against wall now, so future-fixed clocks would block.
      const accepted = await seedS2dAcceptedV2(t.handle, world, S2B_JD, new Date().toISOString());
      const draft = s2dDraftV2(accepted, fittingOpsV2(accepted, EDITED), EDITED, "master");
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const submitted = s2dSubmit(t.handle, accepted, {
        workspaceRevision: revision,
        now: accepted.now,
      });
      const proposal = s2dTailorProposal(t.handle, accepted, submitted);
      const artifactsDir = makeArtifactsDir();
      const provider = s2dTailorProvider(submitted, proposal, () => accepted.now);
      const { claim, outcome } = await runS2dTailor(t.handle, submitted, provider, artifactsDir, {
        now: accepted.now,
      });
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(t.handle, claim, outcome, accepted.now);
      const version = versionForRequest(t.handle, submitted.requestId);
      const texts = await readS2dArtifactTexts(t.handle, artifactsDir, version.id);
      // Renderers legitimately reflow whitespace; the canonical
      // bytes below assert exactness, the artifacts assert the
      // same words in order.
      const squashed = (text: string): string => text.replace(/\s+/g, " ");
      const want = squashed(EDITED);
      expect(squashed(texts.markdown)).toContain(want);
      expect(squashed(texts.docx)).toContain(want);
      expect(squashed(texts.pdf)).toContain(want);
      const row = t.handle.db
        .select({ contentJson: resumeVersions.contentJson })
        .from(resumeVersions)
        .where(eq(resumeVersions.id, version.id))
        .get();
      expect(row?.contentJson).toContain(EDITED);
      expect(provider.receivedInputs.length).toBe(1);
    });
  });
});

describe("S2CPB4 provider cannot alter frozen results", () => {
  it("a lying provider proposal fails retryably with frozen bytes intact", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world, S2B_JD, new Date().toISOString());
      const draft = s2dDraftV2(accepted, fittingOpsV2(accepted, EDITED), EDITED, "master");
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const submitted = s2dSubmit(t.handle, accepted, {
        workspaceRevision: revision,
        now: accepted.now,
      });
      const frozenBefore = readStep2GenerationInputs(t.handle, submitted.requestId)?.editedInputsJson;
      const artifactsDir = makeArtifactsDir();

      // The provider invents resume text contradicting the cited
      // fact: proposal validation refuses before any render.
      const recs = getRecommendations(t.handle, {
        jobId: accepted.basics.jobId,
        extractionId: accepted.basics.extractionId,
        profileVersionId: accepted.basics.profileVersionId,
      });
      if (!recs.ok) {
        throw new Error(`S2-CP-B guidance seed failed: ${recs.failure.error}`);
      }
      const lyingFacts = new Map(accepted.statements);
      lyingFacts.set("pm-fact-discovery", "Provider lies here with invented 999% growth.");
      const lying = proposalForRun({
        recommendations: recs.recommendations,
        factTexts: lyingFacts,
        jdSnapshotId: submitted.jdSnapshotId,
        candidateSnapshotId: submitted.candidateSnapshotId,
      });
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, submitted.workItemId))
        .run();
      const first = await runS2dTailor(
        t.handle,
        submitted,
        s2dTailorProvider(submitted, lying, () => accepted.now),
        artifactsDir,
        { now: accepted.now },
      );
      expect(first.outcome).toMatchObject({ result: "FAILED", errorCode: "INVALID_RESPONSE" });
      expect(first.outcome.terminal).not.toBe(true);
      finishS2dAttempt(t.handle, first.claim, first.outcome, accepted.now);
      expect(readStep2GenerationInputs(t.handle, submitted.requestId)?.editedInputsJson).toBe(
        frozenBefore,
      );
      expect(
        t.handle.db.select().from(resumeVersions).where(eq(resumeVersions.jobId, accepted.basics.jobId)).all(),
      ).toHaveLength(0);

      // Recovery with an honest provider renders the frozen bytes.
      const job = getTailoringJob(t.handle, accepted.basics.jobId);
      if (job === null) {
        throw new Error("S2-CP-B setup lost the job");
      }
      const retry = retryGeneration(t.handle, {
        jobId: accepted.basics.jobId,
        requestId: submitted.requestId,
        observedAttemptId: first.claim.claimed.currentAttemptId,
        observedRowVersion: job.rowVersion,
        now: accepted.now,
      });
      expect(retry).toMatchObject({ ok: true, replayed: false, status: "QUEUED" });
      const honest = s2dTailorProposal(t.handle, accepted, submitted);
      const provider = s2dTailorProvider(submitted, honest, () => accepted.now);
      const second = await runS2dTailor(t.handle, submitted, provider, artifactsDir, {
        now: accepted.now,
      });
      expect(second.outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(t.handle, second.claim, second.outcome, accepted.now);
      const version = versionForRequest(t.handle, submitted.requestId);
      const texts = await readS2dArtifactTexts(t.handle, artifactsDir, version.id);
      const squashed = (text: string): string => text.replace(/\s+/g, " ");
      expect(squashed(texts.markdown)).toContain(squashed(EDITED));
      expect(texts.markdown).not.toContain("999%");
    });
  });
});

describe("S2CPB6 v2 submit guards", () => {
  it("moved revisions and row versions refuse without writes", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const masterSummary = accepted.plan.positioning.keepMasterSummary;
      const first = s2dDraftV2(accepted, fittingOpsV2(accepted, null), masterSummary, "master");
      const saved1 = s2dSaveDraftV2(t.handle, accepted, first, 0);
      const submitted = s2dSubmit(t.handle, accepted, {
        workspaceRevision: saved1.revision,
        now: accepted.now,
      });
      expect(submitted.requestId).toBeTruthy();

      // The submit books last-request state on the workspace row;
      // a later save observes the moved revision.
      const current = readWorkspace(t.handle, accepted.basics.jobId)?.revision ?? 0;
      expect(current).toBeGreaterThan(saved1.revision);
      const second = s2dDraftV2(accepted, fittingOpsV2(accepted, EDITED), EDITED, "master");
      const saved2 = s2dSaveDraftV2(t.handle, accepted, second, current);
      const moved = getTailoringJob(t.handle, accepted.basics.jobId);
      // A submit naming a superseded revision refuses.
      const stale = submitGeneration(
        t.handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: current,
          observedRowVersion: moved?.rowVersion ?? 0,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(stale).toMatchObject({ ok: false, failure: { error: "workspace-conflict" } });

      const conflicted = submitGeneration(
        t.handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: saved2.revision,
          observedRowVersion: 999999,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(conflicted).toMatchObject({ ok: false, failure: { error: "job-conflict" } });
    });
  });
});

describe("S2CPB6 v2 crash recovery", () => {
  it("retry reuses exact frozen bytes with one version and one provider call", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world, S2B_JD, new Date().toISOString());
      const draft = s2dDraftV2(accepted, fittingOpsV2(accepted, EDITED), EDITED, "master");
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const submitted = s2dSubmit(t.handle, accepted, {
        workspaceRevision: revision,
        now: accepted.now,
      });
      const frozenBefore = readStep2GenerationInputs(t.handle, submitted.requestId)?.editedInputsJson;
      if (frozenBefore === undefined) {
        throw new Error("S2-CP-B setup lost the frozen inputs");
      }

      // Crash the first attempt on a simulated outage.
      t.handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, submitted.workItemId))
        .run();
      const artifactsDir = makeArtifactsDir();
      const first = claimFRun(t.handle, submitted.workItemId, { now: accepted.now });
      const failed = await fHandler({
        artifactsDir,
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => accepted.now,
      })(first.context);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "NETWORK" });
      finishS2dAttempt(t.handle, first, failed, accepted.now);
      const proposal = s2dTailorProposal(t.handle, accepted, submitted);

      // Later workspace edits and a Settings rotation land before
      // the retry: neither may leak into the frozen run.
      const current = readWorkspace(t.handle, accepted.basics.jobId)?.revision ?? 0;
      s2dSaveDraftV2(
        t.handle,
        accepted,
        s2dDraftV2(accepted, fittingOpsV2(accepted, "Later text that must not render."), "Later summary.", "master"),
        current,
      );
      rotatePmProfile(t.handle);

      const job = getTailoringJob(t.handle, accepted.basics.jobId);
      if (job === null) {
        throw new Error("S2-CP-B setup lost the job");
      }
      const retry = retryGeneration(t.handle, {
        jobId: accepted.basics.jobId,
        requestId: submitted.requestId,
        observedAttemptId: first.claimed.currentAttemptId,
        observedRowVersion: job.rowVersion,
        now: accepted.now,
      });
      expect(retry).toMatchObject({ ok: true, replayed: false, status: "QUEUED" });
      const provider = s2dTailorProvider(submitted, proposal, () => accepted.now);
      const { claim, outcome } = await runS2dTailor(t.handle, submitted, provider, artifactsDir, {
        now: accepted.now,
      });
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(t.handle, claim, outcome, accepted.now);

      expect(readStep2GenerationInputs(t.handle, submitted.requestId)?.editedInputsJson).toBe(
        frozenBefore,
      );
      const version = versionForRequest(t.handle, submitted.requestId);
      const texts = await readS2dArtifactTexts(t.handle, artifactsDir, version.id);
      const squashed = (text: string): string => text.replace(/\s+/g, " ");
      expect(squashed(texts.markdown)).toContain(squashed(EDITED));
      expect(texts.markdown).not.toContain("Later text that must not render.");
      expect(texts.markdown).not.toContain("ROTATED STATEMENT");
      expect(provider.receivedInputs.length).toBe(1);
    });
  });
});

/** Rename every PM fact and activate the new version (Settings rotation). */
function rotatePmProfile(handle: DatabaseHandle): void {
  const fixture = JSON.parse(
    readFileSync(new URL("../../fixtures/v1.2/pm-profile.json", import.meta.url), "utf8"),
  ) as {
    achievements: Array<Record<string, unknown> & { factId: string; text: string }>;
  };
  const document = {
    ...fixture,
    achievements: fixture.achievements.map((achievement, index) => ({
      ...achievement,
      factId: `${achievement.factId}-rotated`,
      text: `ROTATED STATEMENT ${index}`,
    })),
  };
  const imported = importCandidate(handle, { document, actor: "human" });
  if (!imported.ok) {
    throw new Error(`S2-CP-B rotation import failed: ${imported.error}`);
  }
  const activated = activateProfileVersion(handle, {
    versionId: imported.versionId,
    actor: "human",
  });
  if (!activated.ok) {
    throw new Error("S2-CP-B rotation activation failed");
  }
}

describe("S2CPB6 historical readers", () => {
  it("v1 plans still read as version 1 with v1 bytes", async () => {
    await withS2dDatabase(async (t, world) => {
      const v1 = await seedS2dAccepted(t.handle, world);
      const read = readPlanForJob(t.handle, v1.basics.jobId, null);
      if (!read.ok || read.value.version !== 1) {
        throw new Error("S2-CP-B setup cannot read the v1 plan");
      }
      expect(read.value.planHash).toBe(v1.planHash);
      expect(read.value.plan.suggestions.length).toBeGreaterThan(0);
      expect("eligibleRoles" in read.value).toBe(false);
      const stored = t.handle.sqlite
        .prepare("SELECT plan_json AS planJson FROM step2_plans WHERE id = ?")
        .get(v1.planRowId) as { planJson: string };
      expect((JSON.parse(stored.planJson) as { schemaVersion: string }).schemaVersion).toBe(
        "step2-plan/v1",
      );
    });
  });
});
