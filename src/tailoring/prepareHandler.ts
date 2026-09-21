import type { DatabaseHandle } from "../db/client";
import { getProfileVersion, listFactsByVersion } from "../db/candidates";
import type { Step2Preparation } from "../db/schema/step2";
import {
  appendPreparationEventFenced,
  insertPlan,
  markPreparationFailed,
  markPreparationRunning,
  markPreparationSucceeded,
  readAttemptWorkItemId,
  readJobExtractionJson,
  readLatestPlan,
  readPlanByHash,
  readPreparationById,
  readPreparationByJob,
} from "../db/step2";
import { getTailoringJob } from "../db/tailoring";
import { withTransaction } from "../db/transactions";
import { newId, utcNow } from "../db/utils";
import { canonicalJson, canonicalText } from "../domain/canonical";
import { parseStoredProfilePayload } from "../domain/candidate";
import { parseVersionedPayload } from "../domain/envelopes";
import { parseStoredExtraction } from "../domain/extraction";
import {
  IntakeBindingV1,
  PreparePayloadV1,
  STEP2_BUDGETS,
  masterBulletsByRole,
  type PreparationStage as PreparationStageType,
} from "../domain/step2";
import {
  PREPARE_PROMPT_VERSION_V2,
  PreparationInputV2,
  PreparationPlanV2,
} from "../domain/step2Correction";
import type { HandlerOutcome, WorkHandler, WorkHandlerContext } from "../queue/dispatch";
import { DEFAULT_LEASE_DURATION_MS } from "../queue/leases";
import { createLogger } from "../security/logger";
import { getOrCreateCandidateSnapshot, getOrCreateJdSnapshot } from "../server/candidates";
import {
  buildPreparationFailure,
  encodePreparationFailureDetail,
  isExplicitOnlyFailureCode,
  launchSubcodeForSpawnCode,
  LeaseLostError,
  type PreparationFailureCode,
} from "./failures";
import { isLeaseLostViolation, renewalIntervalMs, type RenewalTimer, type RenewalTimerFactory } from "./handler";
import { buildAcceptedPlanV2 } from "./preparePlanV2";
import { ProviderError, type PrepareProvider } from "./contract";
import { sha256HexUtf8 } from "./hash";
import {
  bindingHashFor,
  evidenceHashFor,
  masterProjectionHashFor,
} from "./step2policy";
import { correctionPlanHashFor } from "./step2CorrectionPolicy";

const log = createLogger("prepare-handler");

export interface PrepareHandlerDeps {
  /** Null when no provider is configured: runs fail CONFIGURATION. */
  provider: PrepareProvider | null;
  clock?: () => string;
  /** Renewal-timer factory; tests inject a manual timer. */
  createRenewalTimer?: RenewalTimerFactory;
}

const PREPARE_STAGE_SEQ: Record<PreparationStageType, 1 | 2 | 3 | 4 | 5> = {
  LOADING_INPUTS: 1,
  WAITING_FOR_PROVIDER: 2,
  VALIDATING_PROPOSAL: 3,
  STORING_PLAN: 4,
  PUBLISHING_PLAN: 5,
};

export interface PrepareProgressEmitter {
  emitStage(stage: PreparationStageType): void;
  readonly lastStage: PreparationStageType | null;
}

/**
 * Fenced stage emitter: one short transaction per boundary; a dead
 * lease raises LeaseLostError so the run aborts write-free. Any
 * other trigger rejection propagates as-is (handler bug, never
 * lease loss).
 */
export function createPrepareProgressEmitter(
  handle: DatabaseHandle,
  input: {
    preparationId: string;
    workItemId: string;
    attemptId: string;
    leaseToken: string;
    source: "provider" | "cached";
    clock: () => string;
  },
): PrepareProgressEmitter {
  let lastStage: PreparationStageType | null = null;
  const emitStage = (stage: PreparationStageType): void => {
    try {
      appendPreparationEventFenced(handle, {
        preparationId: input.preparationId,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        seq: PREPARE_STAGE_SEQ[stage],
        stage,
        source: input.source,
        leaseToken: input.leaseToken,
        recordedAt: input.clock(),
      });
    } catch (error: unknown) {
      if (isLeaseLostViolation(error)) {
        throw new LeaseLostError();
      }
      throw error;
    }
    lastStage = stage;
  };
  return {
    emitStage,
    get lastStage() {
      return lastStage;
    },
  };
}

