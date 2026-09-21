// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  generationRequests,
  newId,
  tailoringRequestInputs,
  workAttempts,
  workItems,
  type DatabaseHandle,
} from "../../../src/db";
import {
  insertPlan,
  markPreparationSucceeded,
  readPlan,
  readPreparationByJob,
  readStep2GenerationInputs,
} from "../../../src/db/step2";
import { readRequestInputs, readWorkspace } from "../../../src/db/tailoringWorkspace";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import {
  PreparationPlanV1,
  Step2DraftV1,
  Step2EditedInputsV1,
  Step2PolicyVersionsV1,
  Step2ValidationV1,
} from "../../../src/domain/step2";
import { getProfileVersion, setFactVerification } from "../../../src/db/candidates";
import {
  activateProfileVersion,
  getOrCreateCandidateSnapshot,
  getOrCreateJdSnapshot,
  importCandidate,
} from "../../../src/server/candidates";
import { submitGeneration } from "../../../src/server/generations";
import { retryGeneration } from "../../../src/server/retries";
import { getTailoringJob } from "../../../src/db/tailoring";
import { ProviderError } from "../../../src/tailoring/contract";
import {
  draftHashFor,
  hashStep2WorkflowInput,
  planHashFor,
  step2GenerationPolicies,
} from "../../../src/tailoring/step2policy";
import { F_T0, throwingProvider, claimFRun, fHandler, makeArtifactsDir, seedFRun } from "./f-world";
import { proposalForRun, factTextsForVersion } from "./f-world";
import type { CrossProfileWorld } from "../acceptance-v1.2/world";
import { parseStoredProfilePayload } from "../../../src/domain/candidate";
import {
  acceptV1Plan,
  claimS2b,
  finishS2bAttempt,
  proposalForS2b,
  scheduleS2b,
  seedS2bJob,
  S2B_JD,
} from "./s2b-world";
import { getRecommendations } from "../../../src/server/recommendations";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { s2bQ1 } from "./s2b-world";
import {
  finishS2dAttempt,
  readS2dArtifactTexts,
  runS2dTailor,
  s2dNow,
  s2dDraft,
  s2dSaveDraft,
  s2dSubmit,
  s2dTailorProposal,
  s2dTailorProvider,
  seedS2dAccepted,
  versionForRequest,
  withS2dDatabase,
  S2D_KEYED_ENV,
  type S2dAccepted,
} from "./s2d-world";

/**
 * WO-1.3-S2-D freeze legs (S2D2): G pins the plan, ordered edits,
 * evidence, validation, and policy versions into immutable inputs;
 * idempotent replay converges without writes while changed bytes
 * refuse; later workspace saves and Settings rotations neither
 * alter nor strand the frozen run; retries re-execute frozen bytes;
 * and older v1/v3 readers still pass through the same worker.
 */

const OP_ADD = "11111111-1111-4111-8111-111111111111";
const OP_X1 = "22222222-2222-4222-8222-222222222222";
const OP_X2 = "33333333-3333-4333-8333-333333333333";
const OP_X3 = "44444444-4444-4334-8444-444444444444";
const FIXED_REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fittingDraft(accepted: S2dAccepted, summaryText?: string): {
  draft: ReturnType<typeof s2dDraft>;
} {
  const draft = s2dDraft(
    accepted,
    [
      {
        op: "add",
        operationId: OP_ADD,
        suggestionId: accepted.usableSuggestion.suggestionId,
        roleId: accepted.usableSuggestion.roleId,
        editedText: null,
      },
      { op: "exclude", operationId: OP_X1, targetFactId: "pm-fact-discovery" },
      { op: "exclude", operationId: OP_X2, targetFactId: "pm-fact-pricing" },
      { op: "exclude", operationId: OP_X3, targetFactId: "pm-fact-cadence" },
    ],
    summaryText ?? accepted.plan.positioning.keepMasterSummary,
    "master",
  );
  return { draft };
}

function submitCounts(handle: DatabaseHandle): Record<string, number> {
  return {
    requests: handle.db.select().from(generationRequests).all().length,
    inputs: handle.db.select().from(tailoringRequestInputs).all().length,
    items: handle.db.select().from(workItems).all().length,
    attempts: handle.db.select().from(workAttempts).all().length,
  };
}

