// @vitest-environment node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GET as planGET,
} from "../../../app/api/jobs/[id]/tailoring/plan/route";
import {
  PUT as workspacePUT,
} from "../../../app/api/jobs/[id]/tailoring/workspace/route";
import {
  newId,
  openDatabase,
  type DatabaseHandle,
} from "../../../src/db";
import { readPlan, readPreparationByJob, readStep2GenerationInputs } from "../../../src/db/step2";
import { getTailoringJob } from "../../../src/db/tailoring";
import { canonicalText } from "../../../src/domain/canonical";
import {
  PreparationPlanV1,
  PreparationProposalV1,
  type PreparationProposalV1 as PreparationProposalV1Type,
} from "../../../src/domain/step2";
import {
  PreparationPlanV2,
  Step2EditedInputsV2,
  type PreparationProposalV2 as PreparationProposalV2Type,
} from "../../../src/domain/step2Correction";
import { buildWorkspaceETag } from "../../../src/domain/tailoringWorkspace";
import { submitGeneration } from "../../../src/server/generations";
import {
  readPlanForJob,
  validateDraft,
  validateDraftV2,
} from "../../../src/server/preparation";
import {
  getWorkspaceView,
  saveWorkspaceV2,
  saveWorkspaceV3,
} from "../../../src/server/tailoringWorkspace";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import {
  buildAcceptedPlan,
  type BuildAcceptedPlanInput,
  type ProposalFact,
} from "../../../src/tailoring/preparePlan";
import {
  buildAcceptedPlanV2,
  type BuildAcceptedPlanV2Input,
} from "../../../src/tailoring/preparePlanV2";
import { masterProjectionHashFor } from "../../../src/tailoring/step2policy";
import { seedCrossProfileWorld, type CrossProfileWorld } from "../acceptance-v1.2/world";
import {
  getRequest,
  mutationHeaders,
  readJson,
  routeParams,
  setupIsolatedRoot,
  type IsolatedRoot,
} from "../routes/_helpers";
import {
  acceptV1Plan,
  claimS2b,
  finishS2bAttempt,
  pmEvidenceFor,
  proposalForS2b,
  proposalForS2bV2,
  runS2bAttempt,
  s2bProposalKit,
  s2bQ1,
  s2bSnapshotIds,
  S2B_JD,
  S2B_KEYED_ENV,
  scheduleS2b,
  seedS2bJob,
  withS2bDatabase,
} from "./s2b-world";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import {
  s2dDraft,
  s2dDraftV2,
  s2dNow,
  s2dSaveDraft,
  s2dSaveDraftV2,
  seedS2dAccepted,
  seedS2dAcceptedV2,
  withS2dDatabase,
  S2D_KEYED_ENV,
  type S2dAccepted,
  type S2dAcceptedV2,
} from "./s2d-world";
import { workspaceRecommendationsProvider } from "../../../src/server/recommendations";

/**
 * WO-1.3-S2-CP-A / S2CPA5: adversarial pins for the correction
 * target, FLIPPED in S2-CP-B. Every pin shares its setup with a
 * passing guard, so a broken setup shows as a guard failure —
 * never as a silently satisfied pin. Guards titled "preserved v1"
 * pin the byte-identical v1 path; pins prove the corrected v2/v3
 * behavior end to end (real pipeline, real services). The CP-A
 * TARGET comments are kept as provenance for each flip.
 */

function keyedEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(S2B_KEYED_ENV)) {
    if (!(key in previous)) {
      previous[key] = process.env[key];
    }
    process.env[key] = value;
  }
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function putRequest(path: string, body: unknown, ifMatch: string | null): Request {
  const headers: Record<string, string> = {
    ...mutationHeaders(),
    "content-type": "application/json",
  };
  if (ifMatch !== null) {
    headers["if-match"] = ifMatch;
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function worldFacts(handle: DatabaseHandle, world: CrossProfileWorld): ProposalFact[] {
  const evidence = pmEvidenceFor(handle, world);
  return evidence.payload.achievements.map((achievement) => ({
    factId: achievement.factId,
    statement: achievement.text,
    verification: achievement.verification,
    profileVersionId: world.pmVersionId,
    employmentId: achievement.employmentId ?? null,
    metrics: [...achievement.metrics],
  }));
}

function builderInputFor(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  jdText: string,
  proposal: PreparationProposalV1Type,
  facts: ProposalFact[],
): BuildAcceptedPlanInput {
  const basics = seedS2bJob(handle, world, jdText);
  scheduleS2b(handle, basics, { profileId: world.pmProfileId });
  const row = readPreparationByJob(handle, basics.jobId);
  if (row === null) {
    throw new Error("S2-CP-A setup left no preparation row");
  }
  const evidence = pmEvidenceFor(handle, world);
  return {
    planId: newId(),
    preparationId: row.id,
    extractionId: basics.extractionId,
    jdHash: sha256HexUtf8(canonicalText(jdText)),
    canonicalJdText: canonicalText(jdText),
    profileVersionId: world.pmVersionId,
    evidenceHash: row.evidenceHash,
    masterProjectionHash: masterProjectionHashFor(evidence.payload),
    payload: evidence.payload,
    facts,
    proposal,
  };
}

/**
 * Real PREPARE cycle whose accepted plan separates the summary
 * origin from the plan union: the angle cites discovery only
 * while a second suggestion cites pricing, so the v1 union
 * {discovery, pricing} strictly contains the chosen origin.
 * Returns the S2-D accepted shape so drafts save normally.
 */
async function seedUnionAccepted(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
): Promise<S2dAccepted> {
  const now = s2dNow();
  const basics = seedS2bJob(handle, world, S2B_JD);
  const snapshots = s2bSnapshotIds(handle, basics, S2B_JD);
  const evidence = pmEvidenceFor(handle, world);
  const textOf = (factId: string): string => {
    const found = evidence.payload.achievements.find(
      (achievement) => achievement.factId === factId,
    );
    if (found === undefined) {
      throw new Error(`S2-CP-A setup lost fact ${factId}`);
    }
    return canonicalText(found.text);
  };
  const proposal = proposalForS2b({
    jdText: canonicalText(S2B_JD),
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    quotes: [
      { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
      { text: "pricing", importance: "required", matchStatus: "matched", factIds: ["pm-fact-pricing"] },
    ],
    angles: [
      { title: "Discovery-led", summaryText: "Discovery-led PM driving growth.", factIds: ["pm-fact-discovery"] },
    ],
    suggestions: [
      { roleId: "emp-harbor", text: textOf("pm-fact-discovery"), factIds: ["pm-fact-discovery"] },
      { roleId: "emp-harbor", text: textOf("pm-fact-pricing"), factIds: ["pm-fact-pricing"] },
    ],
  });
  const scheduled = scheduleS2b(handle, basics, { profileId: world.pmProfileId, now });
  const claimed = claimS2b(handle, { now });
  // Direct v1 accept (preserved path): the handler emits v2 now.
  const v1 = acceptV1Plan(handle, {
    basics,
    preparationId: scheduled.preparationId,
    attemptId: claimed.attemptId,
    profileVersionId: world.pmVersionId,
    payload: evidence.payload,
    proposal,
    jdText: S2B_JD,
    now,
  });
  finishS2bAttempt(handle, {
    ...claimed,
    outcome: { result: "SUCCEEDED", terminal: true, outputHash: v1.planHash },
    now,
  });
  const stored = readPlan(handle, v1.planRowId);
  if (stored === null) {
    throw new Error("S2-CP-A setup cannot read the accepted plan");
  }
  const plan = PreparationPlanV1.parse(JSON.parse(stored.planJson) as unknown);
  const usable = plan.suggestions.find((suggestion) => suggestion.usable);
  if (usable === undefined) {
    throw new Error("S2-CP-A setup produced no usable suggestion");
  }
  return {
    basics,
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
    statements: new Map(),
    now,
  };
}

/**
 * v2 twin of the union setup: the same origin/union split goes
 * through the REAL v2 pipeline, so the flipped summary pin
 * proves selected-origin anchors end to end.
 */
async function seedUnionAcceptedV2(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
): Promise<S2dAcceptedV2> {
  const now = s2dNow();
  const basics = seedS2bJob(handle, world, S2B_JD);
  const snapshots = s2bSnapshotIds(handle, basics, S2B_JD);
  const evidence = pmEvidenceFor(handle, world);
  const textOf = (factId: string): string => {
    const found = evidence.payload.achievements.find(
      (achievement) => achievement.factId === factId,
    );
    if (found === undefined) {
      throw new Error(`S2-CP-B setup lost fact ${factId}`);
    }
    return canonicalText(found.text);
  };
  const canonicalJd = canonicalText(S2B_JD);
  const proposal = proposalForS2bV2({
    jdText: canonicalJd,
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    extractionId: basics.extractionId,
    jdHash: sha256HexUtf8(canonicalJd),
    quotes: [
      { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
      { text: "pricing", importance: "required", matchStatus: "matched", factIds: ["pm-fact-pricing"] },
    ],
    angles: [
      { title: "Discovery-led", summaryText: "Discovery-led PM driving growth.", factIds: ["pm-fact-discovery"], links: [0] },
    ],
    suggestions: [
      { roleId: "emp-harbor", text: textOf("pm-fact-discovery"), factIds: ["pm-fact-discovery"], links: [0] },
      { roleId: "emp-harbor", text: textOf("pm-fact-pricing"), factIds: ["pm-fact-pricing"], links: [1] },
    ],
  });
  const scheduled = scheduleS2b(handle, basics, { profileId: world.pmProfileId, now });
  const claimed = claimS2b(handle, { now });
  const provider = new TestPrepareProvider({
    proposals: { [snapshots.jdSnapshotId]: proposal },
  });
  const outcome = await runS2bAttempt(handle, claimed, provider, { now });
  if (outcome.result !== "SUCCEEDED") {
    throw new Error(`S2-CP-B setup cycle failed: ${outcome.result} ${outcome.errorCode ?? ""}`);
  }
  finishS2bAttempt(handle, { ...claimed, outcome, now });
  const preparation = readPreparationByJob(handle, basics.jobId);
  if (preparation?.acceptedPlanId === null || preparation?.acceptedPlanId === undefined) {
    throw new Error("S2-CP-B setup produced no accepted plan");
  }
  const stored = readPlan(handle, preparation.acceptedPlanId);
  if (stored === null) {
    throw new Error("S2-CP-B setup cannot read the accepted plan");
  }
  const plan = PreparationPlanV2.parse(JSON.parse(stored.planJson) as unknown);
  const usable = plan.suggestions.find((suggestion) => suggestion.usable);
  if (usable === undefined) {
    throw new Error("S2-CP-B setup produced no usable suggestion");
  }
  return {
    basics,
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
    statements: new Map(),
    now,
  };
}

/**
 * v2 builder input over one freshly scheduled job: the proposal links
 * are computed with the REAL phrase ids for this job's
 * extraction/hash, so kept-vs-foreign linkage is exact. An
 * optional mutator rewrites the proposal (e.g. foreign links).
 */
function builderInputForV2(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  mutate?: (proposal: PreparationProposalV2Type) => PreparationProposalV2Type,
): BuildAcceptedPlanV2Input {
  const basics = seedS2bJob(handle, world, S2B_JD);
  scheduleS2b(handle, basics, { profileId: world.pmProfileId });
  const row = readPreparationByJob(handle, basics.jobId);
  if (row === null) {
    throw new Error("S2-CP-B setup left no preparation row");
  }
  const snapshots = s2bSnapshotIds(handle, basics, S2B_JD);
  const evidence = pmEvidenceFor(handle, world);
  const canonicalJd = canonicalText(S2B_JD);
  const jdHash = sha256HexUtf8(canonicalJd);
  let proposal = proposalForS2bV2({
    jdText: canonicalJd,
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    extractionId: basics.extractionId,
    jdHash,
    quotes: [
      { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
    ],
    suggestions: [
      { roleId: "emp-harbor", text: "Discovery text.", factIds: ["pm-fact-discovery"], links: [0] },
    ],
  });
  if (mutate !== undefined) {
    proposal = mutate(proposal);
  }
  return {
    planId: newId(),
    preparationId: row.id,
    extractionId: basics.extractionId,
    jdHash,
    canonicalJdText: canonicalJd,
    profileVersionId: world.pmVersionId,
    evidenceHash: row.evidenceHash,
    masterProjectionHash: masterProjectionHashFor(evidence.payload),
    payload: evidence.payload,
    facts: worldFacts(handle, world),
    proposal,
  };
}

function linkedProposal(handle: DatabaseHandle, world: CrossProfileWorld): PreparationProposalV1Type {
  const basics = seedS2bJob(handle, world, S2B_JD);
  const snapshots = s2bSnapshotIds(handle, basics, S2B_JD);
  return proposalForS2b({
    jdText: canonicalText(S2B_JD),
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    quotes: [
      { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
    ],
    suggestions: [
      { roleId: "emp-harbor", text: "Discovery text.", factIds: ["pm-fact-discovery"] },
    ],
  });
}

describe("S2CPA1 pin: v3 saves and v2 rows are not served yet", () => {
  it("guard: a v2 draft save succeeds on the accepted plan", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      const draft = s2dDraft(accepted, [], "Master summary placeholder.", "master");
      const { revision } = s2dSaveDraft(t.handle, accepted, draft, 0);
      expect(revision).toBe(1);
    });
  });

  it("PUT accepts a tailoring-workspace/v3 body", async () => {
    const isolated: IsolatedRoot = setupIsolatedRoot("job-tracker-v13-s2cpa-");
    const savedEnv: Record<string, string | undefined> = {};
    keyedEnv(savedEnv);
    try {
      const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
      let jobId = "";
      let extractionId = "";
      let profileId = "";
      let profileVersionId = "";
      try {
        const world = seedCrossProfileWorld({
          handle,
          dir: isolated.root,
          dbPath: join(isolated.root, "job-tracker.sqlite"),
          cleanup: () => {},
        });
        const basics = seedS2bJob(handle, world);
        jobId = basics.jobId;
        extractionId = basics.extractionId;
        profileId = basics.profileId;
        profileVersionId = basics.profileVersionId;
      } finally {
        handle.close();
      }
      const path = `/api/jobs/${jobId}/tailoring/workspace`;
      const created = await workspacePUT(
        putRequest(
          path,
          {
            schemaVersion: "tailoring-workspace/v3",
            extractionId,
            profileId,
            profileVersionId,
            requestKind: "INITIAL",
            parentVersionId: null,
            revisionNote: null,
            planId: null,
            planHash: null,
            recommendationHash: null,
            draft: null,
          },
          buildWorkspaceETag(jobId, 0),
        ),
        routeParams(jobId),
      );
      // TARGET (S2-CP-B): v3 empty-editor saves are accepted.
      expect(created.status).toBe(201);
    } finally {
      restoreEnv(savedEnv);
      isolated.restoreEnv();
      isolated.cleanup();
    }
  });

  it("guard: a v1 verdict row inserts under the current CHECK", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      t.handle.sqlite
        .prepare(
          "INSERT INTO step2_draft_validations (id, job_id, plan_id, workspace_revision, draft_hash, verdict_json, policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          newId(),
          accepted.basics.jobId,
          accepted.planRowId,
          1,
          "b".repeat(64),
          "{}",
          "step2-claims/1",
          accepted.now,
        );
      const count = t.handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM step2_draft_validations WHERE policy_version = 'step2-claims/1'")
        .get() as { n: number };
      expect(count.n).toBe(1);
    });
  });

  it("migration 0011 accepts step2-claims/2 verdict rows", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      // TARGET (S2-CP-B): the widened s2_verdict_policy CHECK accepts /2.
      expect(() =>
        t.handle.sqlite
          .prepare(
            "INSERT INTO step2_draft_validations (id, job_id, plan_id, workspace_revision, draft_hash, verdict_json, policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            newId(),
            accepted.basics.jobId,
            accepted.planRowId,
            1,
            "c".repeat(64),
            "{}",
            "step2-claims/2",
            accepted.now,
          ),
      ).not.toThrow();
    });
  });

  it("guard: 0011 exists and is applied after 0010", async () => {
    await withS2dDatabase(async (t) => {
      const files = readdirSync(join(process.cwd(), "drizzle"));
      expect(files.some((name) => name.startsWith("0011_"))).toBe(true);
      expect(files).toContain("0008_tailoring_workspaces.sql");
      expect(files).toContain("0009_step2_preparation.sql");
      expect(files).toContain("0010_step2_publish_fence.sql");
      const rows = t.handle.sqlite
        .prepare("SELECT version AS version FROM _schema_migrations")
        .all() as Array<{ version: string }>;
      const versions = rows.map((row) => row.version).sort();
      expect(versions.some((version) => version.includes("0010"))).toBe(true);
      expect(versions.some((version) => version.includes("0011"))).toBe(true);
      expect(versions[versions.length - 1]).toMatch(/0011/);
    });
  });
});