function defaultRenewalTimer(intervalMs: number, onTick: () => void): RenewalTimer {
  const timer = setInterval(onTick, Math.max(1, intervalMs));
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}

function failedPrepareOutcome(
  code: PreparationFailureCode,
  stage: PreparationStageType | null,
  now: string,
  extra: {
    retryAfterSeconds?: number | null;
    launchSubcode?: string | null;
    terminal?: boolean;
    inputHash?: string;
    outputHash?: string;
  } = {},
): HandlerOutcome {
  return {
    result: "FAILED",
    errorCode: code,
    errorDetail: encodePreparationFailureDetail(
      buildPreparationFailure(code, {
        stage,
        occurredAt: now,
        retryAfterSeconds: extra.retryAfterSeconds ?? null,
        launchSubcode: launchSubcodeForSpawnCode(extra.launchSubcode ?? null),
      }),
    ),
    ...(extra.terminal === true ? { terminal: true as const } : {}),
    ...(extra.inputHash === undefined ? {} : { inputHash: extra.inputHash }),
    ...(extra.outputHash === undefined ? {} : { outputHash: extra.outputHash }),
  };
}

function blockedPrepareOutcome(
  code: PreparationFailureCode,
  stage: PreparationStageType | null,
  now: string,
): HandlerOutcome {
  return {
    result: "BLOCKED",
    errorCode: code,
    errorDetail: encodePreparationFailureDetail(
      buildPreparationFailure(code, { stage, occurredAt: now }),
    ),
  };
}

interface VerifiedPreparation {
  row: Step2Preparation;
  canonicalJdText: string;
  jdHash: string;
  payload: ReturnType<typeof parseStoredProfilePayload>;
  payloadHash: string;
  approvedFacts: Array<{
    factId: string;
    statement: string;
    verification: "APPROVED";
    profileVersionId: string;
    employmentId: string | null;
    metrics: string[];
  }>;
}

type PreparationVerification =
  | { ok: true; verified: VerifiedPreparation }
  | { ok: false; code: PreparationFailureCode; logDetail: string };

/**
 * S2-A §6.2 verification order, before any provider call: payload
 * schema → row ownership → binding hash → active extraction →
 * payload/evidence hashes. Any mismatch is INPUT_STALE (a new
 * explicit command is required, never an in-place retry), except
 * unapproved/foreign evidence (PROFILE_UNAVAILABLE).
 */
