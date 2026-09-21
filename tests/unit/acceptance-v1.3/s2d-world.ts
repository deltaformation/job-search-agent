// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  newId,
  tailoringRequestInputs,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getGenerationRequest } from "../../../src/db/generation";
import { getTailoringJob } from "../../../src/db/tailoring";
import {
  STEP2_SCHEMA_VERSIONS,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type Step2DraftOperationV1,
  type Step2DraftV1,
} from "../../../src/domain/step2";
import {
  STEP2_CORRECTION_VERSIONS,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2DraftOperationV2,
  type Step2DraftV2,
  type Step2SummaryOrigin,
} from "../../../src/domain/step2Correction";
import { completeWorkItem } from "../../../src/queue/leases";
import type { HandlerOutcome } from "../../../src/queue/dispatch";
import { extractDocxParagraphs } from "../../../src/resumes/docx";
import { extractPdfText } from "../../../src/resumes/pdf";
import { getRecommendations, workspaceRecommendationsProvider } from "../../../src/server/recommendations";
import { submitGeneration } from "../../../src/server/generations";
import { saveWorkspaceV2, saveWorkspaceV3 } from "../../../src/server/tailoringWorkspace";
import { TestProvider } from "../../../src/tailoring/testProvider";
import {
  seedCrossProfileWorld,
  type CrossProfileWorld,
} from "../acceptance-v1.2/world";
import type { V13Basics } from "../db/v13world";
import {
  claimFRun,
  factTextsForVersion,
  fHandler,
  proposalForRun,
  type FClaim,
} from "./f-world";
import {
  seedV1Accepted,
  seedV2Accepted,
  S2B_JD,
  S2B_KEYED_ENV,
} from "./s2b-world";

/**
 * WO-1.3-S2-D acceptance world: a real PREPARE cycle to an accepted
 * plan, real W-v2 saves, real G submits, and the real TAILOR handler
 * with deterministic providers. No fixture bytes are smuggled in —
 * suggestions quote world facts, proposals quote the live JD, and
 * every hash is recomputed from the rows the pipeline wrote.
 */

export const S2D_T0 = "2026-09-17T13:00:00.000Z";
export const S2D_KEYED_ENV = S2B_KEYED_ENV;

/**
 * Operation clock past real-now: the world seeds profile versions
 * at real-now, so PREPARE/validate/generate run an hour later to
 * keep the production chronology (version < plan < validation).
 */