describe("S2CPA2 pin: user-edited unsupported text generates verbatim", () => {
  const EDITED = "Led customer discovery with 40+ buyers, owning NetSuite rollout and P&L, lifting revenue 300%.";

  it("guard (preserved v1): the edit saves but the v1 S2-D gate blocks it", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "add",
            operationId: newId(),
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: EDITED,
          },
        ],
        EDITED,
        "edited",
      );
      const { revision } = s2dSaveDraft(t.handle, accepted, draft, 0);
      expect(revision).toBe(1);
      const live = getTailoringJob(t.handle, accepted.basics.jobId);
      if (live === null) {
        throw new Error("S2-CP-A setup lost the job");
      }
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(submitted).toMatchObject({ ok: false, failure: { error: "unresolved-evidence" } });
    });
  });

  it("the same edit submits and freezes as USER_EDITED", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      // Harbor carries 5 master bullets; the add plus three
      // excludes fits the 3/role submit budget.
      const draft = s2dDraftV2(
        accepted,
        [
          {
            op: "add",
            operationId: newId(),
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: EDITED,
          },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-pricing" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-cadence" },
          { op: "exclude", operationId: newId(), targetFactId: "pm-fact-roadmap" },
        ],
        EDITED,
        "master",
      );
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const live = getTailoringJob(t.handle, accepted.basics.jobId);
      if (live === null) {
        throw new Error("S2-CP-B setup lost the job");
      }
      const requestId = newId();
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: accepted.basics.jobId,
          requestId,
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      // TARGET (S2-CP-B), flipped: user edits are generatable;
      // the freeze records USER_EDITED verbatim instead of
      // blocking. The manifest entry and the frozen op bytes
      // prove both halves of the pin title.
      expect(submitted).toMatchObject({ ok: true, replayed: false });
      const inputs = readStep2GenerationInputs(t.handle, requestId);
      if (inputs === null) {
        throw new Error("S2-CP-B submit left no frozen inputs");
      }
      const frozen = Step2EditedInputsV2.parse(JSON.parse(inputs.editedInputsJson) as unknown);
      expect(frozen.operations).toHaveLength(4);
      expect(frozen.operations[0]).toMatchObject({ op: "add", editedText: EDITED });
      expect(frozen.summaryText).toBe(EDITED);
      const bullet = frozen.provenanceManifest.find((entry) => entry.kind === "bullet");
      expect(bullet?.provenance).toBe("USER_EDITED");
      const summary = frozen.provenanceManifest.find((entry) => entry.kind === "summary");
      expect(summary?.provenance).toBe("USER_EDITED");
    });
  });
});