function verifyPreparation(
  handle: DatabaseHandle,
  itemJobId: string | null,
  payload: { preparationId: string; jobId: string; extractionId: string; profileVersionId: string; bindingHash: string },
): PreparationVerification {
  const stale = (logDetail: string): PreparationVerification => ({
    ok: false,
    code: "INPUT_STALE",
    logDetail,
  });
  const row = readPreparationById(handle, payload.preparationId);
  if (row === null) {
    return stale(`preparation '${payload.preparationId}' does not exist`);
  }
  if (row.jobId !== payload.jobId || row.jobId !== itemJobId) {
    return stale(
      `preparation '${row.id}' binds job '${row.jobId ?? "none"}' but the item targets '${itemJobId ?? "none"}'`,
    );
  }
  let binding: ReturnType<typeof IntakeBindingV1.parse>;
  try {
    binding = IntakeBindingV1.parse(JSON.parse(row.bindingJson) as unknown);
  } catch {
    return stale(`preparation '${row.id}' carries an unparseable binding`);
  }
  if (bindingHashFor(binding) !== payload.bindingHash) {
    return stale(`preparation '${row.id}' binding hash disagrees with the payload`);
  }
  if (row.profileVersionId !== payload.profileVersionId) {
    return stale(`preparation '${row.id}' profile binding disagrees with the payload`);
  }
  const job = getTailoringJob(handle, payload.jobId);
  if (job === null) {
    return stale(`preparation '${row.id}' job '${payload.jobId}' is gone`);
  }
  if (row.extractionId === null || row.extractionId !== payload.extractionId) {
    return stale(`preparation '${row.id}' extraction link disagrees with the payload`);
  }
  if (job.activeExtractionId !== row.extractionId) {
    return stale(`preparation '${row.id}' extraction is no longer the job's active extraction`);
  }
  const extractedJson = readJobExtractionJson(handle, row.extractionId);
  if (extractedJson === null) {
    return stale(`preparation '${row.id}' extraction row is missing`);
  }
  let envelope: ReturnType<typeof parseStoredExtraction>;
  try {
    envelope = parseStoredExtraction(JSON.parse(extractedJson) as unknown);
  } catch {
    return stale(`preparation '${row.id}' extraction fails strict validation`);
  }
  const canonicalJdText = canonicalText(envelope.fields.descriptionText ?? "");
  if (canonicalJdText === "") {
    return stale(`preparation '${row.id}' extraction carries no job description text`);
  }
  const version = getProfileVersion(handle, row.profileVersionId);
  if (version === null) {
    return stale(`preparation '${row.id}' profile version is gone`);
  }
  let profile: ReturnType<typeof parseStoredProfilePayload>;
  try {
    profile = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
  } catch {
    return stale(`preparation '${row.id}' profile payload fails strict validation`);
  }
  const payloadHash = sha256HexUtf8(canonicalJson(profile));
  if (payloadHash !== version.payloadHash || payloadHash !== row.profilePayloadHash) {
    return stale(`preparation '${row.id}' profile payload hash disagrees with the binding`);
  }
  // Fact rows carry statements and verification; the payload's
  // achievement entries own employment linkage and metrics (same
  // rule as the recommendation builder).
  const employmentOf = new Map<string, string>();
  const metricsByFact = new Map<string, string[]>();
  for (const achievement of profile.achievements) {
    if (achievement.employmentId !== undefined) {
      employmentOf.set(achievement.factId, achievement.employmentId);
    }
    metricsByFact.set(achievement.factId, [...achievement.metrics]);
  }
  const approvedFacts = listFactsByVersion(handle, version.id)
    .filter((fact) => fact.verification === "APPROVED")
    .map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      verification: "APPROVED" as const,
      profileVersionId: version.id,
      employmentId: employmentOf.get(fact.factId) ?? null,
      metrics: metricsByFact.get(fact.factId) ?? [],
    }));
  const recomputedEvidence = evidenceHashFor({
    profileVersionId: version.id,
    payloadHash,
    approved: approvedFacts.map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      employmentId: fact.employmentId,
    })),
  });
  if (recomputedEvidence !== row.evidenceHash) {
    return {
      ok: false,
      code: "PROFILE_UNAVAILABLE",
      logDetail: `preparation '${row.id}' approved evidence drifted from the captured binding`,
    };
  }
  return {
    ok: true,
    verified: {
      row,
      canonicalJdText,
      jdHash: sha256HexUtf8(canonicalJdText),
      payload: profile,
      payloadHash,
      approvedFacts,
    },
  };
}

function providerReasonToCode(reason: string): PreparationFailureCode {
  switch (reason) {
    case "AUTHENTICATION":
      return "AUTHENTICATION";
    case "RATE_LIMIT":
      return "RATE_LIMIT";
    case "TIMEOUT":
      return "PROVIDER_TIMEOUT";
    case "NETWORK":
      return "NETWORK";
    case "INVALID_RESPONSE":
      return "INVALID_RESPONSE";
    case "LOCAL_LAUNCH":
      return "LOCAL_LAUNCH";
    default:
      return "INTERNAL";
  }
}

