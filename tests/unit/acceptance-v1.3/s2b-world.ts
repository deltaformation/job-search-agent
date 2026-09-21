// @vitest-environment node
import { count, eq } from "drizzle-orm";
import {
  createTestDatabase,
  generationRequests,
  jobs,
  newId,
  resumeReviews,
  resumeVersions,
  workItems,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { getProfileVersion } from "../../../src/db/candidates";
import {
  insertPlan,
  markPreparationSucceeded,
  readPlan,
  readPreparationById,
  readPreparationByJob,
} from "../../../src/db/step2";
import { canonicalJson, canonicalText } from "../../../src/domain/canonical";
import { parseStoredProfilePayload } from "../../../src/domain/candidate";
import type { PreparationPlanV1 as PreparationPlanV1Type } from "../../../src/domain/step2";
import {
  PreparationPlanV2,
  type PreparationPlanV2 as PreparationPlanV2Type,
} from "../../../src/domain/step2Correction";
import type {
  PreparationProposalV1Type,
  PreparationProposalV2Type,
} from "../../../src/tailoring/contract";
import { sha256HexUtf8 } from "../../../src/tailoring/hash";
import { phraseIdFor } from "../../../src/tailoring/requestsV3";
import type { HandlerOutcome, WorkHandlerContext } from "../../../src/queue/dispatch";
import { claimNextWorkItem, completeWorkItem } from "../../../src/queue/leases";
import { createPrepareHandler } from "../../../src/tailoring/prepareHandler";
import { buildAcceptedPlan } from "../../../src/tailoring/preparePlan";
import { masterProjectionHashFor, planHashFor } from "../../../src/tailoring/step2policy";
import { TestPrepareProvider } from "../../../src/tailoring/testProvider";
import {
  getOrCreateCandidateSnapshot,
  getOrCreateJdSnapshot,
} from "../../../src/server/candidates";
import { schedulePreparation } from "../../../src/server/preparation";
import {
  PM_JD_TEXT,
  seedCrossProfileWorld,
  type CrossProfileWorld,
} from "../acceptance-v1.2/world";
import {
  seedV13Basics,
  v13ExtractionJson,
  type V13Basics,
} from "../db/v13world";

/**
 * WO-1.3-S2-B acceptance world: real intake capture, real P/PR
 * transactions, real lease claims, and the real PREPARE handler
 * with a deterministic provider. Proposals are built from exact JD
 * substrings and approved world facts, so the happy path validates
 * through the actual pipeline — no fixture bytes are smuggled in.
 */

export const S2B_T0 = "2026-09-17T12:00:00.000Z";
export const S2B_KEYED_ENV = {
  ACTIVE_AI_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "test-key",
};
export const S2B_UNKEYED_ENV = { ACTIVE_AI_PROVIDER: "openrouter" };
export const S2B_JD = PM_JD_TEXT;

export async function withS2bDatabase(
  fn: (t: TestDatabase, world: CrossProfileWorld) => Promise<void> | void,
): Promise<void> {
  const t = createTestDatabase("job-tracker-v13-s2b-");
  try {
    await fn(t, seedCrossProfileWorld(t));
  } finally {
    t.cleanup();
  }
}

/** READY job with an active extraction over the PM JD (or override). */
export function seedS2bJob(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  jdText: string = S2B_JD,
): V13Basics {
  return seedV13Basics(handle, world, {
    jdText,
    extractedJson: v13ExtractionJson(jdText),
  });
}

export interface S2bScheduled {
  preparationId: string;
  workItemId: string;
}

/** Real explicit P schedule of the world's PM profile; throws unless 202. */
export function scheduleS2b(
  handle: DatabaseHandle,
  basics: V13Basics,
  overrides: {
    operationId?: string;
    observedRowVersion?: number;
    profileId?: string | null;
    env?: NodeJS.ProcessEnv;
    now?: string;
  } = {},
): S2bScheduled {
  const scheduled = schedulePreparation(handle, {
    jobId: basics.jobId,
    body: {
      schemaVersion: "step2-prepare/v1",
      operationId: overrides.operationId ?? newId(),
      observedRowVersion: overrides.observedRowVersion ?? 1,
      profileId: overrides.profileId ?? null,
    },
    env: (overrides.env ?? S2B_KEYED_ENV) as NodeJS.ProcessEnv,
    now: overrides.now ?? S2B_T0,
  });
  if (!scheduled.ok) {
    throw new Error(`S2-B schedule failed: ${scheduled.error} ${scheduled.message}`);
  }
  if (scheduled.value.replayed) {
    throw new Error("S2-B schedule unexpectedly replayed");
  }
  const preparation = readPreparationById(handle, scheduled.value.preparationId);
  if (preparation?.workItemId === null || preparation?.workItemId === undefined) {
    throw new Error("S2-B schedule returned no work item");
  }
  return { preparationId: scheduled.value.preparationId, workItemId: preparation.workItemId };
}

export interface S2bClaimed {
  workItemId: string;
  attemptId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export function claimS2b(
  handle: DatabaseHandle,
  input: { workerId?: string; now?: string; leaseDurationMs?: number } = {},
): S2bClaimed {
  const claimed = claimNextWorkItem(handle, {
    workerId: input.workerId ?? "s2b-worker",
    kinds: ["PREPARE"],
    leaseDurationMs: input.leaseDurationMs ?? 300_000,
    now: input.now ?? S2B_T0,
  });
  if (claimed === null) {
    throw new Error("S2-B claim found no PREPARE work");
  }
  return {
    workItemId: claimed.id,
    attemptId: claimed.currentAttemptId as string,
    leaseToken: claimed.leaseToken as string,
    leaseExpiresAt: claimed.leaseExpiresAt as string,
  };
}

export function s2bContext(
  handle: DatabaseHandle,
  claimed: S2bClaimed,
  overrides: Partial<WorkHandlerContext> = {},
): WorkHandlerContext {
  const item = handle.db
    .select()
    .from(workItems)
    .where(eq(workItems.id, claimed.workItemId))
    .get();
  if (item === undefined || item.leaseToken === null || item.currentAttemptId === null) {
    throw new Error("S2-B context needs a live claimed item");
  }
  return {
    handle,
    item: { ...item, leaseToken: item.leaseToken },
    workerId: "s2b-worker",
    heartbeat: () => true,
    ...overrides,
  };
}

export function s2bHandler(options: {
  provider: TestPrepareProvider | null;
  now?: string;
}) {
  return createPrepareHandler({
    provider: options.provider,
    clock: () => options.now ?? S2B_T0,
  });
}

/** Generation-side counters: S2-B must never move them (ΔQ1 = 0). */
export function s2bQ1(handle: DatabaseHandle): {
  requests: number;
  versions: number;
  reviews: number;
} {
  const requests = handle.db.select({ n: count() }).from(generationRequests).get()?.n ?? 0;
  const versions = handle.db.select({ n: count() }).from(resumeVersions).get()?.n ?? 0;
  const reviews = handle.db.select({ n: count() }).from(resumeReviews).get()?.n ?? 0;
  return { requests, versions, reviews };
}

/** Board counters: preparation never moves cards (ΔQ4 = 0). */
export function s2bQ4(handle: DatabaseHandle): Record<string, number> {
  const rows = handle.db.select({ status: jobs.status }).from(jobs).all();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Locate exact JD substrings on the live bytes (never fixture
 * offsets), shared by the v1/v2 proposal builders.
 */
function locateProposalQuotes(
  jdText: string,
  quotes: Array<{ text: string }>,
): Array<{ text: string; startByte: number; endByte: number }> {
  const bytes = Buffer.from(jdText, "utf8");
  return quotes.map((quote) => {
    const startByte = bytes.indexOf(quote.text);
    if (startByte === -1) {
      throw new Error(`S2-B quote is not a JD substring: ${JSON.stringify(quote.text)}`);
    }
    return { text: quote.text, startByte, endByte: startByte + Buffer.byteLength(quote.text, "utf8") };
  });
}

/**
 * Build a schema-valid v2 proposal: v1 fields plus same-plan
 * priority links computed with the real `phraseIdFor` over the
 * caller's extraction id and JD hash. Angles/suggestions link
 * quote indexes (`links`, default: every quote).
 */
export function proposalForS2bV2(input: {
  jdText: string;
  jdSnapshotId: string;
  candidateSnapshotId: string;
  extractionId: string;
  jdHash: string;
  quotes: Array<{
    text: string;
    importance: "required" | "preferred" | "unspecified";
    matchStatus: "matched" | "partial" | "gap" | "unsupported";
    factIds: string[];
  }>;
  angles?: Array<{ title: string; summaryText: string; factIds: string[]; links?: number[] }>;
  suggestions?: Array<{ roleId: string; text: string; factIds: string[]; links?: number[] }>;
  rationale?: string;
}): PreparationProposalV2Type {
  const located = locateProposalQuotes(input.jdText, input.quotes);
  const ids = located.map((quote) =>
    phraseIdFor({
      extractionId: input.extractionId,
      jdHash: input.jdHash,
      startByte: quote.startByte,
      endByte: quote.endByte,
      text: quote.text,
    }),
  );
  const linksFor = (links: number[] | undefined): string[] => {
    const indexes = links ?? ids.map((_, index) => index);
    return [...new Set(indexes.map((index) => {
      const id = ids[index];
      if (id === undefined) {
        throw new Error(`S2-B link names no quote: ${index}`);
      }
      return id;
    }))];
  };
  return {
    schemaVersion: "preparation-proposal/v2",
    jdSnapshotId: input.jdSnapshotId,
    candidateSnapshotId: input.candidateSnapshotId,
    priorities: input.quotes.map((quote, index) => ({
      quote: located[index] as { text: string; startByte: number; endByte: number },
      count: 1,
      category: "skill",
      importance: quote.importance,
      matchStatus: quote.matchStatus,
      factIds: [...quote.factIds],
    })),
    angles: (input.angles ?? []).map((angle) => ({
      title: angle.title,
      summaryText: angle.summaryText,
      factIds: [...angle.factIds],
      priorityIds: linksFor(angle.links),
    })),
    suggestions: (input.suggestions ?? []).map((suggestion) => ({
      roleId: suggestion.roleId,
      text: suggestion.text,
      factIds: [...suggestion.factIds],
      priorityIds: linksFor(suggestion.links),
    })),
    rationale: input.rationale ?? "S2-B scripted proposal.",
  };
}
/**
 * Build a schema-valid proposal from exact JD substrings and world
 * facts. Quotes are located in the live JD text (never fixture
 * offsets); fact ids come from the world's approved PM facts.
 */
export function proposalForS2b(input: {
  jdText: string;
  jdSnapshotId: string;
  candidateSnapshotId: string;
  quotes: Array<{
    text: string;
    importance: "required" | "preferred" | "unspecified";
    matchStatus: "matched" | "partial" | "gap" | "unsupported";
    factIds: string[];
  }>;
  angles?: Array<{ title: string; summaryText: string; factIds: string[] }>;
  suggestions?: Array<{ roleId: string; text: string; factIds: string[] }>;
  rationale?: string;
}): PreparationProposalV1Type {
  const bytes = Buffer.from(input.jdText, "utf8");
  return {
    schemaVersion: "preparation-proposal/v1",
    jdSnapshotId: input.jdSnapshotId,
    candidateSnapshotId: input.candidateSnapshotId,
    priorities: input.quotes.map((quote) => {
      const startByte = bytes.indexOf(quote.text);
      if (startByte === -1) {
        throw new Error(`S2-B quote is not a JD substring: ${JSON.stringify(quote.text)}`);
      }
      return {
        quote: { text: quote.text, startByte, endByte: startByte + Buffer.byteLength(quote.text, "utf8") },
        count: 1,
        category: "skill",
        importance: quote.importance,
        matchStatus: quote.matchStatus,
        factIds: [...quote.factIds],
      };
    }),
    angles: (input.angles ?? []).map((angle) => ({ ...angle, factIds: [...angle.factIds] })),
    suggestions: (input.suggestions ?? []).map((suggestion) => ({
      ...suggestion,
      factIds: [...suggestion.factIds],
    })),
    rationale: input.rationale ?? "S2-B scripted proposal.",
  };
}

/** Snapshot ids the handler resolves (same getOrCreate calls P made). */
export function s2bSnapshotIds(
  handle: DatabaseHandle,
  basics: V13Basics,
  jdText: string,
): { jdSnapshotId: string; candidateSnapshotId: string } {
  const jd = getOrCreateJdSnapshot(handle, {
    jobId: basics.jobId,
    extractionId: basics.extractionId,
    jdText,
  });
  if (!jd.ok) {
    throw new Error(`S2-B JD snapshot failed: ${jd.error}`);
  }
  const candidate = getOrCreateCandidateSnapshot(handle, {
    profileVersionId: basics.profileVersionId,
  });
  if (!candidate.ok) {
    throw new Error(`S2-B candidate snapshot failed: ${candidate.error}`);
  }
  return { jdSnapshotId: jd.snapshotId, candidateSnapshotId: candidate.snapshotId };
}

/** World PM profile payload + approved fact ids for proposal building. */
export function pmEvidenceFor(handle: DatabaseHandle, world: CrossProfileWorld): {
  payload: ReturnType<typeof parseStoredProfilePayload>;
  factIds: string[];
  employments: Array<{ id: string; company: string }>;
} {
  const version = getProfileVersion(handle, world.pmVersionId);
  if (version === null) {
    throw new Error("S2-B world has no PM version");
  }
  const payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
  return {
    payload,
    factIds: payload.achievements
      .filter((achievement) => achievement.verification === "APPROVED")
      .map((achievement) => achievement.factId),
    employments: payload.employment.map((entry) => ({ id: entry.id, company: entry.company })),
  };
}

export { completeWorkItem };

export interface S2bProposalKit {
  proposal: PreparationProposalV2Type;
  snapshots: { jdSnapshotId: string; candidateSnapshotId: string };
  discoveryText: string;
}

/**
 * Scriptable proposal over the world's PM JD (or override): two
 * supported required priorities, one visible gap, one usable
 * Harbor suggestion quoting the discovery fact verbatim, and one
 * evidence-backed angle. Quotes locate on the canonical JD bytes.
 */
export function s2bProposalKit(
  handle: DatabaseHandle,
  basics: V13Basics,
  world: CrossProfileWorld,
  jdText: string = S2B_JD,
): S2bProposalKit {
  const snapshots = s2bSnapshotIds(handle, basics, jdText);
  const evidence = pmEvidenceFor(handle, world);
  const discovery = evidence.payload.achievements.find(
    (achievement) => achievement.factId === "pm-fact-discovery",
  );
  if (discovery === undefined) {
    throw new Error("S2-B world lost the discovery fact");
  }
  const proposal = proposalForS2bV2({
    jdText: canonicalText(jdText),
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    extractionId: basics.extractionId,
    jdHash: sha256HexUtf8(canonicalText(jdText)),
    quotes: [
      {
        text: "customer discovery",
        importance: "required",
        matchStatus: "matched",
        factIds: ["pm-fact-discovery"],
      },
      {
        text: "pricing",
        importance: "required",
        matchStatus: "matched",
        factIds: ["pm-fact-pricing"],
      },
      {
        text: "KPI measurement",
        importance: "preferred",
        matchStatus: "gap",
        factIds: [],
      },
    ],
    angles: [
      {
        title: "Discovery-led roadmap",
        summaryText: "Discovery interviews that reshape roadmaps and lift conversion.",
        factIds: ["pm-fact-discovery", "pm-fact-roadmap"],
        links: [0],
      },
    ],
    suggestions: [
      {
        roleId: "emp-harbor",
        text: canonicalText(discovery.text),
        factIds: ["pm-fact-discovery"],
        links: [0],
      },
    ],
  });
  return { proposal, snapshots, discoveryText: canonicalText(discovery.text) };
}

export interface V1AcceptedSeed {
  basics: V13Basics;
  preparationId: string;
  planRowId: string;
  planHash: string;
  plan: PreparationPlanV1Type;
  now: string;
}

export interface V1AcceptInput {
  basics: V13Basics;
  preparationId: string;
  attemptId: string;
  profileVersionId: string;
  payload: ReturnType<typeof parseStoredProfilePayload>;
  proposal: PreparationProposalV1Type;
  jdText: string;
  now: string;
}

/**
 * Accept a v1 plan over caller-built evidence with the pure v1
 * builder + repos (no provider call). Shared by the PM-world seed
 * and the S2-D drift world, which carries renamed facts over a
 * custom profile version. The row carries v1 lineage literals and
 * byte-identical v1 plan JSON.
 */
export function acceptV1Plan(
  handle: DatabaseHandle,
  input: V1AcceptInput,
): { planRowId: string; planHash: string; plan: PreparationPlanV1Type } {
  const scheduledRow = readPreparationById(handle, input.preparationId);
  if (scheduledRow === null) {
    throw new Error("S2-B v1 accept found no scheduled row");
  }
  const canonicalJd = canonicalText(input.jdText);
  const built = buildAcceptedPlan({
    planId: newId(),
    preparationId: input.preparationId,
    extractionId: input.basics.extractionId,
    jdHash: sha256HexUtf8(canonicalJd),
    canonicalJdText: canonicalJd,
    profileVersionId: input.profileVersionId,
    evidenceHash: scheduledRow.evidenceHash,
    masterProjectionHash: masterProjectionHashFor(input.payload),
    payload: input.payload,
    facts: input.payload.achievements.map((achievement) => ({
      factId: achievement.factId,
      statement: achievement.text,
      verification: achievement.verification,
      profileVersionId: input.profileVersionId,
      employmentId: achievement.employmentId ?? null,
      metrics: [...achievement.metrics],
    })),
    proposal: input.proposal,
  });
  if (!built.ok) {
    throw new Error(`S2-B v1 accept build failed: ${built.error} ${built.detail}`);
  }
  const planHash = planHashFor(built.plan);
  const saved = insertPlan(handle, {
    id: built.plan.planId,
    preparationId: input.preparationId,
    planJson: canonicalJson(built.plan),
    planHash,
    providerId: "test-prepare-provider",
    model: null,
    promptVersion: "prepare-prompt/v1",
    proposalSchemaVersion: "preparation-proposal/v1",
    claimsPolicyVersion: "step2-claims/1",
    inputHash: "0".repeat(64),
    proposalHash: "1".repeat(64),
    attemptId: input.attemptId,
    validationJson: canonicalJson(built.validation),
    supersedesPlanId: null,
    now: input.now,
  });
  markPreparationSucceeded(handle, { preparationId: input.preparationId, planId: saved.id, now: input.now });
  return { planRowId: saved.id, planHash, plan: built.plan };
}

/**
 * Seed an accepted v1 plan directly (pure v1 builder + repos, no
 * provider call): the preserved-path fixture for S2-C/S2-D suites
 * after the handler cut over to v2. The row carries v1 lineage
 * literals and byte-identical v1 plan JSON.
 */
export function seedV1Accepted(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  jdText: string = S2B_JD,
  now: string = S2B_T0,
  existing?: V13Basics,
): V1AcceptedSeed {
  const basics = existing ?? seedS2bJob(handle, world, jdText);
  const scheduled = scheduleS2b(handle, basics, { profileId: world.pmProfileId, now });
  const claimed = claimS2b(handle, { now });
  const snapshots = s2bSnapshotIds(handle, basics, jdText);
  const evidence = pmEvidenceFor(handle, world);
  const discovery = evidence.payload.achievements.find(
    (achievement) => achievement.factId === "pm-fact-discovery",
  );
  if (discovery === undefined) {
    throw new Error("S2-B world lost the discovery fact");
  }
  const proposal = proposalForS2b({
    jdText: canonicalText(jdText),
    jdSnapshotId: snapshots.jdSnapshotId,
    candidateSnapshotId: snapshots.candidateSnapshotId,
    quotes: [
      { text: "customer discovery", importance: "required", matchStatus: "matched", factIds: ["pm-fact-discovery"] },
      { text: "pricing", importance: "required", matchStatus: "matched", factIds: ["pm-fact-pricing"] },
      { text: "KPI measurement", importance: "preferred", matchStatus: "gap", factIds: [] },
    ],
    angles: [
      {
        title: "Discovery-led roadmap",
        summaryText: "Discovery interviews that reshape roadmaps and lift conversion.",
        factIds: ["pm-fact-discovery", "pm-fact-roadmap"],
      },
    ],
    suggestions: [
      { roleId: "emp-harbor", text: canonicalText(discovery.text), factIds: ["pm-fact-discovery"] },
    ],
  });
  const accepted = acceptV1Plan(handle, {
    basics,
    preparationId: scheduled.preparationId,
    attemptId: claimed.attemptId,
    profileVersionId: world.pmVersionId,
    payload: evidence.payload,
    proposal,
    jdText,
    now,
  });
  // Settle the claimed attempt so the seed leaves no live work
  // behind (generation refuses while any item is live).
  finishS2bAttempt(handle, {
    ...claimed,
    outcome: { result: "SUCCEEDED", terminal: true, outputHash: accepted.planHash },
    now,
  });
  return {
    basics,
    preparationId: scheduled.preparationId,
    planRowId: accepted.planRowId,
    planHash: accepted.planHash,
    plan: accepted.plan,
    now,
  };
}

export interface V2AcceptedSeed {
  basics: V13Basics;
  preparationId: string;
  planRowId: string;
  planHash: string;
  plan: PreparationPlanV2Type;
  now: string;
}

/**
 * Seed a job with an accepted v2 plan through the REAL pipeline
 * (v2 kit proposal + schedule + claim + handler + settle): the
 * corrected-path fixture for CP-B pins and s2cpb suites. Throws
 * unless the cycle succeeds and the stored bytes parse as
 * `step2-plan/v2`.
 */
export async function seedV2Accepted(
  handle: DatabaseHandle,
  world: CrossProfileWorld,
  jdText: string = S2B_JD,
  now: string = S2B_T0,
  existing?: V13Basics,
): Promise<V2AcceptedSeed> {
  const basics = existing ?? seedS2bJob(handle, world, jdText);
  const kit = s2bProposalKit(handle, basics, world, jdText);
  const scheduled = scheduleS2b(handle, basics, { profileId: world.pmProfileId, now });
  const claimed = claimS2b(handle, { now });
  const provider = new TestPrepareProvider({
    proposals: { [kit.snapshots.jdSnapshotId]: kit.proposal },
  });
  const outcome = await runS2bAttempt(handle, claimed, provider, { now });
  if (outcome.result !== "SUCCEEDED") {
    throw new Error(
      `S2-B v2 seed cycle failed: ${outcome.result} ${outcome.errorCode ?? ""} ${outcome.errorDetail ?? ""}`,
    );
  }
  finishS2bAttempt(handle, { ...claimed, outcome, now });
  const preparation = readPreparationByJob(handle, basics.jobId);
  if (preparation?.acceptedPlanId === null || preparation?.acceptedPlanId === undefined) {
    throw new Error("S2-B v2 seed produced no accepted plan");
  }
  const stored = readPlan(handle, preparation.acceptedPlanId);
  if (stored === null) {
    throw new Error("S2-B v2 seed cannot read the accepted plan");
  }
  return {
    basics,
    preparationId: scheduled.preparationId,
    planRowId: stored.id,
    planHash: stored.planHash,
    plan: PreparationPlanV2.parse(JSON.parse(stored.planJson) as unknown),
    now,
  };
}

/** Run one claimed PREPARE attempt through the real handler. */
export async function runS2bAttempt(
  handle: DatabaseHandle,
  claimed: S2bClaimed,
  provider: TestPrepareProvider | null,
  overrides: { heartbeat?: () => boolean; now?: string } = {},
): Promise<HandlerOutcome> {
  const context =
    overrides.heartbeat === undefined
      ? s2bContext(handle, claimed)
      : s2bContext(handle, claimed, { heartbeat: overrides.heartbeat });
  return s2bHandler({ provider, now: overrides.now })(context);
}

/** Complete one claimed attempt the way the dispatcher would. Throws unless filed. */
export function finishS2bAttempt(
  handle: DatabaseHandle,
  input: {
    workItemId: string;
    leaseToken: string;
    attemptId: string;
    outcome: HandlerOutcome;
    now?: string;
    backoff?: { baseMs?: number; maxMs?: number };
  },
): void {
  const finished = completeWorkItem(
    handle,
    {
      workItemId: input.workItemId,
      leaseToken: input.leaseToken,
      attemptId: input.attemptId,
      result: input.outcome.result,
      errorCode: input.outcome.errorCode ?? null,
      errorDetail: input.outcome.errorDetail ?? null,
      inputHash: input.outcome.inputHash ?? null,
      outputHash: input.outcome.outputHash ?? null,
    },
    {
      now: input.now ?? S2B_T0,
      terminal: input.outcome.terminal,
      ...(input.backoff === undefined ? {} : { backoff: input.backoff }),
    },
  );
  if (!finished.ok) {
    throw new Error(`S2-B completion failed: ${finished.error}`);
  }
}