describe("S2CPA3 pins: priority links, foreign roles, summary anchors", () => {
  it("guard (preserved v1): the accepted v1 plan carries suggestions with no priority links", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      expect(accepted.plan.suggestions.length).toBeGreaterThan(0);
      expect(accepted.usableSuggestion.suggestionId).toMatch(/^sug-/);
      const raw = readPlan(t.handle, accepted.planRowId);
      if (raw === null) {
        throw new Error("S2-CP-A setup cannot read the plan row");
      }
      const stored = JSON.parse(raw.planJson) as {
        suggestions: Array<Record<string, unknown>>;
        positioning: { angles: Array<Record<string, unknown>> };
      };
      for (const suggestion of stored.suggestions) {
        expect("priorityIds" in suggestion).toBe(false);
      }
      for (const angle of stored.positioning.angles) {
        expect("priorityIds" in angle).toBe(false);
      }
    });
  });

  it("every angle and suggestion links same-plan priority ids", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const raw = readPlan(t.handle, accepted.planRowId);
      if (raw === null) {
        throw new Error("S2-CP-B setup cannot read the plan row");
      }
      // The stored bytes parse as step2-plan/v2 (whose schema
      // enforces non-empty same-plan links); the loop below
      // re-proves linkage on the parsed plan.
      const stored = PreparationPlanV2.parse(JSON.parse(raw.planJson) as unknown);
      const known = new Set(stored.priorities.map((priority) => priority.priorityId));
      const linked = [
        ...stored.suggestions.map((suggestion) => suggestion.priorityIds),
        ...stored.positioning.angles.map((angle) => angle.priorityIds),
      ];
      expect(linked.length).toBeGreaterThan(0);
      // TARGET (S2-CP-B), flipped: ≥1 same-plan link per
      // angle/suggestion.
      for (const links of linked) {
        expect(links.length).toBeGreaterThanOrEqual(1);
        for (const link of links) {
          expect(known.has(link)).toBe(true);
        }
      }
    });
  });

  it("guard (preserved v1): a foreign-role v1 save succeeds", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      const foreignRoleId = accepted.usableSuggestion.roleId === "emp-harbor" ? "emp-beacon" : "emp-harbor";
      const saved = saveWorkspaceV2(
        t.handle,
        accepted.basics.jobId,
        0,
        {
          schemaVersion: "tailoring-workspace/v2",
          extractionId: accepted.basics.extractionId,
          profileId: accepted.basics.profileId,
          profileVersionId: accepted.basics.profileVersionId,
          requestKind: "INITIAL",
          parentVersionId: null,
          revisionNote: null,
          planId: accepted.planRowId,
          planHash: accepted.planHash,
          recommendationHash: null,
          draft: s2dDraft(
            accepted,
            [
              {
                op: "add",
                operationId: newId(),
                suggestionId: accepted.usableSuggestion.suggestionId,
                roleId: foreignRoleId,
                editedText: null,
              },
            ],
            "Master summary placeholder.",
            "master",
          ),
        },
        { now: () => accepted.now, recommendations: workspaceRecommendationsProvider },
      );
      expect(saved.ok).toBe(true);
    });
  });

  it("the foreign-role save is refused as an invalid selection", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const foreignRoleId = accepted.usableSuggestion.roleId === "emp-harbor" ? "emp-beacon" : "emp-harbor";
      const saved = saveWorkspaceV3(
        t.handle,
        accepted.basics.jobId,
        0,
        {
          schemaVersion: "tailoring-workspace/v3",
          extractionId: accepted.basics.extractionId,
          profileId: accepted.basics.profileId,
          profileVersionId: accepted.basics.profileVersionId,
          requestKind: "INITIAL",
          parentVersionId: null,
          revisionNote: null,
          planId: accepted.planRowId,
          planHash: accepted.planHash,
          recommendationHash: null,
          draft: s2dDraftV2(
            accepted,
            [
              {
                op: "add",
                operationId: newId(),
                suggestionId: accepted.usableSuggestion.suggestionId,
                roleId: foreignRoleId,
                editedText: null,
              },
            ],
            "Master summary placeholder.",
            "master",
          ),
        },
        { now: () => accepted.now, recommendations: workspaceRecommendationsProvider },
      );
      // TARGET (S2-CP-B), flipped: server-derived eligibility
      // refuses the save.
      expect(saved).toMatchObject({ ok: false, failure: { error: "invalid-selection" } });
    });
  });

  it("guard (preserved v1): v1 summary validation cites the whole-plan fact union", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedUnionAccepted(t.handle, world);
      const angle = accepted.plan.positioning.angles[0];
      if (angle === undefined) {
        throw new Error("S2-CP-A setup produced no angle");
      }
      const draft = s2dDraft(accepted, [], angle.summaryText, "angle-1");
      const { revision } = s2dSaveDraft(t.handle, accepted, draft, 0);
      const validated = validateDraft(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: revision,
          summaryText: angle.summaryText,
          operations: [],
        },
        now: accepted.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-A setup validation failed: ${validated.error}`);
      }
      const summary = validated.value.validation.segments.find((segment) => segment.segmentId === "summary");
      if (summary === undefined) {
        throw new Error("S2-CP-A setup produced no summary verdict");
      }
      const union = new Set<string>();
      for (const suggestion of accepted.plan.suggestions) {
        for (const factId of suggestion.factIds) {
          union.add(factId);
        }
      }
      for (const entry of accepted.plan.positioning.angles) {
        for (const factId of entry.factIds) {
          union.add(factId);
        }
      }
      expect(new Set(summary.factIds)).toEqual(union);
      expect(summary.factIds.length).toBeGreaterThan(angle.factIds.length);
    });
  });

  it("summary validation cites only the chosen origin anchors", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedUnionAcceptedV2(t.handle, world);
      const angle = accepted.plan.positioning.angles[0];
      if (angle === undefined) {
        throw new Error("S2-CP-B setup produced no angle");
      }
      expect(angle.angleId).toBe("angle-1");
      const draft = s2dDraftV2(accepted, [], angle.summaryText, "angle-1");
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const validated = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: angle.summaryText,
          summaryOrigin: "angle-1",
          operations: [],
        },
        now: accepted.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${validated.error}`);
      }
      const summary = validated.value.validation.segments.find((segment) => segment.segmentId === "summary");
      if (summary === undefined) {
        throw new Error("S2-CP-B setup produced no summary verdict");
      }
      // TARGET (S2-CP-B), flipped: selected-summary-only anchors,
      // never the union of unselected suggestions and angles.
      // The v2 union plan cites pricing elsewhere, so equality
      // with the discovery-only angle proves isolation.
      expect(new Set(summary.anchorFactIds)).toEqual(new Set(angle.factIds));
      expect(summary.anchorFactIds).not.toContain("pm-fact-pricing");
    });
  });

  it("plan reads expose server-derived eligible roles", async () => {
    const isolated: IsolatedRoot = setupIsolatedRoot("job-tracker-v13-s2cpa-plan-");
    const savedEnv: Record<string, string | undefined> = {};
    keyedEnv(savedEnv);
    try {
      const handle = openDatabase({ path: join(isolated.root, "job-tracker.sqlite") });
      let jobId = "";
      try {
        const world = seedCrossProfileWorld({
          handle,
          dir: isolated.root,
          dbPath: join(isolated.root, "job-tracker.sqlite"),
          cleanup: () => {},
        });
        const basics = seedS2bJob(handle, world);
        const kit = s2bProposalKit(handle, basics, world);
        const scheduled = scheduleS2b(handle, basics, { profileId: world.pmProfileId });
        void scheduled;
        const claimed = claimS2b(handle);
        const provider = new TestPrepareProvider({
          proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
        });
        const outcome = await runS2bAttempt(handle, claimed, provider);
        finishS2bAttempt(handle, { ...claimed, outcome });
        jobId = basics.jobId;
        const preparation = readPreparationByJob(handle, jobId);
        if (preparation?.acceptedPlanId === null || preparation?.acceptedPlanId === undefined) {
          throw new Error("S2-CP-A setup produced no accepted plan");
        }
      } finally {
        handle.close();
      }
      const response = await planGET(
        getRequest(`/api/jobs/${jobId}/tailoring/plan`),
        routeParams(jobId),
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as Record<string, unknown>;
      // TARGET (S2-CP-B): PlanReplyV2 carries eligibleRoles per suggestion.
      expect(body["eligibleRoles"]).toBeDefined();
    } finally {
      restoreEnv(savedEnv);
      isolated.restoreEnv();
      isolated.cleanup();
    }
  });
});