export function createPrepareHandler(deps: PrepareHandlerDeps): WorkHandler {
  const clock = deps.clock ?? utcNow;
  return async (context: WorkHandlerContext): Promise<HandlerOutcome> => {
    let rawPayload: unknown;
    try {
      rawPayload =
        context.item.payloadJson === null ? null : (JSON.parse(context.item.payloadJson) as unknown);
    } catch {
      rawPayload = undefined;
    }
    const parsed = parseVersionedPayload({ "prepare-queue/v1": PreparePayloadV1 }, rawPayload);
    if (!parsed.ok) {
      log.error("prepare payload refused", {
        workItemId: context.item.id,
        error: parsed.error,
      });
      return blockedPrepareOutcome("INPUT_STALE", null, clock());
    }
    const payload = parsed.value as {
      preparationId: string;
      jobId: string;
      extractionId: string;
      profileVersionId: string;
      bindingHash: string;
    };
    const workAttemptId = context.item.currentAttemptId;
    if (workAttemptId === null) {
      throw new Error(`claimed item '${context.item.id}' carries no attempt id`);
    }

    const verification = verifyPreparation(context.handle, context.item.jobId, payload);
    if (!verification.ok) {
      log.error("preparation verification failed", {
        workItemId: context.item.id,
        errorCode: verification.code,
        detail: verification.logDetail,
      });
      if (!context.heartbeat()) {
        return failedPrepareOutcome("LEASE_LOST", null, clock());
      }
      markPreparationFailed(context.handle, {
        preparationId: payload.preparationId,
        failureJson: encodePreparationFailureDetail(
          buildPreparationFailure(verification.code, { stage: null, occurredAt: clock() }),
        ),
        now: clock(),
      });
      return blockedPrepareOutcome(verification.code, null, clock());
    }
    const verified = verification.verified;

    // Idempotent completion: a crash between the accepted flip and
    // attempt completion replays here and converges without work.
    if (verified.row.state === "SUCCEEDED" && verified.row.acceptedPlanId !== null) {
      const accepted = readLatestPlan(context.handle, verified.row.id);
      log.info("preparation already complete", {
        workItemId: context.item.id,
        jobId: payload.jobId,
        preparationId: verified.row.id,
        planId: verified.row.acceptedPlanId,
      });
      const converged: HandlerOutcome = { result: "SUCCEEDED" };
      if (accepted?.planHash !== undefined) {
        converged.outputHash = accepted.planHash;
      }
      return converged;
    }

    if (!context.heartbeat()) {
      return failedPrepareOutcome("LEASE_LOST", null, clock());
    }

    if (deps.provider === null) {
      const detail = encodePreparationFailureDetail(
        buildPreparationFailure("CONFIGURATION", { stage: null, occurredAt: clock() }),
      );
      markPreparationFailed(context.handle, {
        preparationId: verified.row.id,
        failureJson: detail,
        now: clock(),
      });
      return { result: "BLOCKED", errorCode: "CONFIGURATION", errorDetail: detail };
    }
    const provider = deps.provider;

    if (!markPreparationRunning(context.handle, { preparationId: verified.row.id, now: clock() })) {
      // SUCCEEDED raced us after the converge check; converge now.
      return { result: "SUCCEEDED" };
    }

    // Cached recovery: the latest plan is committed but unaccepted
    // and belongs to this work item — skip the provider call.
    const latest = readLatestPlan(context.handle, verified.row.id);
    const latestWorkItemId =
      latest === null || latest.id === verified.row.acceptedPlanId
        ? null
        : readAttemptWorkItemId(context.handle, latest.attemptId);
    const cachedPlan =
      latest !== null &&
      latest.id !== verified.row.acceptedPlanId &&
      latestWorkItemId === context.item.id
        ? latest
        : null;
    const source = cachedPlan === null ? ("provider" as const) : ("cached" as const);

    if (verified.canonicalJdText.length > 200_000) {
      const detail = encodePreparationFailureDetail(
        buildPreparationFailure("INPUT_STALE", { stage: "LOADING_INPUTS", occurredAt: clock() }),
      );
      markPreparationFailed(context.handle, {
        preparationId: verified.row.id,
        failureJson: detail,
        now: clock(),
      });
      return { result: "BLOCKED", errorCode: "INPUT_STALE", errorDetail: detail };
    }

    const emitter = createPrepareProgressEmitter(context.handle, {
      preparationId: verified.row.id,
      workItemId: context.item.id,
      attemptId: workAttemptId,
      leaseToken: context.item.leaseToken,
      source,
      clock,
    });

    const failRow = (code: PreparationFailureCode, stage: PreparationStageType | null): string => {
      const detail = encodePreparationFailureDetail(
        buildPreparationFailure(code, { stage, occurredAt: clock() }),
      );
      markPreparationFailed(context.handle, {
        preparationId: verified.row.id,
        failureJson: detail,
        now: clock(),
      });
      return detail;
    };

    try {
      emitter.emitStage("LOADING_INPUTS");
      if (!context.heartbeat()) {
        return failedPrepareOutcome("LEASE_LOST", emitter.lastStage, clock());
      }

      if (cachedPlan !== null) {
        emitter.emitStage("WAITING_FOR_PROVIDER");
        emitter.emitStage("VALIDATING_PROPOSAL");
        emitter.emitStage("STORING_PLAN");
        markPreparationSucceeded(context.handle, {
          preparationId: verified.row.id,
          planId: cachedPlan.id,
          now: clock(),
        });
        emitter.emitStage("PUBLISHING_PLAN");
        log.info("preparation recovered from saved plan", {
          workItemId: context.item.id,
          preparationId: verified.row.id,
          planId: cachedPlan.id,
        });
        return { result: "SUCCEEDED", outputHash: cachedPlan.planHash };
      }

      const jdSnapshot = getOrCreateJdSnapshot(context.handle, {
        jobId: payload.jobId,
        extractionId: payload.extractionId,
        jdText: verified.canonicalJdText,
      });
      const candidateSnapshot = getOrCreateCandidateSnapshot(context.handle, {
        profileVersionId: payload.profileVersionId,
      });
      if (!jdSnapshot.ok || !candidateSnapshot.ok) {
        const detail = failRow("INPUT_STALE", emitter.lastStage);
        return { result: "BLOCKED", errorCode: "INPUT_STALE", errorDetail: detail };
      }

      const masterBullets = masterBulletsByRole(verified.payload);
      const preparationInput = PreparationInputV2.parse({
        schemaVersion: "preparation-input/v2",
        promptVersion: PREPARE_PROMPT_VERSION_V2,
        jobId: payload.jobId,
        jobTitle: getTailoringJob(context.handle, payload.jobId)?.title ?? "",
        company: getTailoringJob(context.handle, payload.jobId)?.company ?? "",
        extractionId: payload.extractionId,
        jdSnapshotId: jdSnapshot.snapshotId,
        jdText: verified.canonicalJdText,
        candidateSnapshotId: candidateSnapshot.snapshotId,
        profile: verified.payload,
        approvedFactIds: verified.approvedFacts.map((fact) => fact.factId),
        masterBullets: masterBullets.map((bullet) => ({
          roleId: bullet.roleId,
          factId: bullet.factId,
          text: bullet.text,
        })),
        budgets: {
          priorities: STEP2_BUDGETS.featuredPriorities,
          suggestions: STEP2_BUDGETS.suggestions,
          angles: STEP2_BUDGETS.angles,
        },
      });

      const createTimer = deps.createRenewalTimer ?? defaultRenewalTimer;
      let renewalLost = false;
      const timer = createTimer(
        renewalIntervalMs(context.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
        () => {
          try {
            if (!context.heartbeat()) {
              renewalLost = true;
            }
          } catch (error: unknown) {
            renewalLost = true;
            log.warn("preparation lease renewal tick failed", {
              workItemId: context.item.id,
              detail: (error as Error).message,
            });
          }
        },
      );
      let proposal: Awaited<ReturnType<PrepareProvider["preparePlan"]>>;
      try {
        emitter.emitStage("WAITING_FOR_PROVIDER");
        proposal = await provider.preparePlan(preparationInput);
      } finally {
        timer.stop();
      }
      if (renewalLost) {
        throw new LeaseLostError();
      }
      if (!context.heartbeat()) {
        throw new LeaseLostError();
      }

      emitter.emitStage("VALIDATING_PROPOSAL");
      const built = buildAcceptedPlanV2({
        planId: newId(),
        preparationId: verified.row.id,
        extractionId: payload.extractionId,
        jdHash: verified.jdHash,
        canonicalJdText: verified.canonicalJdText,
        profileVersionId: payload.profileVersionId,
        evidenceHash: verified.row.evidenceHash,
        masterProjectionHash: masterProjectionHashFor(verified.payload),
        payload: verified.payload,
        facts: verified.approvedFacts,
        proposal: proposal.proposal,
      });
      if (!built.ok) {
        log.error("preparation proposal rejected", {
          workItemId: context.item.id,
          error: built.error,
          detail: built.detail,
        });
        const detail = failRow("INVALID_RESPONSE", emitter.lastStage);
        return {
          result: "FAILED",
          errorCode: "INVALID_RESPONSE",
          errorDetail: detail,
          inputHash: proposal.lineage.inputHash,
        };
      }
      const plan = PreparationPlanV2.parse(built.plan);
      const planHash = correctionPlanHashFor(plan);

      emitter.emitStage("STORING_PLAN");
      const existing = readPlanByHash(context.handle, verified.row.id, planHash);
      const stored =
        existing ??
        insertPlan(context.handle, {
          id: plan.planId,
          preparationId: verified.row.id,
          planJson: canonicalJson(plan),
          planHash,
          providerId: provider.providerId,
          model: proposal.lineage.model,
          promptVersion: PREPARE_PROMPT_VERSION_V2,
          proposalSchemaVersion: "preparation-proposal/v2",
          claimsPolicyVersion: "step2-claims/2",
          inputHash: proposal.lineage.inputHash,
          proposalHash: proposal.lineage.proposalHash,
          attemptId: workAttemptId,
          validationJson: canonicalJson(built.validation),
          supersedesPlanId: verified.row.acceptedPlanId,
          now: clock(),
        });

      markPreparationSucceeded(context.handle, {
        preparationId: verified.row.id,
        planId: stored.id,
        now: clock(),
      });
      emitter.emitStage("PUBLISHING_PLAN");
      return {
        result: "SUCCEEDED",
        inputHash: proposal.lineage.inputHash,
        outputHash: stored.planHash,
      };
    } catch (error: unknown) {
      if (error instanceof LeaseLostError) {
        return failedPrepareOutcome("LEASE_LOST", emitter.lastStage, clock());
      }
      if (error instanceof ProviderError) {
        if (!context.heartbeat()) {
          return failedPrepareOutcome("LEASE_LOST", emitter.lastStage, clock());
        }
        const code = providerReasonToCode(error.reason);
        const detail = encodePreparationFailureDetail(
          buildPreparationFailure(code, {
            stage: emitter.lastStage,
            occurredAt: clock(),
            launchSubcode: launchSubcodeForSpawnCode(error.spawnCode),
          }),
        );
        markPreparationFailed(context.handle, {
          preparationId: verified.row.id,
          failureJson: detail,
          now: clock(),
        });
        return {
          result: "FAILED",
          errorCode: code,
          errorDetail: detail,
          ...(isExplicitOnlyFailureCode(code) ? { terminal: true as const } : {}),
        };
      }
      throw error;
    }
  };
}

export interface TerminalizePreparationInput {
  jobId: string;
  workItemId: string;
  attempts: number;
  now: string;
}

/**
 * Dispatch §9 recovery for exhausted PREPARE items: the dead worker
 * never ran a terminal move, so record FAILED with a versioned
 * LEASE_LOST failure on the preparation row. Writes nothing else —
 * never the job row, board status, or generation tables. A moved
 * row is a no-op, never an error.
 */
export function terminalizeExhaustedPreparation(
  handle: DatabaseHandle,
  input: TerminalizePreparationInput,
): { ok: true; terminalized: boolean } {
  return withTransaction(handle.sqlite, () => {
    const row = readPreparationByJob(handle, input.jobId);
    if (
      row === null ||
      row.workItemId !== input.workItemId ||
      (row.state !== "QUEUED" && row.state !== "RUNNING")
    ) {
      return { ok: true as const, terminalized: false };
    }
    markPreparationFailed(handle, {
      preparationId: row.id,
      failureJson: encodePreparationFailureDetail(
        buildPreparationFailure("LEASE_LOST", { stage: null, occurredAt: input.now }),
      ),
      now: input.now,
    });
    log.info("preparation exhausted without a plan", {
      jobId: input.jobId,
      preparationId: row.id,
      attempts: input.attempts,
    });
    return { ok: true as const, terminalized: true };
  });
}
