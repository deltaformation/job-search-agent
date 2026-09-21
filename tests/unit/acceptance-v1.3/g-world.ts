// @vitest-environment node
import {
  candidateProfileVersions,
  candidateSnapshots,
  jobAnalyses,
  newId,
  resumeVersions,
  step2DraftValidations,
  step2GenerationInputs,
  step2Plans,
  step2Preparations,
  type DatabaseHandle,
} from "../../../src/db";
import { listFactsByVersion } from "../../../src/db/candidates";
import { eq } from "drizzle-orm";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import { CandidateSnapshotV1 } from "../../../src/domain/candidate";
import { masterBulletsByRole } from "../../../src/domain/step2";
import {
  deriveCorrectionSegments,
  PREPARE_PROMPT_VERSION_V2,
  PreparationPlanV2,
  STEP2_CLAIMS_POLICY_V2,
  STEP2_CORRECTION_VERSIONS,
  Step2EditedInputsV2,
  Step2ValidationV2,
  type CorrectionDerivedSegment,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2DraftOperationV2,
} from "../../../src/domain/step2Correction";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { evidenceHashFor } from "../../../src/tailoring/step2policy";
import {
  seedV13Basics,
  seedV13RequestInputs,
  seedV13RunningRun,
  seedV13Version,
  V13_T0,
  type V13Basics,
  type V13Run,
  type V13Version,
} from "../db/v13world";
import type { CrossProfileWorld } from "../acceptance-v1.2/world";

/**
 * WO-1.3-G edited-plan world. Layers a minimal but strictly valid
 * correction-format (claims/2) frozen input set on the v13 world:
 * preparation → plan → validation → generation inputs. Segment
 * manifests and verdicts derive from the worker's own pure
 * `deriveCorrectionSegments` over the frozen plan/operations, then
 * carry explicit provenances — exactly the shape G's freeze writes.
 */

export interface GEditedPlan {
  basics: V13Basics;
  run: V13Run;
  version: V13Version;
  preparationId: string;
  planRowId: string;
  planHash: string;
  plan: PreparationPlanV2Type;
  validationId: string;
  draftHash: string;
  summaryText: string;
  operations: Step2DraftOperationV2[];
  derived: CorrectionDerivedSegment[];
  excludedText: string;
  factIds: string[];
}

export const G_PRIORITY_SUPPORTED = "a".repeat(64);
export const G_PRIORITY_GAP = "b".repeat(64);

function payloadOf(handle: DatabaseHandle, snapshotId: string) {
  const row = handle.db
    .select()
    .from(candidateSnapshots)
    .where(eq(candidateSnapshots.id, snapshotId))
    .get();
  if (row === undefined) {
    throw new Error("G world lost the profile snapshot");
  }
  return CandidateSnapshotV1.parse(JSON.parse(row.canonicalJson) as unknown).payload;
}

export interface GFixtureFacts {
  employmentId: string;
  keepFactId: string;
  dropFactId: string;
  keepText: string;
  dropText: string;
  summaryText: string;
}

/** Deterministic fixture facts from the world's PM snapshot (pre-seed readable). */
export function gFixtureFacts(handle: DatabaseHandle, snapshotId: string): GFixtureFacts {
  const payload = payloadOf(handle, snapshotId);
  const employmentId = payload.employment[0]?.id;
  if (employmentId === undefined) {
    throw new Error("G world profile has no employment");
  }
  const approved = payload.achievements.filter(
    (achievement) =>
      achievement.employmentId === employmentId &&
      achievement.verification === "APPROVED" &&
      achievement.text.trim() !== "",
  );
  if (approved.length < 2) {
    throw new Error("G world needs two approved achievements on one role");
  }
  const keep = approved[0] as { factId: string; text: string };
  const drop = approved[1] as { factId: string; text: string };
  return {
    employmentId,
    keepFactId: keep.factId,
    dropFactId: drop.factId,
    keepText: canonicalText(keep.text),
    dropText: canonicalText(drop.text),
    summaryText: payload.summary ?? "Operations leader.",
  };
}

