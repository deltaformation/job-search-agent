// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createTestDatabase,
  generationProgressEvents,
  newId,
  tailoringRequestInputs,
  workAttempts,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getProfileVersion } from "../../../src/db/candidates";
import { getGenerationRequest } from "../../../src/db/generation";
import { parseStoredProfilePayload } from "../../../src/domain/candidate";
import type {
  RecommendationV1 as RecommendationV1Type,
} from "../../../src/domain/tailoringWorkspace";
import {
  claimNextWorkItem,
  renewLease,
  type ClaimedWorkItem,
} from "../../../src/queue/leases";
import type { WorkHandlerContext } from "../../../src/queue/dispatch";
import {
  createTailorHandler,
  type TailorHandlerDeps,
} from "../../../src/tailoring/handler";
import type { TailoringProvider } from "../../../src/tailoring/contract";
import { hashRecommendation } from "../../../src/tailoring/requestsV3";
import { TestProvider } from "../../../src/tailoring/testProvider";
import { submitGeneration } from "../../../src/server/generations";
import {
  getRecommendations,
  workspaceRecommendationsProvider,
} from "../../../src/server/recommendations";
import { saveWorkspace } from "../../../src/server/tailoringWorkspace";
import { stubRenderPdf } from "../tailoring/support";
import {
  PM_JD_TEXT,
  seedCrossProfileWorld,
  type CrossProfileWorld,
} from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  v13ExtractionJson,
  V13_T0,
  type V13Basics,
} from "../db/v13world";

/**
 * WO-1.3-F acceptance world: real W + G submission, real lease
 * claims, and the real TAILOR handler with a deterministic provider.
 * Proposals are built from the served recommendations (exact JD
 * quotes) and approved fact texts, so the happy path validates
 * through the actual pipeline — no fixture bytes are smuggled in.
 */