describe("S2D2 edited-plan freeze", () => {
  it("freezes plan, draft, validation, and policies into immutable inputs", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { draft } = fittingDraft(accepted);
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const submitted = s2dSubmit(handle, accepted, {
        requestId: FIXED_REQUEST_ID,
        workspaceRevision: revision,
        now: accepted.now,
      });

      const step2 = readStep2GenerationInputs(handle, FIXED_REQUEST_ID);
      expect(step2).not.toBeNull();
      if (step2 === null) {
        throw new Error("unreachable");
      }
      expect(step2.planId).toBe(accepted.planRowId);
      // Recompute every frozen hash from the immutable rows.
      const inputs = readRequestInputs(handle, FIXED_REQUEST_ID);
      if (inputs === null) {
        throw new Error("S2-D submit wrote no request inputs");
      }
      const frozenDraft = Step2DraftV1.parse(JSON.parse(inputs.focusJson) as unknown);
      const frozenPlan = PreparationPlanV1.parse(
        JSON.parse(inputs.recommendationsJson) as unknown,
      );
      expect(planHashFor(frozenPlan)).toBe(step2.planHash);
      expect(frozenDraft.planHash).toBe(step2.planHash);
      expect(draftHashFor(frozenDraft)).toBe(step2.draftHash);
      const edited = Step2EditedInputsV1.parse(JSON.parse(step2.editedInputsJson) as unknown);
      expect(edited.planId).toBe(frozenDraft.planId);
      expect(edited.summaryText).toBe(frozenDraft.summaryText);
      expect(edited.summarySource).toBe(frozenDraft.summarySource);
      expect(canonicalJson(edited.operations)).toBe(canonicalJson(frozenDraft.operations));
      expect(Step2PolicyVersionsV1.parse(JSON.parse(step2.policyVersionsJson) as unknown)).toEqual(
        step2GenerationPolicies(),
      );
      expect(
        hashStep2WorkflowInput({
          workspaceRevision: inputs.workspaceRevision,
          planId: step2.planId,
          planHash: step2.planHash,
          draftHash: step2.draftHash,
          validationId: step2.validationId,
          candidateSnapshotId: inputs.candidateSnapshotId,
          masterText: inputs.masterText,
          masterTextHash: inputs.masterTextHash,
          projectionVersion: "master-text/1",
          policies: step2GenerationPolicies(),
        }),
      ).toBe(inputs.inputHash);
      // Legacy steering columns stay canonically empty on v2 rows.
      const request = handle.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, FIXED_REQUEST_ID))
        .get();
      expect(request?.selectedKeywordsJson).toBe("[]");
      expect(request?.directivesText).toBeNull();
      // The bound verdict row covers the exact frozen bytes.
      const verdictRow = handle.sqlite
        .prepare(`SELECT verdict_json AS verdictJson FROM step2_draft_validations WHERE id = ?`)
        .get(step2.validationId) as { verdictJson: string };
      const validation = Step2ValidationV1.parse(JSON.parse(verdictRow.verdictJson) as unknown);
      expect(validation.planHash).toBe(step2.planHash);
      expect(validation.draftHash).toBe(step2.draftHash);
      expect(
        validation.segments.every((segment) => segment.verdict === "supported"),
      ).toBe(true);
      expect(validation.budget.exceeded).toBe(false);
      expect(submitted.workItemId).toBe(request?.workItemId);
    });
  });

  it("replays identically without writes; changed bytes and live doubles refuse", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { draft } = fittingDraft(accepted);
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const live = getTailoringJob(handle, accepted.basics.jobId);
      if (live === null) {
        throw new Error("S2-D setup lost the job");
      }
      const first = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: FIXED_REQUEST_ID,
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(first).toMatchObject({ ok: true, replayed: false });

      const q1Before = s2bQ1(handle);
      const countsBefore = submitCounts(handle);
      const replayed = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: FIXED_REQUEST_ID,
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(replayed).toMatchObject({ ok: true, replayed: true });
      expect(submitCounts(handle)).toEqual(countsBefore);

      // Same id, changed bytes: fork, not replay.
      const forked = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: FIXED_REQUEST_ID,
          workspaceRevision: revision,
          observedRowVersion: 99,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(forked).toMatchObject({
        ok: false,
        failure: { error: "idempotency-mismatch" },
      });

      // Different id while the first run is live: busy, not queued.
      const live2 = getTailoringJob(handle, accepted.basics.jobId);
      const stored2 = readWorkspace(handle, accepted.basics.jobId);
      const doubled = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: stored2?.revision ?? 0,
          observedRowVersion: live2?.rowVersion ?? 0,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(doubled).toMatchObject({
        ok: false,
        failure: { error: "generation-busy" },
      });
      expect(s2bQ1(handle)).toEqual(q1Before);
      expect(q1Before.requests).toBeGreaterThan(0);
    });
  });

  it("later workspace saves do not alter the frozen run", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const originalSummary = accepted.plan.positioning.keepMasterSummary;
      const { draft } = fittingDraft(accepted, originalSummary);
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const submitted = s2dSubmit(handle, accepted, {
        workspaceRevision: revision,
        now: accepted.now,
      });
      const inputsBefore = readRequestInputs(handle, submitted.requestId);

      // A later save rewrites the draft (different summary, kept
      // valid) while the queued run waits. The submit stamped the
      // workspace, so the save observes the live revision.
      const angle = accepted.plan.positioning.angles[0];
      if (angle === undefined) {
        throw new Error("S2-D setup lost the plan angle");
      }
      const stamped = readWorkspace(handle, accepted.basics.jobId)?.revision ?? 0;
      expect(stamped).toBe(revision + 1);
      const { revision: revision2 } = s2dSaveDraft(
        handle,
        accepted,
        fittingDraft(accepted, angle.summaryText).draft,
        stamped,
      );
      expect(revision2).toBe(stamped + 1);

      const proposal = s2dTailorProposal(handle, accepted, submitted);
      const artifactsDir = makeArtifactsDir();
      const { claim, outcome } = await runS2dTailor(
        handle,
        submitted,
        s2dTailorProvider(submitted, proposal, () => accepted.now),
        artifactsDir,
        { now: accepted.now },
      );
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(handle, claim, outcome, accepted.now);
      expect(readRequestInputs(handle, submitted.requestId)).toEqual(inputsBefore);
      const version = versionForRequest(handle, submitted.requestId);
      const markdown = await readMarkdown(handle, artifactsDir, version.id);
      expect(markdown).toContain(originalSummary);
      expect(markdown).not.toContain(angle.summaryText);
    });
  });

  it("later settings rotations neither strand nor alter frozen work and retries", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const originalSummary = accepted.plan.positioning.keepMasterSummary;
      const { draft } = fittingDraft(accepted, originalSummary);
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);
      const submitted = s2dSubmit(handle, accepted, {
        workspaceRevision: revision,
        now: accepted.now,
      });

      // Fail the first attempt terminally (single-attempt budget).
      handle.db
        .update(workItems)
        .set({ maxAttempts: 1 })
        .where(eq(workItems.id, submitted.workItemId))
        .run();
      const artifactsDir = makeArtifactsDir();
      const first = claimFRun(handle, submitted.workItemId, { now: accepted.now });
      const failed = await fHandler({
        artifactsDir,
        provider: throwingProvider(new ProviderError("NETWORK", "simulated outage")),
        clock: () => accepted.now,
      })(first.context);
      expect(failed).toMatchObject({ result: "FAILED", errorCode: "NETWORK" });
      finishS2dAttempt(handle, first, failed, accepted.now);
      // Script the recovery proposal before rotating: guidance
      // serves the active version only, and the rotation moves it.
      const proposal = s2dTailorProposal(handle, accepted, submitted);

      // Rotate Settings: new version, renamed facts, changed text —
      // the captured version stays readable but is no longer active.
      const rotated = rotatePmProfile(handle, world.pmProfileId);
      expect(rotated.versionId).not.toBe(accepted.basics.profileVersionId);

      const job = getTailoringJob(handle, accepted.basics.jobId);
      if (job === null) {
        throw new Error("S2-D setup lost the job");
      }
      const retry = retryGeneration(handle, {
        jobId: accepted.basics.jobId,
        requestId: submitted.requestId,
        observedAttemptId: first.claimed.currentAttemptId,
        observedRowVersion: job.rowVersion,
        now: accepted.now,
      });
      expect(retry).toMatchObject({ ok: true, replayed: false, status: "QUEUED" });

      const { claim, outcome } = await runS2dTailor(
        handle,
        submitted,
        s2dTailorProvider(submitted, proposal, () => accepted.now),
        artifactsDir,
        { now: accepted.now },
      );
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(handle, claim, outcome, accepted.now);
      const version = versionForRequest(handle, submitted.requestId);
      const markdown = await readMarkdown(handle, artifactsDir, version.id);
      expect(markdown).toContain(originalSummary);
      expect(markdown).not.toContain("ROTATED STATEMENT");
    });
  });

  it("older v1 readers still submit and execute through the same worker", async () => {
    await withS2dDatabase(async (t, world) => {
      const run = seedFRun(t.handle, world);
      const recs = getRecommendations(t.handle, {
        jobId: run.basics.jobId,
        extractionId: run.basics.extractionId,
        profileVersionId: run.basics.profileVersionId,
      });
      if (!recs.ok) {
        throw new Error("S2-D v1 guidance seed failed");
      }
      const proposal = proposalForRun({
        recommendations: recs.recommendations,
        factTexts: factTextsForVersion(t.handle, run.basics.profileVersionId),
        jdSnapshotId: run.jdSnapshotId,
        candidateSnapshotId: run.candidateSnapshotId,
      });
      const artifactsDir = makeArtifactsDir();
      const { claimed, context } = claimFRun(t.handle, run.workItemId, { now: F_T0 });
      const outcome = await fHandler({
        artifactsDir,
        provider: new TestProvider({ proposals: { [run.jdSnapshotId]: proposal } }),
        clock: () => F_T0,
      })(context);
      expect(outcome).toMatchObject({ result: "SUCCEEDED" });
      finishS2dAttempt(
        t.handle,
        { claimed, context },
        outcome,
        F_T0,
      );
      expect(versionForRequest(t.handle, run.requestId).id).toBeTruthy();
    });
  });

  it("plan drift fails plan-stale and evidence drift fails profile-not-ready", async () => {
    await withS2dDatabase(async (t, world) => {
      const handle = t.handle;
      const accepted = await seedS2dAccepted(handle, world);
      const { draft } = fittingDraft(accepted);
      const { revision } = s2dSaveDraft(handle, accepted, draft, 0);

      // A second cycle supersedes the accepted plan; the stored
      // draft still binds the first one.
      const previous = readPlan(handle, accepted.planRowId);
      if (previous === null) {
        throw new Error("S2-D setup lost the plan");
      }
      const nextId = "55555555-5555-4555-8555-555555555555";
      const next = {
        ...(JSON.parse(previous.planJson) as Record<string, unknown>),
        planId: nextId,
        rationale: "Second S2-D cycle.",
      };
      const nextHash = planHashFor(next as Parameters<typeof planHashFor>[0]);
      insertPlan(handle, {
        id: nextId,
        preparationId: previous.preparationId,
        planJson: canonicalJson(next),
        planHash: nextHash,
        providerId: previous.providerId,
        model: previous.model,
        promptVersion: "prepare-prompt/v1",
        proposalSchemaVersion: "preparation-proposal/v1",
        claimsPolicyVersion: "step2-claims/1",
        inputHash: previous.inputHash,
        proposalHash: previous.proposalHash,
        attemptId: previous.attemptId,
        validationJson: previous.validationJson,
        supersedesPlanId: previous.id,
        now: accepted.now,
      });
      markPreparationSucceeded(handle, {
        preparationId: previous.preparationId,
        planId: nextId,
        now: accepted.now,
      });
      const q1Before = s2bQ1(handle);
      const stale = submitGeneration(
        handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: getTailoringJob(handle, accepted.basics.jobId)?.rowVersion ?? 0,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(stale).toMatchObject({ ok: false, failure: { error: "plan-stale" } });
      expect(s2bQ1(handle)).toEqual(q1Before);

      // Evidence drift via honest mid-flight review: a PENDING
      // fact approved after capture changes the digest, so the
      // §8.6 re-read hook fails profile-not-ready instead of
      // running on stale evidence. (Payloads, approved facts, and
      // preparation bindings are trigger-immutable, so review is
      // the only reachable drift vector.)
      await withS2dDatabase(async (t2, world2) => {
        const handle2 = t2.handle;
        const drifted = await seedApprovalDriftWorld(handle2, world2);
        const q1Before = s2bQ1(handle2);
        const refused = submitGeneration(
          handle2,
          {
            jobId: drifted.accepted.basics.jobId,
            requestId: newId(),
            workspaceRevision: drifted.revision,
            observedRowVersion:
              getTailoringJob(handle2, drifted.accepted.basics.jobId)?.rowVersion ?? 0,
            actor: "human",
            now: drifted.accepted.now,
          },
          { env: S2D_KEYED_ENV },
        );
        expect(refused).toMatchObject({
          ok: false,
          failure: { error: "profile-not-ready" },
        });
        expect(s2bQ1(handle2)).toEqual(q1Before);
      });
    });
  });
});