function seedGVersion(
  handle: DatabaseHandle,
  basics: V13Basics,
  run: V13Run,
  overrides: { requirementsJson?: string; gapsJson?: string },
): V13Version {
  const versionId = newId();
  const contentHash = sha256HexUtf8(canonicalJson({ version: versionId }));
  const analysisId = newId();
  handle.db
    .insert(jobAnalyses)
    .values({
      id: analysisId,
      jobId: basics.jobId,
      jdSnapshotId: basics.jdSnapshotId,
      candidateSnapshotId: basics.snapshotId,
      workAttemptId: run.attemptId,
      generationRequestId: run.requestId,
      requirementsJson: overrides.requirementsJson ?? JSON.stringify([]),
      gapsJson: overrides.gapsJson ?? JSON.stringify([]),
      promptVersion: "tailor-prompt/v1",
      proposalSchemaVersion: "tailor-proposal/v1",
      createdAt: V13_T0,
    })
    .run();
  handle.db
    .insert(resumeVersions)
    .values({
      id: versionId,
      jobId: basics.jobId,
      version: 1,
      analysisId,
      generationRequestId: run.requestId,
      workAttemptId: run.attemptId,
      templateId: "classic",
      templateVersion: "1",
      templateHash: "3".repeat(64),
      rankerVersion: "ranker/1",
      policyVersion: "policy/1",
      configVersion: "config/1",
      renderSchemaVersion: "render/1",
      contentJson: canonicalJson({ version: versionId }),
      contentHash,
      reviewState: "AWAITING_REVIEW",
      createdAt: V13_T0,
      updatedAt: V13_T0,
    })
    .run();
  return { versionId, analysisId, contentHash };
}