export const F_T0 = V13_T0;
export const F_KEYED_ENV = { ACTIVE_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key" };

export async function withFDatabase(
  fn: (t: TestDatabase, world: CrossProfileWorld) => Promise<void> | void,
): Promise<void> {
  const t = createTestDatabase("job-tracker-v13-f-");
  try {
    await fn(t, seedCrossProfileWorld(t));
  } finally {
    t.cleanup();
  }
}

export function makeArtifactsDir(): string {
  return mkdtempSync(join(tmpdir(), "tailor-f-"));
}

export interface FSeededRun {
  basics: V13Basics;
  recommendations: RecommendationV1Type;
  requestId: string;
  workItemId: string;
  jdSnapshotId: string;
  candidateSnapshotId: string;
}

/** Real W save + G submit of the served preset; returns the queued v3 run. */
export function seedFRun(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  overrides: { jdText?: string; now?: string } = {},
): FSeededRun {
  const jdText = overrides.jdText ?? PM_JD_TEXT;
  const basics = seedV13Basics(handle, world, {
    jdText,
    extractedJson: v13ExtractionJson(jdText),
  });
  const recs = getRecommendations(handle, {
    jobId: basics.jobId,
    extractionId: basics.extractionId,
    profileVersionId: basics.profileVersionId,
  });
  if (!recs.ok) {
    throw new Error(`F recommendations seed failed: ${recs.failure.error}`);
  }
  const recommendationHash = hashOf(recs.recommendations);
  const saved = saveWorkspace(
    handle,
    basics.jobId,
    0,
    {
      schemaVersion: "tailoring-workspace/v1",
      extractionId: basics.extractionId,
      profileId: basics.profileId,
      profileVersionId: basics.profileVersionId,
      requestKind: "INITIAL",
      parentVersionId: null,
      revisionNote: null,
      recommendationHash,
      focus: recs.recommendations.preset,
    },
    { now: () => F_T0, recommendations: workspaceRecommendationsProvider },
  );
  if (!saved.ok) {
    throw new Error(`F workspace seed failed: ${saved.failure.error}`);
  }
  const requestId = newId();
  const submitted = submitGeneration(
    handle,
    {
      jobId: basics.jobId,
      requestId,
      workspaceRevision: 1,
      observedRowVersion: 1,
      actor: "human",
      now: overrides.now ?? F_T0,
    },
    { env: F_KEYED_ENV },
  );
  if (!submitted.ok) {
    throw new Error(`F submit failed: ${submitted.failure.error} ${submitted.failure.detail}`);
  }
  const request = getGenerationRequest(handle, requestId);
  if (request === null) {
    throw new Error("F submit returned no request row");
  }
  const inputs = handle.db
    .select()
    .from(tailoringRequestInputs)
    .where(eq(tailoringRequestInputs.requestId, requestId))
    .get();
  if (inputs === undefined) {
    throw new Error("F submit returned no inputs row");
  }
  return {
    basics,
    recommendations: recs.recommendations,
    requestId,
    workItemId: submitted.workItemId,
    jdSnapshotId: request.jdSnapshotId,
    candidateSnapshotId: inputs.candidateSnapshotId,
  };
}

function hashOf(recommendations: RecommendationV1Type): string {
  return hashRecommendation(recommendations);
}

/** Approved fact texts for one profile version (evidence quotes). */
export function factTextsForVersion(handle: DatabaseHandle, versionId: string): Map<string, string> {
  const row = getProfileVersion(handle, versionId);
  if (row === null) {
    throw new Error(`profile version ${versionId} missing`);
  }
  const payload = parseStoredProfilePayload(JSON.parse(row.payloadJson) as unknown);
  const texts = new Map<string, string>();
  for (const achievement of payload.achievements) {
    if (achievement.verification === "APPROVED") {
      texts.set(achievement.factId, achievement.text);
    }
  }
  return texts;
}

function proposalCategory(recommendationCategory: string): string {
  if (recommendationCategory === "Technical") {
    return "skill";
  }
  if (recommendationCategory === "Business") {
    return "domain";
  }
  return "other";
}

/**
 * Valid scripted proposal over the served recommendations: supported
 * phrases become confirmed matches quoting exact JD text with exact
 * approved-fact evidence; one gap phrase (when served) stays
 * evidence-free. Strict-parses as ResumeProposalV1.
 */
export function proposalForRun(input: {
  recommendations: RecommendationV1Type;
  factTexts: Map<string, string>;
  jdSnapshotId: string;
  candidateSnapshotId: string;
  matchedLimit?: number;
}): Record<string, unknown> {
  const supported = input.recommendations.phrases.filter(
    (phrase) =>
      phrase.support === "supported" &&
      phrase.factIds.length > 0 &&
      phrase.factIds.every((factId) => input.factTexts.has(factId)),
  );
  const matched = supported.slice(0, input.matchedLimit ?? supported.length);
  if (matched.length === 0) {
    throw new Error("F world serves no supported phrase with approved facts");
  }
  const gap = input.recommendations.phrases.find((phrase) => phrase.support === "gap");
  return {
    schemaVersion: "resume-proposal/v1",
    jdSnapshotId: input.jdSnapshotId,
    candidateSnapshotId: input.candidateSnapshotId,
    requirements: [
      ...matched.map((phrase, index) => ({
        requirement_id: `req-${index}`,
        jd_quote: phrase.text,
        category: proposalCategory(phrase.category),
        importance: index < 2 ? "required" : "preferred",
        match_status: "matched",
        evidence_fact_ids: [...phrase.factIds],
        evidence_quotes: phrase.factIds.map((factId) => input.factTexts.get(factId) as string),
        review_status: "confirmed",
      })),
      ...(gap === undefined
        ? []
        : [
            {
              requirement_id: "req-gap",
              jd_quote: gap.text,
              category: proposalCategory(gap.category),
              importance: "required",
              match_status: "gap",
              evidence_fact_ids: [],
              evidence_quotes: [],
              review_status: "proposed",
            },
          ]),
    ],
    rationale: "F acceptance proposal: confirmed matches plus one reported gap.",
    questions: [],
  };
}

export interface FClaim {
  claimed: ClaimedWorkItem;
  context: WorkHandlerContext;
}

/** Real lease claim plus a handler context with a live heartbeat. */
export function claimFRun(
  handle: DatabaseHandle,
  workItemId: string,
  options: { workerId?: string; leaseDurationMs?: number; now?: string } = {},
): FClaim {
  const leaseDurationMs = options.leaseDurationMs ?? 300_000;
  const now = options.now ?? F_T0;
  // Claim exactly this item: the world holds one TAILOR item, so the
  // oldest-runnable claim is deterministic.
  const claimed = claimNextWorkItem(handle, {
    workerId: options.workerId ?? "f-worker",
    kinds: ["TAILOR"],
    leaseDurationMs,
    now,
  });
  if (claimed === null || claimed.id !== workItemId) {
    throw new Error("F claim did not return the seeded work item");
  }
  const context: WorkHandlerContext = {
    handle,
    item: { ...claimed, leaseToken: claimed.leaseToken },
    workerId: options.workerId ?? "f-worker",
    heartbeat: () =>
      renewLease(handle, {
        workItemId: claimed.id,
        leaseToken: claimed.leaseToken,
        attemptId: claimed.currentAttemptId,
        leaseDurationMs,
        now,
      }).ok,
    leaseDurationMs,
  };
  return { claimed, context };
}

export interface FHandlerOptions {
  artifactsDir: string;
  provider?: TailoringProvider | null;
  clock?: () => string;
  renderPdf?: (html: string) => Promise<{ bytes: Buffer }>;
  createRenewalTimer?: TailorHandlerDeps["createRenewalTimer"];
}

/** Real handler with the deterministic renderer; clock injectable. */
export function fHandler(options: FHandlerOptions) {
  return createTailorHandler({
    artifactsDir: options.artifactsDir,
    provider: options.provider === undefined ? new TestProvider({ proposals: {} }) : options.provider,
    renderPdf: options.renderPdf ?? (async (html: string) => stubRenderPdf(html)),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.createRenewalTimer === undefined ? {} : { createRenewalTimer: options.createRenewalTimer }),
  });
}