async function readMarkdown(
  handle: DatabaseHandle,
  artifactsDir: string,
  versionId: string,
): Promise<string> {
  return (await readS2dArtifactTexts(handle, artifactsDir, versionId)).markdown;
}

function clonePmDoc(suffix: string, pendingFactId: string | null): Record<string, unknown> {
  const fixture = JSON.parse(
    readFileSync(new URL("../../fixtures/v1.2/pm-profile.json", import.meta.url), "utf8"),
  ) as {
    achievements: Array<Record<string, unknown> & { factId: string }>;
  };
  return {
    ...fixture,
    achievements: fixture.achievements.map((achievement) => ({
      ...achievement,
      factId: `${achievement.factId}${suffix}`,
      verification:
        pendingFactId !== null && `${achievement.factId}${suffix}` === pendingFactId
          ? "PENDING"
          : achievement.verification,
    })),
  };
}

/**
 * Custom profile (renamed facts, one PENDING) + job + accepted plan
 * + saved draft, then the pending fact is honestly approved: the
 * captured evidence digest no longer verifies.
 */
async function seedApprovalDriftWorld(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
): Promise<{ accepted: S2dAccepted; revision: number }> {
  const now = s2dNow();
  const pendingFactId = "pm-fact-gtm-drift";
  const imported = importCandidate(handle, {
    document: clonePmDoc("-drift", pendingFactId),
    actor: "human",
  });
  if (!imported.ok) {
    throw new Error(`S2-D drift import failed: ${imported.error}`);
  }
  const versionRow = getProfileVersion(handle, imported.versionId);
  if (versionRow === null) {
    throw new Error("S2-D drift import returned no version row");
  }
  const activated = activateProfileVersion(handle, {
    versionId: imported.versionId,
    actor: "human",
  });
  if (!activated.ok) {
    throw new Error("S2-D drift activation failed");
  }
  const basics = seedS2bJob(handle, world);
  const jd = getOrCreateJdSnapshot(handle, {
    jobId: basics.jobId,
    extractionId: basics.extractionId,
    jdText: S2B_JD,
  });
  const candidate = getOrCreateCandidateSnapshot(handle, {
    profileVersionId: imported.versionId,
  });
  if (!jd.ok || !candidate.ok) {
    throw new Error("S2-D drift snapshots failed");
  }
  const discovery = "pm-fact-discovery-drift";
  const discoveryText = factTextsForVersion(handle, imported.versionId).get(discovery);
  if (discoveryText === undefined) {
    throw new Error("S2-D drift import lost the discovery text");
  }
  const proposal = proposalForS2b({
    jdText: canonicalText(S2B_JD),
    jdSnapshotId: jd.snapshotId,
    candidateSnapshotId: candidate.snapshotId,
    quotes: [
      { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: [discovery] },
      { text: "pricing", importance: "required", matchStatus: "matched", factIds: ["pm-fact-pricing-drift"] },
      { text: "KPI measurement", importance: "preferred", matchStatus: "gap", factIds: [] },
    ],
    angles: [
      {
        title: "Discovery-led roadmap",
        summaryText: "Discovery interviews that reshape roadmaps and lift conversion.",
        factIds: [discovery, "pm-fact-roadmap-drift"],
      },
    ],
    suggestions: [
      {
        roleId: "emp-harbor",
        text: canonicalText(discoveryText),
        factIds: [discovery],
      },
    ],
  });
  const scheduled = scheduleS2b(handle, basics, { profileId: versionRow.profileId, now });
  const claimed = claimS2b(handle, { now });
  // Direct v1 accept: the real handler emits v2 plans now, so the
  // preserved v1 drift path is seeded with the pure v1 builder
  // over the renamed-fact payload (no provider round-trip).
  const driftPayload = parseStoredProfilePayload(
    JSON.parse(versionRow.payloadJson) as unknown,
  );
  const v1 = acceptV1Plan(handle, {
    basics,
    preparationId: scheduled.preparationId,
    attemptId: claimed.attemptId,
    profileVersionId: imported.versionId,
    payload: driftPayload,
    proposal,
    jdText: S2B_JD,
    now,
  });
  finishS2bAttempt(handle, {
    ...claimed,
    outcome: { result: "SUCCEEDED", terminal: true, outputHash: v1.planHash },
    now,
  });
  const preparation = readPreparationByJob(handle, basics.jobId);
  if (preparation?.acceptedPlanId === null || preparation?.acceptedPlanId === undefined) {
    throw new Error("S2-D drift setup produced no accepted plan");
  }
  const stored = readPlan(handle, preparation.acceptedPlanId);
  if (stored === null) {
    throw new Error("S2-D drift setup cannot read the plan");
  }
  const plan = PreparationPlanV1.parse(JSON.parse(stored.planJson) as unknown);
  const usable = plan.suggestions.find((suggestion) => suggestion.usable);
  if (usable === undefined) {
    throw new Error("S2-D drift setup produced no usable suggestion");
  }
  const accepted: S2dAccepted = {
    basics: { ...basics, profileId: versionRow.profileId, profileVersionId: imported.versionId },
    world,
    preparationId: scheduled.preparationId,
    planRowId: stored.id,
    planHash: stored.planHash,
    plan,
    usableSuggestion: {
      suggestionId: usable.suggestionId,
      roleId: usable.roleId,
      text: usable.text,
      factIds: [...usable.factIds],
    },
    statements: factTextsForVersion(handle, imported.versionId),
    now,
  };
  // Harbor carries 4 approved master bullets here (gtm is pending);
  // one add plus two excludes fits the 3/role budget.
  const { revision } = s2dSaveDraft(
    handle,
    accepted,
    s2dDraft(
      accepted,
      [
        {
          op: "add",
          operationId: OP_ADD,
          suggestionId: usable.suggestionId,
          roleId: usable.roleId,
          editedText: null,
        },
        { op: "exclude", operationId: OP_X1, targetFactId: `${"pm-fact-discovery"}-drift` },
        { op: "exclude", operationId: OP_X2, targetFactId: `${"pm-fact-pricing"}-drift` },
      ],
      plan.positioning.keepMasterSummary,
      "master",
    ),
    0,
  );
  if (!setFactVerification(handle, pendingFactId, "APPROVED")) {
    throw new Error("S2-D drift setup could not approve the pending fact");
  }
  return { accepted, revision };
}

/** Import a renamed-fact PM variant and activate it (Settings rotation). */
function rotatePmProfile(
  handle: DatabaseHandle,
  profileId: string,
): { versionId: string } {
  const fixture = JSON.parse(
    readFileSync(new URL("../../fixtures/v1.2/pm-profile.json", import.meta.url), "utf8"),
  ) as {
    achievements: Array<Record<string, unknown> & { factId: string; text: string }>;
  };
  const achievements = fixture.achievements.map((achievement, index) => ({
    ...achievement,
    factId: `${achievement.factId}-v2`,
    text: index === 0 ? "ROTATED STATEMENT: discovery rewired." : achievement.text,
  }));
  const imported = importCandidate(handle, {
    document: { ...fixture, achievements },
    actor: "human",
    profileId,
  });
  if (!imported.ok) {
    throw new Error(`S2-D rotation import failed: ${imported.error}`);
  }
  const activated = activateProfileVersion(handle, {
    versionId: imported.versionId,
    actor: "human",
  });
  if (!activated.ok) {
    throw new Error("S2-D rotation activation failed");
  }
  return { versionId: imported.versionId };
}