describe("S2CPA5 pins: forged provenance and provider overclaim", () => {
  it("guard (preserved v1): v1 validation replies carry no provenance field", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      const draft = s2dDraft(accepted, [], "Master summary placeholder.", "master");
      const { revision } = s2dSaveDraft(t.handle, accepted, draft, 0);
      const validated = validateDraft(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v1",
          workspaceRevision: revision,
          summaryText: "Master summary placeholder.",
          operations: [],
        },
        now: accepted.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-A setup validation failed: ${validated.error}`);
      }
      expect(validated.value.validation.segments.length).toBeGreaterThan(0);
      for (const segment of validated.value.validation.segments) {
        expect("provenance" in segment).toBe(false);
      }
    });
  });

  it("validation replies carry server-derived provenance", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAcceptedV2(t.handle, world);
      const draft = s2dDraftV2(accepted, [], "Master summary placeholder.", "master");
      const { revision } = s2dSaveDraftV2(t.handle, accepted, draft, 0);
      const validated = validateDraftV2(t.handle, {
        jobId: accepted.basics.jobId,
        body: {
          schemaVersion: "step2-validate-draft/v2",
          workspaceRevision: revision,
          summaryText: "Master summary placeholder.",
          summaryOrigin: "master",
          operations: [],
        },
        now: accepted.now,
      });
      if (!validated.ok) {
        throw new Error(`S2-CP-B setup validation failed: ${validated.error}`);
      }
      // TARGET (S2-CP-B), flipped: every segment carries
      // server-derived VERIFIED_SOURCE / USER_ACCEPTED_AI /
      // USER_EDITED.
      expect(validated.value.validation.segments.length).toBeGreaterThan(0);
      for (const segment of validated.value.validation.segments) {
        expect(segment.provenance).toMatch(/^(VERIFIED_SOURCE|USER_ACCEPTED_AI|USER_EDITED)$/);
      }
    });
  });

  it("guard: provider trust extras already fail strict parsing", () => {
    const tainted = {
      schemaVersion: "preparation-proposal/v1",
      jdSnapshotId: "jd-1",
      candidateSnapshotId: "cand-1",
      priorities: [],
      angles: [],
      suggestions: [],
      rationale: "Tainted.",
      verified: true,
      provenance: "VERIFIED_SOURCE",
      eligibleRoleIds: ["emp-harbor"],
      score: 99,
    };
    expect(PreparationProposalV1.safeParse(tainted).success).toBe(false);
  });

  it("guard (preserved v1): a link-less suggestion builds usable under the v1 builder", async () => {
    await withS2bDatabase(async (t, world) => {
      const proposal = linkedProposal(t.handle, world);
      const built = buildAcceptedPlan(
        builderInputFor(t.handle, world, S2B_JD, proposal, worldFacts(t.handle, world)),
      );
      if (!built.ok) {
        throw new Error(`S2-CP-A setup plan build failed: ${built.error}`);
      }
      expect(built.plan.suggestions).toHaveLength(1);
      expect(built.plan.suggestions[0]?.usable).toBe(true);
    });
  });

  it("link-less suggestions are unusable without priority links", async () => {
    await withS2bDatabase(async (t, world) => {
      // sug-001 links the plan priority (linked priorities > 0,
      // so the plan accepts); sug-002 names only a foreign id, so
      // it keeps no same-plan link. (A literally empty
      // `priorityIds` array fails v2 proposal schema validation
      // before the builder runs; unkept-but-present links are the
      // per-item case.)
      const built = buildAcceptedPlanV2(
        builderInputForV2(t.handle, world, (proposal) => ({
          ...proposal,
          suggestions: [
            ...proposal.suggestions,
            {
              roleId: "emp-harbor",
              text: "Unlinked Harbor work.",
              factIds: ["pm-fact-discovery"],
              priorityIds: ["f".repeat(64)],
            },
          ],
        })),
      );
      if (!built.ok) {
        throw new Error(`S2-CP-B setup plan build failed: ${built.error}`);
      }
      // TARGET (S2-CP-B), flipped: the suggestion without kept
      // priority links leaves the plan with a recorded
      // PRIORITY_LINK_MISSING disposition while the linked
      // suggestion still accepts.
      expect(built.plan.suggestions.map((suggestion) => suggestion.suggestionId)).toEqual([
        "sug-001",
      ]);
      const record = built.validation.suggestions.find(
        (entry) => entry.suggestionId === "sug-002",
      );
      expect(record).toMatchObject({ usable: false, unusableReason: "PRIORITY_LINK_MISSING" });
      expect(record?.droppedPriorityIds).toMatchObject([{ reason: "FOREIGN_PRIORITY" }]);
    });
  });
});

describe("S2CPA4 guards: reads and failed submits write no generations", () => {
  it("workspace, plan, and preparation reads leave Q1 identical", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      const draft = s2dDraft(accepted, [], "Master summary placeholder.", "master");
      s2dSaveDraft(t.handle, accepted, draft, 0);
      const before = s2bQ1(t.handle);
      const view = getWorkspaceView(t.handle, accepted.basics.jobId);
      expect(view.ok).toBe(true);
      const plan = readPlanForJob(t.handle, accepted.basics.jobId, null);
      expect(plan.ok).toBe(true);
      expect(s2bQ1(t.handle)).toEqual(before);
    });
  });

  it("a blocked submit writes no generation rows", async () => {
    await withS2dDatabase(async (t, world) => {
      const accepted = await seedS2dAccepted(t.handle, world);
      const draft = s2dDraft(
        accepted,
        [
          {
            op: "add",
            operationId: newId(),
            suggestionId: accepted.usableSuggestion.suggestionId,
            roleId: accepted.usableSuggestion.roleId,
            editedText: "Unsupported user wording with invented 500% growth.",
          },
        ],
        "Master summary placeholder.",
        "master",
      );
      const { revision } = s2dSaveDraft(t.handle, accepted, draft, 0);
      const live = getTailoringJob(t.handle, accepted.basics.jobId);
      if (live === null) {
        throw new Error("S2-CP-A setup lost the job");
      }
      const before = s2bQ1(t.handle);
      const submitted = submitGeneration(
        t.handle,
        {
          jobId: accepted.basics.jobId,
          requestId: newId(),
          workspaceRevision: revision,
          observedRowVersion: live.rowVersion,
          actor: "human",
          now: accepted.now,
        },
        { env: S2D_KEYED_ENV },
      );
      expect(submitted.ok).toBe(false);
      expect(s2bQ1(t.handle)).toEqual(before);
    });
  });
});