/** Throwing provider with exact reason/detail/spawn triplets. */
export function throwingProvider(error: unknown): TestProvider {
  const provider = new TestProvider({ proposals: {} });
  provider.prepare = async () => {
    throw error;
  };
  return provider;
}

/** Q5 probe: this attempt's boundary events in seq order. */
export function q5(handle: DatabaseHandle, requestId: string, attemptId: string) {
  return handle.db
    .select()
    .from(generationProgressEvents)
    .where(eq(generationProgressEvents.attemptId, attemptId))
    .all()
    .filter((event) => event.requestId === requestId)
    .sort((a, b) => a.seq - b.seq);
}

/** Q6 probe: committed analysis/version counts for one request. */
export function q6(handle: DatabaseHandle, requestId: string): { analyses: number; versions: number } {
  const row = handle.sqlite
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM job_analyses WHERE generation_request_id = ?) AS analyses,
        (SELECT COUNT(*) FROM resume_versions WHERE generation_request_id = ?) AS versions`,
    )
    .get(requestId, requestId) as { analyses: number; versions: number };
  return row;
}

export function attemptsFor(handle: DatabaseHandle, workItemId: string) {
  return handle.db
    .select()
    .from(workAttempts)
    .where(eq(workAttempts.workItemId, workItemId))
    .all()
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
}

export function workItemFor(handle: DatabaseHandle, workItemId: string) {
  const row = handle.db.select().from(workItems).where(eq(workItems.id, workItemId)).get();
  if (row === undefined) {
    throw new Error(`work item ${workItemId} missing`);
  }
  return row;
}