export function s2dNow(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

export async function withS2dDatabase(
  fn: (t: TestDatabase, world: CrossProfileWorld) => Promise<void> | void,
): Promise<void> {
  const t = createTestDatabase("job-tracker-v13-s2d-");
  try {
    await fn(t, seedCrossProfileWorld(t));
  } finally {
    t.cleanup();
  }
}

export interface S2dAccepted {
  basics: V13Basics;
  world: CrossProfileWorld;
  preparationId: string;
  planRowId: string;
  planHash: string;
  plan: PreparationPlanV1Type;
  usableSuggestion: { suggestionId: string; roleId: string; text: string; factIds: string[] };
  statements: Map<string, string>;
  now: string;
}

/**
 * Seed a job with a directly accepted v1 plan (pure v1 builder +
 * repos, no provider call) and return it. S2-D suites prove the
 * preserved v1 path after the handler cut over to v2; v2/v3
 * coverage lives in the s2cpb suites. Pass a real-time `now` for
 * route-driven legs: HTTP handlers use the wall clock, so fixed
 * clocks would invert the chronology.
 */
export async function seedS2dAccepted(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  jdText: string = S2B_JD,
  now: string = s2dNow(),
): Promise<S2dAccepted> {
  const seed = seedV1Accepted(handle, world, jdText, now);
  const usable = seed.plan.suggestions.find((suggestion) => suggestion.usable);
  if (usable === undefined) {
    throw new Error("S2-D setup produced no usable suggestion");
  }
  return {
    basics: seed.basics,
    world,
    preparationId: seed.preparationId,
    planRowId: seed.planRowId,
    planHash: seed.planHash,
    plan: seed.plan,
    usableSuggestion: {
      suggestionId: usable.suggestionId,
      roleId: usable.roleId,
      text: usable.text,
      factIds: [...usable.factIds],
    },
    statements: factTextsForVersion(handle, seed.basics.profileVersionId),
    now: seed.now,
  };
}

export function s2dDraft(
  accepted: S2dAccepted,
  operations: Step2DraftOperationV1[],
  summaryText: string,
  summarySource: Step2DraftV1["summarySource"] = "edited",
): Step2DraftV1 {
  return {
    schemaVersion: STEP2_SCHEMA_VERSIONS.draft,
    planId: accepted.planRowId,
    planHash: accepted.planHash,
    summaryText,
    summarySource,
    operations,
  };
}

export interface S2dAcceptedV2 {
  basics: V13Basics;
  world: CrossProfileWorld;
  preparationId: string;
  planRowId: string;
  planHash: string;
  plan: PreparationPlanV2Type;
  usableSuggestion: { suggestionId: string; roleId: string; text: string; factIds: string[] };
  statements: Map<string, string>;
  now: string;
}

/**
 * Seed a job with an accepted v2 plan through the REAL v2 pipeline
 * and return it: the corrected-path fixture for CP-B pins and
 * s2cpb suites (W-v3 saves, V-v2 validation, G-v2 submits).
 */
export async function seedS2dAcceptedV2(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  jdText: string = S2B_JD,
  now: string = s2dNow(),
): Promise<S2dAcceptedV2> {
  const seed = await seedV2Accepted(handle, world, jdText, now);
  const usable = seed.plan.suggestions.find((suggestion) => suggestion.usable);
  if (usable === undefined) {
    throw new Error("S2-D v2 setup produced no usable suggestion");
  }
  return {
    basics: seed.basics,
    world,
    preparationId: seed.preparationId,
    planRowId: seed.planRowId,
    planHash: seed.planHash,
    plan: seed.plan,
    usableSuggestion: {
      suggestionId: usable.suggestionId,
      roleId: usable.roleId,
      text: usable.text,
      factIds: [...usable.factIds],
    },
    statements: factTextsForVersion(handle, seed.basics.profileVersionId),
    now: seed.now,
  };
}

export function s2dDraftV2(
  accepted: S2dAcceptedV2,
  operations: Step2DraftOperationV2[],
  summaryText: string,
  summaryOrigin: Step2SummaryOrigin = "master",
): Step2DraftV2 {
  return {
    schemaVersion: STEP2_CORRECTION_VERSIONS.draft,
    planId: accepted.planRowId,
    planHash: accepted.planHash,
    summaryText,
    summaryOrigin,
    operations,
  };
}

/** Real W-v3 save of a plan-bound v2 draft; throws unless saved. */
export function s2dSaveDraftV2(
  handle: DatabaseHandle,
  accepted: S2dAcceptedV2,
  draft: Step2DraftV2,
  revision: number,
): { revision: number } {
  const saved = saveWorkspaceV3(
    handle,
    accepted.basics.jobId,
    revision,
    {
      schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
      extractionId: accepted.basics.extractionId,
      profileId: accepted.basics.profileId,
      profileVersionId: accepted.basics.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      planId: accepted.planRowId,
      planHash: accepted.planHash,
      recommendationHash: null,
      draft,
    },
    { now: () => S2D_T0, recommendations: workspaceRecommendationsProvider },
  );
  if (!saved.ok) {
    throw new Error(`S2-D v2 draft save failed: ${saved.failure.error} ${saved.failure.detail}`);
  }
  return { revision: saved.value.revision };
}

/** Real W-v2 save of a plan-bound draft; throws unless saved. */
export function s2dSaveDraft(
  handle: DatabaseHandle,
  accepted: S2dAccepted,
  draft: Step2DraftV1,
  revision: number,
): { revision: number } {
  const saved = saveWorkspaceV2(
    handle,
    accepted.basics.jobId,
    revision,
    {
      schemaVersion: STEP2_SCHEMA_VERSIONS.workspace,
      extractionId: accepted.basics.extractionId,
      profileId: accepted.basics.profileId,
      profileVersionId: accepted.basics.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      planId: accepted.planRowId,
      planHash: accepted.planHash,
      recommendationHash: null,
      draft,
    },
    { now: () => S2D_T0, recommendations: workspaceRecommendationsProvider },
  );
  if (!saved.ok) {
    throw new Error(`S2-D draft save failed: ${saved.failure.error} ${saved.failure.detail}`);
  }
  return { revision: saved.value.revision };
}

export interface S2dSubmitted {
  requestId: string;
  workItemId: string;
  jdSnapshotId: string;
  candidateSnapshotId: string;
}

/** Real G submit of the saved revision (v1 or v2 draft); throws unless queued. */
export function s2dSubmit(
  handle: DatabaseHandle,
  accepted: S2dAccepted | S2dAcceptedV2,
  input: { requestId?: string; workspaceRevision: number; observedRowVersion?: number; now?: string },
): S2dSubmitted {
  const requestId = input.requestId ?? newId();
  const live = getTailoringJob(handle, accepted.basics.jobId);
  if (live === null) {
    throw new Error("S2-D submit lost the job row");
  }
  const submitted = submitGeneration(
    handle,
    {
      jobId: accepted.basics.jobId,
      requestId,
      workspaceRevision: input.workspaceRevision,
      observedRowVersion: input.observedRowVersion ?? live.rowVersion,
      actor: "human",
      now: input.now ?? S2D_T0,
    },
    { env: S2D_KEYED_ENV },
  );
  if (!submitted.ok) {
    throw new Error(
      `S2-D submit failed: ${submitted.failure.error} ${submitted.failure.detail}`,
    );
  }
  const request = getGenerationRequest(handle, requestId);
  const inputs = handle.db
    .select()
    .from(tailoringRequestInputs)
    .where(eq(tailoringRequestInputs.requestId, requestId))
    .get();
  if (request === null || inputs === undefined) {
    throw new Error("S2-D submit returned no request/inputs rows");
  }
  return {
    requestId,
    workItemId: submitted.workItemId,
    jdSnapshotId: request.jdSnapshotId,
    candidateSnapshotId: inputs.candidateSnapshotId,
  };
}

/** Valid scripted TAILOR proposal over the world's served guidance. */
export function s2dTailorProposal(
  handle: DatabaseHandle,
  accepted: S2dAccepted | S2dAcceptedV2,
  submitted: S2dSubmitted,
): Record<string, unknown> {
  const recs = getRecommendations(handle, {
    jobId: accepted.basics.jobId,
    extractionId: accepted.basics.extractionId,
    profileVersionId: accepted.basics.profileVersionId,
  });
  if (!recs.ok) {
    throw new Error(`S2-D guidance seed failed: ${recs.failure.error}`);
  }
  return proposalForRun({
    recommendations: recs.recommendations,
    factTexts: accepted.statements,
    jdSnapshotId: submitted.jdSnapshotId,
    candidateSnapshotId: submitted.candidateSnapshotId,
  });
}

export function s2dTailorProvider(
  submitted: S2dSubmitted,
  proposal: Record<string, unknown>,
  clock: () => string = () => S2D_T0,
): TestProvider {
  return new TestProvider({ proposals: { [submitted.jdSnapshotId]: proposal }, clock });
}

/** Claim the TAILOR item and run the real handler once. */
export async function runS2dTailor(
  handle: DatabaseHandle,
  submitted: S2dSubmitted,
  provider: TestProvider,
  artifactsDir: string,
  options: { now?: string; renderPdf?: (html: string) => Promise<{ bytes: Buffer }> } = {},
): Promise<{ claim: FClaim; outcome: HandlerOutcome }> {
  const claim = claimFRun(handle, submitted.workItemId, { now: options.now ?? S2D_T0 });
  const handler = fHandler({
    artifactsDir,
    provider,
    clock: () => options.now ?? S2D_T0,
    ...(options.renderPdf === undefined ? {} : { renderPdf: options.renderPdf }),
  });
  const outcome = await handler(claim.context);
  return { claim, outcome };
}

/** Complete the TAILOR attempt the way the dispatcher would. */
export function finishS2dAttempt(
  handle: DatabaseHandle,
  claim: FClaim,
  outcome: HandlerOutcome,
  now: string = S2D_T0,
): void {
  const finished = completeWorkItem(
    handle,
    {
      workItemId: claim.claimed.id,
      leaseToken: claim.claimed.leaseToken,
      attemptId: claim.claimed.currentAttemptId,
      result: outcome.result,
      errorCode: outcome.errorCode ?? null,
      errorDetail: outcome.errorDetail ?? null,
      inputHash: outcome.inputHash ?? null,
      outputHash: outcome.outputHash ?? null,
    },
    { now, terminal: outcome.terminal },
  );
  if (!finished.ok) {
    throw new Error(`S2-D completion failed: ${finished.error}`);
  }
}

export interface S2dArtifactTexts {
  markdown: string;
  docx: string;
  pdf: string;
}

/** Read the published bytes for one version out of the artifacts dir. */
export async function readS2dArtifactTexts(
  handle: DatabaseHandle,
  artifactsDir: string,
  versionId: string,
): Promise<S2dArtifactTexts> {
  const rows = handle.sqlite
    .prepare(
      `SELECT kind, relative_path AS relativePath FROM resume_artifacts WHERE resume_version_id = ?`,
    )
    .all(versionId) as Array<{ kind: string; relativePath: string }>;
  const byKind = new Map(rows.map((row) => [row.kind, row.relativePath]));
  const markdownPath = byKind.get("MARKDOWN");
  const docxPath = byKind.get("DOCX");
  const pdfPath = byKind.get("PDF");
  if (markdownPath === undefined || docxPath === undefined || pdfPath === undefined) {
    throw new Error(`S2-D version ${versionId} is missing published artifacts`);
  }
  const markdown = readFileSync(join(artifactsDir, markdownPath), "utf8");
  const docx = extractDocxParagraphs(readFileSync(join(artifactsDir, docxPath))).join("\n");
  const pdf = (await extractPdfText(readFileSync(join(artifactsDir, pdfPath)))).text;
  return { markdown, docx, pdf };
}

/** Resume version committed for one request (throws unless exactly one). */
export function versionForRequest(handle: DatabaseHandle, requestId: string): { id: string } {
  const rows = handle.sqlite
    .prepare(`SELECT id FROM resume_versions WHERE generation_request_id = ?`)
    .all(requestId) as Array<{ id: string }>;
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`S2-D request ${requestId} produced ${rows.length} versions`);
  }
  return { id: rows[0].id };
}