export function seedGEditedPlan(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  overrides: { jdText?: string; requirementsJson?: string; gapsJson?: string } = {},
): GEditedPlan {
  const basics = seedV13Basics(handle, world, overrides);
  const run = seedV13RunningRun(handle, basics);
  seedV13RequestInputs(handle, basics, run);
  // job_analyses is immutable: custom requirements must land at insert.
  const version =
    overrides.requirementsJson === undefined && overrides.gapsJson === undefined
      ? seedV13Version(handle, basics, run)
      : seedGVersion(handle, basics, run, overrides);

  const payload = payloadOf(handle, basics.snapshotId);
  const facts = gFixtureFacts(handle, basics.snapshotId);
  const employmentId = facts.employmentId;
  const keepFact = { factId: facts.keepFactId, text: facts.keepText };
  const dropFact = { factId: facts.dropFactId, text: facts.dropText };
  const summaryText = facts.summaryText;
  const suggestionText = `Reworded: ${facts.keepText}`;

  const preparationId = newId();
  const planRowId = newId();
  const plan = PreparationPlanV2.parse({
    schemaVersion: STEP2_CORRECTION_VERSIONS.plan,
    planId: planRowId,
    preparationId,
    extractionId: basics.extractionId,
    jdHash: basics.jdHash,
    profileVersionId: basics.profileVersionId,
    evidenceHash: "c".repeat(64),
    masterProjectionHash: "d".repeat(64),
    priorities: [
      {
        priorityId: G_PRIORITY_SUPPORTED,
        quote: { text: "Product leader", startByte: 0, endByte: 14 },
        count: 2,
        category: "title",
        importance: "required",
        support: "supported",
        factIds: [keepFact.factId],
      },
      {
        priorityId: G_PRIORITY_GAP,
        quote: { text: "NetSuite administration", startByte: 20, endByte: 43 },
        count: 1,
        category: "tooling",
        importance: "preferred",
        support: "gap",
        factIds: [],
      },
    ],
    featuredPriorityIds: [G_PRIORITY_SUPPORTED],
    positioning: { keepMasterSummary: summaryText, angles: [] },
    suggestions: [
      {
        suggestionId: "sug-001",
        roleId: employmentId,
        text: suggestionText,
        factIds: [keepFact.factId],
        priorityIds: [G_PRIORITY_SUPPORTED],
        usable: true,
        unusableReason: null,
      },
    ],
    rationale: "G fixture plan.",
  });

  const addOpId = newId();
  const excludeOpId = newId();
  const operations = Step2EditedInputsV2.shape.operations.parse([
    {
      op: "add",
      operationId: addOpId,
      suggestionId: "sug-001",
      roleId: employmentId,
      editedText: null,
    },
    { op: "exclude", operationId: excludeOpId, targetFactId: dropFact.factId },
  ]) as Step2DraftOperationV2[];

  const derived = deriveCorrectionSegments({
    plan,
    master: masterBulletsByRole(payload),
    masterSummary: summaryText,
    summaryText,
    summaryOrigin: "master",
    operations,
  });
  if (derived.length !== 2) {
    throw new Error(`G world derived ${derived.length} segments, want 2`);
  }
  const manifest = derived.map((segment) => ({
    segmentId: segment.segmentId,
    kind: segment.kind,
    roleId: segment.roleId,
    origin: segment.origin,
    anchorFactIds: [...segment.anchorFactIds],
    priorityIds: [...segment.priorityIds],
    textHash: sha256HexUtf8(segment.text),
    normalizedHash: sha256HexUtf8(canonicalText(segment.text)),
    provenance: segment.kind === "summary" ? "VERIFIED_SOURCE" : "USER_ACCEPTED_AI",
    sourceOperationId: segment.sourceOperationId,
  }));
  const editedInputs = Step2EditedInputsV2.parse({
    schemaVersion: STEP2_CORRECTION_VERSIONS.editedInputs,
    planId: plan.planId,
    summaryText,
    summaryOrigin: "master",
    operations,
    provenanceManifest: manifest,
  });
  const draftHash = sha256HexUtf8(canonicalJson(editedInputs));

  const verdicts = derived.map((segment) => ({
    segmentId: segment.segmentId,
    kind: segment.kind,
    roleId: segment.roleId,
    origin: segment.origin,
    anchorFactIds: [...segment.anchorFactIds],
    priorityIds: [...segment.priorityIds],
    textHash: sha256HexUtf8(segment.text),
    normalizedHash: sha256HexUtf8(canonicalText(segment.text)),
    provenance: segment.kind === "summary" ? "VERIFIED_SOURCE" : "USER_ACCEPTED_AI",
    structural: { ok: true, reason: null },
    match: segment.kind === "summary" ? "exact-master" : "exact-plan",
    reason: null,
  }));
  const validation = Step2ValidationV2.parse({
    schemaVersion: STEP2_CORRECTION_VERSIONS.validation,
    policyVersion: STEP2_CLAIMS_POLICY_V2,
    planId: plan.planId,
    planHash: sha256HexUtf8(canonicalJson(plan)),
    draftHash,
    segments: verdicts,
    provenanceCounts: { verifiedSource: 1, userAcceptedAi: 1, userEdited: 0 },
    budget: {
      summaryChars: summaryText.length,
      perRoleCounts: [{ roleId: employmentId, bullets: 1 }],
      totalBullets: 1,
      exceeded: false,
    },
    validatedAt: V13_T0,
  });

  // Genuinely verifiable capture: the same hashes the frozen
  // freshness check recomputes from the live profile version.
  const versionRow = handle.db
    .select()
    .from(candidateProfileVersions)
    .where(eq(candidateProfileVersions.id, basics.profileVersionId))
    .get();
  if (versionRow === undefined) {
    throw new Error("G world lost its profile version row");
  }
  const employmentOf = new Map<string, string>();
  for (const achievement of payload.achievements) {
    if (achievement.employmentId !== undefined) {
      employmentOf.set(achievement.factId, achievement.employmentId);
    }
  }
  const approvedFacts = listFactsByVersion(handle, versionRow.id)
    .filter((fact) => fact.verification === "APPROVED")
    .map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      employmentId: employmentOf.get(fact.factId) ?? null,
    }));
  handle.db
    .insert(step2Preparations)
    .values({
      id: preparationId,
      jobId: basics.jobId,
      profileId: basics.profileId,
      profileVersionId: basics.profileVersionId,
      extractionId: basics.extractionId,
      profilePayloadHash: versionRow.payloadHash,
      evidenceHash: evidenceHashFor({
        profileVersionId: versionRow.id,
        payloadHash: versionRow.payloadHash,
        approved: approvedFacts,
      }),
      bindingJson: "{}",
      state: "SUCCEEDED",
    })
    .run();
  const planHash = sha256HexUtf8(canonicalJson(plan));
  handle.db
    .insert(step2Plans)
    .values({
      id: planRowId,
      preparationId,
      planSeq: 1,
      planJson: canonicalJson(plan),
      planHash,
      providerId: "test",
      model: null,
      promptVersion: PREPARE_PROMPT_VERSION_V2,
      proposalSchemaVersion: "preparation-proposal/v2",
      claimsPolicyVersion: STEP2_CLAIMS_POLICY_V2,
      inputHash: "0".repeat(64),
      proposalHash: "1".repeat(64),
      attemptId: run.attemptId,
      validationJson: "{}",
    })
    .run();
  const validationId = newId();
  handle.db
    .insert(step2DraftValidations)
    .values({
      id: validationId,
      jobId: basics.jobId,
      planId: planRowId,
      workspaceRevision: 1,
      draftHash,
      verdictJson: canonicalJson(validation),
      policyVersion: STEP2_CLAIMS_POLICY_V2,
    })
    .run();
  handle.db
    .insert(step2GenerationInputs)
    .values({
      requestId: run.requestId,
      planId: planRowId,
      planHash,
      draftHash,
      validationId,
      editedInputsJson: canonicalJson(editedInputs),
      policyVersionsJson: canonicalJson({
        schemaVersion: STEP2_CORRECTION_VERSIONS.policyVersions,
        claims: STEP2_CLAIMS_POLICY_V2,
        master: "step2-master-bullets/1",
        prompt: PREPARE_PROMPT_VERSION_V2,
      }),
    })
    .run();

  return {
    basics,
    run,
    version,
    preparationId,
    planRowId,
    planHash,
    plan,
    validationId,
    draftHash,
    summaryText,
    operations,
    derived,
    excludedText: canonicalText(dropFact.text),
    factIds: [keepFact.factId, dropFact.factId],
  };
}
