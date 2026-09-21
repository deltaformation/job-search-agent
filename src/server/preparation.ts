import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import {
  getActiveProfileVersion,
  getDefaultProfile,
  getProfile,
  getProfileVersion,
  listFactsByVersion,
} from "../db/candidates";
import { candidateSources } from "../db/schema/candidates";
import { readWorkspace } from "../db/tailoringWorkspace";
import { casJobRowVersion, getTailoringJob } from "../db/tailoring";
import { withTransaction } from "../db/transactions";
import { newId } from "../db/utils";
import { canonicalJson, canonicalText } from "../domain/canonical";
import {
  parseStoredProfilePayload,
  type StoredProfilePayload,
} from "../domain/candidate";
import { parseStoredExtraction } from "../domain/extraction";
import {
  IntakeBindingV1,
  PreparationPlanV1,
  PreparePayloadV1,
  Step2DraftV1,
  deriveStep2Segments,
  masterBulletsByRole,
  prepareIdempotencyKey,
  type BatchItemPreparationV1 as BatchItemPreparationV1Type,
  type IntakeBindingV1 as IntakeBindingV1Type,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type PreparationStatusV1 as PreparationStatusV1Type,
  type PrepareCommandV1 as PrepareCommandV1Type,
  type PrepareRetryBodyV1 as PrepareRetryBodyV1Type,
  type ValidateDraftBodyV1 as ValidateDraftBodyV1Type,
} from "../domain/step2";
import {
  Step2DraftV2,
  deriveCorrectionSegments,
  deriveEligibleRoles,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type ValidateDraftBodyV2 as ValidateDraftBodyV2Type,
} from "../domain/step2Correction";
import {
  isPreparationRetryableFailureCode,
  parsePreparationFailureDetail,
} from "../tailoring/failures";
import { sha256HexUtf8 } from "../tailoring/hash";
import {
  bindingHashFor,
  draftHashFor,
  evidenceHashFor,
  prepareOperationHashFor,
  validateStep2Segments,
} from "../tailoring/step2policy";
import {
  correctionDraftHashFor,
  validateCorrectionSegments,
} from "../tailoring/step2CorrectionPolicy";
import { requeueWorkItem } from "../queue/leases";
import { workItems } from "../db/schema/queue";
import { jobExtractions } from "../db/schema/jobs";
import { step2Preparations } from "../db/schema/step2";
import {
  insertDraftValidation,
  insertPreparation,
  linkPreparationExtraction,
  markPreparationQueued,
  parseStoredPlan,
  readLatestWorkAttempt,
  readPlan,
  readPreparationByIntakeItem,
  readPreparationByJob,
  readPreparationEvents,
  readPreparationWorkState,
  readWorkAttemptById,
  readWorkItemById,
  relinkPreparationExtraction,
  requeuePreparationRun,
} from "../db/step2";
import type { Step2Preparation } from "../db/schema/step2";
import { getOrCreateCandidateSnapshot, getOrCreateJdSnapshot } from "./candidates";
import { activeProviderId } from "./settings";
import { PROVIDER_KEY_ENV } from "../../scripts/ai-provider.mjs";

/**
 * Step 2 preparation services (WO-1.3-S2-B): intake binding capture,
 * extraction linkage with automatic scheduling, explicit schedule
 * (P) and attempt-specific retry (PR) transactions, status/plan/
 * validate reads, and the batch diagnostics join.
 *
 * Every function takes the trusted service clock (`now`) and, for
 * provider presence, the process env mapping. Transactions are
 * short and synchronous; hashes and strict parses happen outside
 * them. Reads never trigger AI calls: no provider handle exists in
 * this module at all.
 */

export type PreparationFailureReason =
  | "job-not-found"
  | "job-conflict"
  | "job-rejected"
  | "preparation-busy"
  | "idempotency-mismatch"
  | "profile-not-ready"
  | "profile-unknown"
  | "jd-not-ready"
  | "provider-not-ready"
  | "attempt-not-found"
  | "retry-not-allowed"
  | "plan-not-found"
  | "plan-stale"
  | "workspace-conflict"
  | "storage-unavailable";

export interface PreparationFailure {
  error: PreparationFailureReason;
  message: string;
  currentRowVersion?: number;
  currentWorkspaceRevision?: number;
  planId?: string;
}

function fail(
  error: PreparationFailureReason,
  message: string,
  extra: Partial<PreparationFailure> = {},
): { ok: false } & PreparationFailure {
  return { ok: false, error, message, ...extra };
}

/** Provider presence check (mirrors the E readiness rule). */
export function isProviderKeyConfigured(env: NodeJS.ProcessEnv): boolean {
  const provider = activeProviderId(env);
  const keyName = PROVIDER_KEY_ENV[provider] as string | undefined;
  if (keyName === undefined) {
    return false;
  }
  return (env[keyName] ?? "") !== "";
}

export interface BoundProfile {
  profileId: string;
  versionId: string;
  payload: StoredProfilePayload;
  payloadHash: string;
  approved: Array<{ factId: string; statement: string; employmentId: string | null }>;
  evidenceHash: string;
  masterSourceId: string | null;
}

function resolveBoundProfile(
  handle: DatabaseHandle,
  profileId: string,
  versionId: string,
): BoundProfile | null {
  const version = getProfileVersion(handle, versionId);
  if (version === null || version.profileId !== profileId) {
    return null;
  }
  let payload: StoredProfilePayload;
  try {
    payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
  } catch {
    return null;
  }
  const payloadHash = sha256HexUtf8(canonicalJson(payload));
  if (payloadHash !== version.payloadHash) {
    return null;
  }
  const employmentOf = new Map<string, string>();
  for (const achievement of payload.achievements) {
    if (achievement.employmentId !== undefined) {
      employmentOf.set(achievement.factId, achievement.employmentId);
    }
  }
  const approved = listFactsByVersion(handle, version.id)
    .filter((fact) => fact.verification === "APPROVED")
    .map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      employmentId: employmentOf.get(fact.factId) ?? null,
    }));
  if (approved.length === 0) {
    return null;
  }
  const source = handle.db
    .select({ id: candidateSources.id })
    .from(candidateSources)
    .where(eq(candidateSources.profileVersionId, version.id))
    .limit(1)
    .get();
  return {
    profileId,
    versionId: version.id,
    payload,
    payloadHash,
    approved,
    evidenceHash: evidenceHashFor({ profileVersionId: version.id, payloadHash, approved }),
    masterSourceId: source?.id ?? null,
  };
}

function buildBinding(input: {
  intakeItemId: string | null;
  batchId: string | null;
  bound: BoundProfile;
  now: string;
}): IntakeBindingV1Type {
  return IntakeBindingV1.parse({
    schemaVersion: "step2-intake-binding/v1",
    intakeItemId: input.intakeItemId,
    profileId: input.bound.profileId,
    profileVersionId: input.bound.versionId,
    profilePayloadHash: input.bound.payloadHash,
    evidenceHash: input.bound.evidenceHash,
    masterSourceId: input.bound.masterSourceId,
    capturedAt: input.now,
    batchId: input.batchId,
  });
}

/**
 * Capture the globally selected profile version, evidence, and
 * master at intake acceptance (S2-A §8.1). Runs inside the
 * caller's persist transaction. Missing default profile, missing
 * active version, unparseable payload, or zero approved facts
 * captures nothing — the scrape proceeds and preparation waits
 * for the explicit recovery command. Never throws for absent
 * configuration; storage faults propagate.
 */
export function captureIntakeBinding(
  handle: DatabaseHandle,
  input: { intakeItemId: string; batchId: string; now: string },
): { captured: boolean; preparationId: string | null } {
  if (readPreparationByIntakeItem(handle, input.intakeItemId) !== null) {
    return { captured: false, preparationId: null };
  }
  const profile = getDefaultProfile(handle);
  if (profile === null) {
    return { captured: false, preparationId: null };
  }
  const version = getActiveProfileVersion(handle, profile.id);
  if (version === null) {
    return { captured: false, preparationId: null };
  }
  const bound = resolveBoundProfile(handle, profile.id, version.id);
  if (bound === null) {
    return { captured: false, preparationId: null };
  }
  const binding = buildBinding({
    intakeItemId: input.intakeItemId,
    batchId: input.batchId,
    bound,
    now: input.now,
  });
  const row = insertPreparation(handle, {
    intakeItemId: input.intakeItemId,
    jobId: null,
    batchId: input.batchId,
    profileId: bound.profileId,
    profileVersionId: bound.versionId,
    profilePayloadHash: bound.payloadHash,
    evidenceHash: bound.evidenceHash,
    masterSourceId: bound.masterSourceId,
    bindingJson: canonicalJson(binding),
    now: input.now,
  });
  return { captured: true, preparationId: row.id };
}

export type LinkScheduleReason =
  | "scheduled"
  | "no-binding"
  | "already-linked"
  | "tailor-live"
  | "no-provider";

/**
 * Link the bound preparation row to its job/extraction and schedule
 * the PREPARE item (S2-A §8.2). Runs inside the extraction-persist
 * transaction on success only. Re-scrapes, live TAILOR runs, and
 * missing provider keys leave the row PENDING for the explicit
 * command — never retargeting, never competing, never failing the
 * clip. Writes only the preparation row and the new work item.
 */
export function linkAndSchedulePreparation(
  handle: DatabaseHandle,
  input: {
    jobId: string;
    extractionId: string;
    intakeItemId: string;
    providerKeyPresent: boolean;
    now: string;
  },
): { scheduled: boolean; reason: LinkScheduleReason; preparationId: string | null } {
  const row = readPreparationByIntakeItem(handle, input.intakeItemId);
  if (row === null) {
    return { scheduled: false, reason: "no-binding", preparationId: null };
  }
  const linked = linkPreparationExtraction(handle, {
    preparationId: row.id,
    jobId: input.jobId,
    extractionId: input.extractionId,
    now: input.now,
  });
  if (!linked.ok) {
    return { scheduled: false, reason: "already-linked", preparationId: row.id };
  }
  const tailorLive =
    handle.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.jobId, input.jobId),
          eq(workItems.kind, "TAILOR"),
          inArray(workItems.state, ["QUEUED", "RUNNING"]),
        ),
      )
      .limit(1)
      .get() !== undefined;
  if (tailorLive) {
    return { scheduled: false, reason: "tailor-live", preparationId: row.id };
  }
  if (!input.providerKeyPresent) {
    return { scheduled: false, reason: "no-provider", preparationId: row.id };
  }
  const workItemId = newId();
  handle.db
    .insert(workItems)
    .values({
      id: workItemId,
      kind: "PREPARE",
      idempotencyKey: prepareIdempotencyKey(input.jobId, row.id, input.extractionId),
      jobId: input.jobId,
      intakeItemId: input.intakeItemId,
      payloadJson: canonicalJson(
        PreparePayloadV1.parse({
          schemaVersion: "prepare-queue/v1",
          preparationId: row.id,
          jobId: input.jobId,
          extractionId: input.extractionId,
          profileVersionId: row.profileVersionId,
          bindingHash: bindingHashOf(row.bindingJson),
        }),
      ),
      maxAttempts: 3,
    })
    .run();
  markPreparationQueued(handle, {
    preparationId: row.id,
    workItemId,
    lastOperationId: null,
    lastOperationHash: null,
    now: input.now,
  });
  return { scheduled: true, reason: "scheduled", preparationId: row.id };
}

function bindingHashOf(bindingJson: string): string {
  return bindingHashFor(IntakeBindingV1.parse(JSON.parse(bindingJson) as unknown));
}

interface ActiveExtraction {
  extractionId: string;
  canonicalJdText: string;
}

function resolveActiveExtraction(
  handle: DatabaseHandle,
  jobId: string,
): ActiveExtraction | null {
  const job = getTailoringJob(handle, jobId);
  if (job === null || job.activeExtractionId === null) {
    return null;
  }
  const extraction = handle.db
    .select()
    .from(jobExtractions)
    .where(eq(jobExtractions.id, job.activeExtractionId))
    .get();
  if (extraction === undefined) {
    return null;
  }
  let envelope: ReturnType<typeof parseStoredExtraction>;
  try {
    envelope = parseStoredExtraction(JSON.parse(extraction.extractedJson) as unknown);
  } catch {
    return null;
  }
  const canonicalJdText = canonicalText(envelope.fields.descriptionText ?? "");
  if (canonicalJdText === "") {
    return null;
  }
  return { extractionId: job.activeExtractionId, canonicalJdText };
}

/** Re-verify a captured binding against live rows (profile side). */
/**
 * Recompute the captured profile payload/evidence digests and
 * compare against the frozen expectations (S2-A §8.6 re-read
 * hook). S2-D generation, retry, and worker-attach paths share
 * this instead of active-pointer checks: later Settings edits
 * never invalidate captured work, while payload/evidence drift
 * fails closed.
 */
export function verifyCapturedEvidence(
  handle: DatabaseHandle,
  input: {
    profileId: string;
    profileVersionId: string;
    profilePayloadHash: string;
    evidenceHash: string;
  },
): { ok: true; bound: BoundProfile } | { ok: false } {
  const bound = resolveBoundProfile(handle, input.profileId, input.profileVersionId);
  if (bound === null) {
    return { ok: false };
  }
  if (
    bound.payloadHash !== input.profilePayloadHash ||
    bound.evidenceHash !== input.evidenceHash
  ) {
    return { ok: false };
  }
  return { ok: true, bound };
}

function verifyCapturedBinding(
  handle: DatabaseHandle,
  row: Step2Preparation,
): { ok: true; bound: BoundProfile } | { ok: false } {
  return verifyCapturedEvidence(handle, {
    profileId: row.profileId,
    profileVersionId: row.profileVersionId,
    profilePayloadHash: row.profilePayloadHash,
    evidenceHash: row.evidenceHash,
  });
}

export interface SchedulePreparationResult {
  preparationId: string;
  state: "QUEUED" | "SUCCEEDED";
  replayed: boolean;
  /** The bound profile shown to the user (§8.4 explicit recovery). */
  profileId: string;
  profileVersionId: string;
}

/**
 * Transaction P — explicit preparation schedule (S2-A §4.1).
 * Idempotency replays precede every check; every refusal rolls
 * back all writes. Supersession relinks the extraction on the same
 * row and keeps the old accepted plan until the new one publishes.
 * A same-extraction cycle on completed work converges (200,
 * `SUCCEEDED`, zero writes); a same-extraction cycle after a
 * terminal failure reuses the work item (numbering continues on
 * the same item, §6.3) instead of colliding on the unique key.
 * Bumps the job version without touching board/tailoring state.
 */
export function schedulePreparation(
  handle: DatabaseHandle,
  input: { jobId: string; body: PrepareCommandV1Type; env: NodeJS.ProcessEnv; now: string },
): { ok: true; value: SchedulePreparationResult } | ({ ok: false } & PreparationFailure) {
  const operationHash = prepareOperationHashFor({
    jobId: input.jobId,
    operationId: input.body.operationId,
    observedRowVersion: input.body.observedRowVersion,
    profileId: input.body.profileId,
  });
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail("job-not-found", `job '${input.jobId}' does not exist`);
    }
    let row = readPreparationByJob(handle, input.jobId);

    if (row !== null && row.lastOperationId === input.body.operationId) {
      if (row.lastOperationHash === operationHash) {
        return {
          ok: true,
          value: {
            preparationId: row.id,
            state: "QUEUED",
            replayed: true,
            profileId: row.profileId,
            profileVersionId: row.profileVersionId,
          },
        };
      }
      return fail(
        "idempotency-mismatch",
        "operation id was already used with different bytes",
        { currentRowVersion: job.rowVersion },
      );
    }
    if (job.rowVersion !== input.body.observedRowVersion) {
      return fail("job-conflict", "job changed under this command", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (row !== null && (row.state === "QUEUED" || row.state === "RUNNING")) {
      return fail("preparation-busy", "preparation is already running for this job", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (job.status === "REJECTED") {
      return fail("job-rejected", "rejected jobs cannot prepare; restore the job first", {
        currentRowVersion: job.rowVersion,
      });
    }
    // Completed-work converge: the preparation already succeeded
    // for the active extraction, so this operation schedules
    // nothing and converges with zero writes — duplicates are
    // safe whether or not they repeat the operation id.
    if (row !== null && row.state === "SUCCEEDED") {
      const current = resolveActiveExtraction(handle, input.jobId);
      if (current !== null && row.extractionId === current.extractionId) {
        return {
          ok: true,
          value: {
            preparationId: row.id,
            state: "SUCCEEDED",
            replayed: true,
            profileId: row.profileId,
            profileVersionId: row.profileVersionId,
          },
        };
      }
    }

    // Effective binding: captured row, or the named profile's ACTIVE
    // version resolved at this instant for legacy/missing-profile
    // recovery. The body names the profile — the server never
    // adopts the current default implicitly.
    let bound: BoundProfile;
    if (row !== null) {
      let binding: IntakeBindingV1Type;
      try {
        binding = IntakeBindingV1.parse(JSON.parse(row.bindingJson) as unknown);
      } catch {
        return fail("storage-unavailable", "preparation binding is unreadable", {
          currentRowVersion: job.rowVersion,
        });
      }
      void binding;
      const verified = verifyCapturedBinding(handle, row);
      if (!verified.ok) {
        return fail(
          "profile-not-ready",
          "captured profile evidence no longer verifies; bind a current profile explicitly",
          { currentRowVersion: job.rowVersion },
        );
      }
      bound = verified.bound;
    } else {
      if (input.body.profileId === null) {
        return fail("profile-not-ready", "no captured binding; name a profile to prepare", {
          currentRowVersion: job.rowVersion,
        });
      }
      const profile = getProfile(handle, input.body.profileId);
      if (profile === null) {
        return fail("profile-unknown", `profile '${input.body.profileId}' does not exist`, {
          currentRowVersion: job.rowVersion,
        });
      }
      const version = getActiveProfileVersion(handle, profile.id);
      if (version === null) {
        return fail("profile-not-ready", `profile '${profile.id}' has no active version`, {
          currentRowVersion: job.rowVersion,
        });
      }
      const resolved = resolveBoundProfile(handle, profile.id, version.id);
      if (resolved === null) {
        return fail("profile-not-ready", `profile '${profile.id}' has no usable approved evidence`, {
          currentRowVersion: job.rowVersion,
        });
      }
      bound = resolved;
    }

    const active = resolveActiveExtraction(handle, input.jobId);
    if (active === null) {
      return fail("jd-not-ready", "job has no retained job description", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (!isProviderKeyConfigured(input.env)) {
      return fail("provider-not-ready", "no provider key is configured", {
        currentRowVersion: job.rowVersion,
      });
    }

    // Supersession / first link: relink whenever the row's
    // extraction disagrees with the active one. The accepted plan
    // (when any) is retained until the new plan publishes.
    if (row !== null && row.extractionId !== active.extractionId) {
      relinkPreparationExtraction(handle, {
        preparationId: row.id,
        extractionId: active.extractionId,
        now: input.now,
      });
    }

    if (row === null) {
      const binding = buildBinding({
        intakeItemId: null,
        batchId: null,
        bound,
        now: input.now,
      });
      row = insertPreparation(handle, {
        intakeItemId: null,
        jobId: input.jobId,
        batchId: null,
        profileId: bound.profileId,
        profileVersionId: bound.versionId,
        profilePayloadHash: bound.payloadHash,
        evidenceHash: bound.evidenceHash,
        masterSourceId: bound.masterSourceId,
        bindingJson: canonicalJson(binding),
        now: input.now,
      });
      relinkPreparationExtraction(handle, {
        preparationId: row.id,
        extractionId: active.extractionId,
        now: input.now,
      });
    }

    const jdSnapshot = getOrCreateJdSnapshot(handle, {
      jobId: input.jobId,
      extractionId: active.extractionId,
      jdText: active.canonicalJdText,
    });
    if (!jdSnapshot.ok) {
      return fail("jd-not-ready", "job has no retained job description", {
        currentRowVersion: job.rowVersion,
      });
    }
    const candidateSnapshot = getOrCreateCandidateSnapshot(handle, {
      profileVersionId: bound.versionId,
    });
    if (!candidateSnapshot.ok) {
      return candidateSnapshot.error === "snapshot-corrupt"
        ? fail("storage-unavailable", "candidate snapshot is unreadable", {
            currentRowVersion: job.rowVersion,
          })
        : fail("profile-not-ready", "captured profile version is gone", {
            currentRowVersion: job.rowVersion,
          });
    }

    const idempotencyKey = prepareIdempotencyKey(input.jobId, row.id, active.extractionId);
    const sameCycleItem =
      row.workItemId === null ? null : readWorkItemById(handle, row.workItemId);
    let workItemId: string;
    if (
      sameCycleItem !== null &&
      sameCycleItem.kind === "PREPARE" &&
      sameCycleItem.idempotencyKey === idempotencyKey
    ) {
      // Same-extraction cycle after a terminal run. Inserting would
      // collide on the unique key, so reuse the item instead (§6.3:
      // numbering continues on the same work item). Success
      // converged above; anything but a FAILED/FAILED pair is a
      // live run (or skew) and refuses as busy.
      if (row.state !== "FAILED" || sameCycleItem.state !== "FAILED") {
        return fail("preparation-busy", "preparation is already running for this job", {
          currentRowVersion: job.rowVersion,
        });
      }
      const requeued = requeueWorkItem(handle, {
        workItemId: sameCycleItem.id,
        now: input.now,
      });
      if (!requeued.ok) {
        return fail("preparation-busy", "preparation is already running for this job", {
          currentRowVersion: job.rowVersion,
        });
      }
      workItemId = sameCycleItem.id;
    } else {
      workItemId = newId();
      const payload = PreparePayloadV1.parse({
        schemaVersion: "prepare-queue/v1",
        preparationId: row.id,
        jobId: input.jobId,
        extractionId: active.extractionId,
        profileVersionId: bound.versionId,
        bindingHash: bindingHashOf(row.bindingJson),
      });
      handle.db
        .insert(workItems)
        .values({
          id: workItemId,
          kind: "PREPARE",
          idempotencyKey,
          jobId: input.jobId,
          intakeItemId: row.intakeItemId,
          payloadJson: canonicalJson(payload),
          maxAttempts: 3,
        })
        .run();
    }
    const queued = markPreparationQueued(handle, {
      preparationId: row.id,
      workItemId,
      lastOperationId: input.body.operationId,
      lastOperationHash: operationHash,
      now: input.now,
    });
    if (!queued.ok) {
      return fail("preparation-busy", "preparation is already running for this job", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (!casJobRowVersion(handle, { jobId: input.jobId, rowVersion: input.body.observedRowVersion, now: input.now })) {
      return fail("job-conflict", "job changed under this command", {
        currentRowVersion: getTailoringJob(handle, input.jobId)?.rowVersion ?? input.body.observedRowVersion,
      });
    }
    return {
      ok: true,
      value: {
        preparationId: row.id,
        state: "QUEUED",
        replayed: false,
        profileId: bound.profileId,
        profileVersionId: bound.versionId,
      },
    };
  });
}

export interface RetryPreparationResult {
  preparationId: string;
  state: "QUEUED";
  replayed: boolean;
}

/**
 * Transaction PR — attempt-specific preparation retry (S2-A §4.2,
 * mirroring R). Replay precedes every check: a live run or a
 * superseded observed attempt returns 200 with zero writes. Only
 * the latest terminal retryable failure requeues, through the
 * existing requeue primitive (budget extends, numbering kept).
 */
export function retryPreparation(
  handle: DatabaseHandle,
  input: { jobId: string; body: PrepareRetryBodyV1Type; now: string },
): { ok: true; value: RetryPreparationResult } | ({ ok: false } & PreparationFailure) {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail("job-not-found", `job '${input.jobId}' does not exist`);
    }
    const row = readPreparationByJob(handle, input.jobId);
    if (row === null || row.workItemId === null) {
      return fail("retry-not-allowed", "job has no preparation to retry", {
        currentRowVersion: job.rowVersion,
      });
    }
    const item = readWorkItemById(handle, row.workItemId);
    if (item === null || item.kind !== "PREPARE") {
      return fail("retry-not-allowed", "job has no preparation to retry", {
        currentRowVersion: job.rowVersion,
      });
    }
    const observed = readWorkAttemptById(handle, input.body.observedAttemptId);
    if (observed === null || observed.workItemId !== item.id) {
      return fail("attempt-not-found", "named attempt does not belong to this preparation", {
        currentRowVersion: job.rowVersion,
      });
    }
    // Replay precedes every check: a live run, or an observed
    // attempt that is no longer latest, converges with zero writes.
    if (item.state === "QUEUED" || item.state === "RUNNING") {
      return { ok: true, value: { preparationId: row.id, state: "QUEUED", replayed: true } };
    }
    const latest = readLatestWorkAttempt(handle, item.id);
    if (latest === null || latest.id !== observed.id) {
      return { ok: true, value: { preparationId: row.id, state: "QUEUED", replayed: true } };
    }
    if (job.rowVersion !== input.body.observedRowVersion) {
      return fail("job-conflict", "job changed under this command", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (row.state === "QUEUED" || row.state === "RUNNING") {
      return fail("preparation-busy", "preparation is already running for this job", {
        currentRowVersion: job.rowVersion,
      });
    }
    // Mirroring R: BLOCKED attempts (missing provider, awaiting
    // human repair) requeue like FAILED ones once the retryable-code
    // gate below passes. A terminal item whose latest attempt is
    // still live is corrupt — fail closed, never requeue.
    if (observed.result !== "FAILED" && observed.result !== "BLOCKED") {
      return fail(
        "storage-unavailable",
        "work item is terminal with a live latest attempt; inspect the rows, do not trust them",
        { currentRowVersion: job.rowVersion },
      );
    }
    const failure = parsePreparationFailureDetail(observed.errorDetail);
    const code = failure?.code ?? observed.errorCode;
    if (
      code === null ||
      !isPreparationRetryableFailureCode(code as Parameters<typeof isPreparationRetryableFailureCode>[0])
    ) {
      return fail("retry-not-allowed", "latest attempt is not in a retryable failed state", {
        currentRowVersion: job.rowVersion,
      });
    }
    // The retry reuses the captured binding and extraction: drift
    // needs the explicit schedule command (which relinks), not a
    // replay of the old attempt.
    if (verifyCapturedBinding(handle, row).ok !== true) {
      return fail("profile-not-ready", "captured profile evidence no longer verifies", {
        currentRowVersion: job.rowVersion,
      });
    }
    const active = resolveActiveExtraction(handle, input.jobId);
    if (active === null || row.extractionId !== active.extractionId) {
      return fail("jd-not-ready", "job description changed; schedule a new preparation cycle", {
        currentRowVersion: job.rowVersion,
      });
    }
    const requeued = requeueWorkItem(handle, { workItemId: item.id, now: input.now });
    if (!requeued.ok) {
      return fail("retry-not-allowed", "work item is no longer requeueable", {
        currentRowVersion: job.rowVersion,
      });
    }
    const moved = requeuePreparationRun(handle, { preparationId: row.id, now: input.now });
    if (!moved.ok) {
      return fail("preparation-busy", "preparation is already running for this job", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (!casJobRowVersion(handle, { jobId: input.jobId, rowVersion: input.body.observedRowVersion, now: input.now })) {
      return fail("job-conflict", "job changed under this command", {
        currentRowVersion: getTailoringJob(handle, input.jobId)?.rowVersion ?? input.body.observedRowVersion,
      });
    }
    return { ok: true, value: { preparationId: row.id, state: "QUEUED", replayed: false } };
  });
}

/**
 * Preparation status read (S2-A §1.7): row + work/attempt + events
 * + accepted pointer in four statements. Failure prefers the
 * row's versioned record, then the latest attempt's envelope.
 * Retry is allowed exactly when the row is FAILED with a retryable
 * code and nothing is live. Never triggers AI calls.
 */
export function readPreparationStatus(
  handle: DatabaseHandle,
  jobId: string,
  now: string,
): PreparationStatusV1Type | null {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return null;
  }
  const row = readPreparationByJob(handle, jobId);
  if (row === null) {
    return {
      schemaVersion: "step2-preparation-status/v1",
      preparationId: null,
      jobId,
      state: "ABSENT",
      binding: null,
      extractionId: null,
      acceptedPlanId: null,
      acceptedPlanHash: null,
      attemptId: null,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      events: [],
      failure: null,
      retryAllowed: false,
      serverNow: now,
    };
  }
  let binding: IntakeBindingV1Type | null = null;
  try {
    binding = IntakeBindingV1.parse(JSON.parse(row.bindingJson) as unknown);
  } catch {
    binding = null;
  }
  const work = row.workItemId === null ? null : readPreparationWorkState(handle, row.workItemId);
  const events =
    work?.attemptId === null || work?.attemptId === undefined
      ? []
      : readPreparationEvents(handle, work.attemptId).map((event) => ({
          seq: event.seq,
          stage: event.stage as PreparationStatusV1Type["events"][number]["stage"],
          source: event.source as "provider" | "cached",
          recordedAt: event.recordedAt,
        }));
  let acceptedPlanHash: string | null = null;
  if (row.acceptedPlanId !== null) {
    acceptedPlanHash = readPlan(handle, row.acceptedPlanId)?.planHash ?? null;
  }
  const rowFailure =
    row.failureJson === null ? null : parsePreparationFailureDetail(row.failureJson);
  const attemptFailure =
    work?.errorDetail === null || work?.errorDetail === undefined
      ? null
      : parsePreparationFailureDetail(work.errorDetail);
  const failure = rowFailure ?? attemptFailure;
  const live = row.state === "QUEUED" || row.state === "RUNNING";
  const retryAllowed =
    row.state === "FAILED" &&
    !live &&
    failure !== null &&
    isPreparationRetryableFailureCode(failure.code);
  return {
    schemaVersion: "step2-preparation-status/v1",
    preparationId: row.id,
    jobId,
    state: row.state as "PENDING" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED",
    binding,
    extractionId: row.extractionId,
    acceptedPlanId: row.acceptedPlanId,
    acceptedPlanHash,
    attemptId: work?.attemptId ?? null,
    startedAt: work?.startedAt ?? null,
    finishedAt: work?.finishedAt ?? null,
    leaseExpiresAt: work?.leaseExpiresAt ?? null,
    lastHeartbeatAt: work?.updatedAt ?? null,
    events,
    failure,
    retryAllowed,
    serverNow: now,
  };
}

export type ReadPlanResult =
  | {
      version: 1;
      plan: PreparationPlanV1Type;
      planHash: string;
      validatedAt: string;
      supersedesPlanId: string | null;
    }
  | {
      version: 2;
      plan: PreparationPlanV2Type;
      eligibleRoles: Array<{ suggestionId: string; eligibleRoleIds: string[] }>;
      planHash: string;
      validatedAt: string;
      supersedesPlanId: string | null;
    };

/**
 * Accepted (or explicitly named, owned) plan read. A plan whose
 * extraction is no longer active reports PLAN_STALE with the plan
 * id for diagnostics; reads never heal or rebind. V2 plans carry
 * server-derived eligible roles recomputed on every read from the
 * plan's anchors and the captured payload — providers never
 * supply these sets and the plan row never stores them.
 */
export function readPlanForJob(
  handle: DatabaseHandle,
  jobId: string,
  planId: string | null,
): { ok: true; value: ReadPlanResult } | ({ ok: false } & PreparationFailure) {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return fail("job-not-found", `job '${jobId}' does not exist`);
  }
  const row = readPreparationByJob(handle, jobId);
  if (row === null) {
    return fail("plan-not-found", "job has no preparation plan");
  }
  const resolvedId = planId ?? row.acceptedPlanId;
  if (resolvedId === null) {
    return fail("plan-not-found", "job has no accepted plan yet");
  }
  const plan = readPlan(handle, resolvedId);
  if (plan === null || plan.preparationId !== row.id) {
    return fail("plan-not-found", "named plan does not belong to this job");
  }
  const parsed = parseStoredPlan(plan.planJson);
  if (parsed === null) {
    return fail("storage-unavailable", "stored plan is unreadable");
  }
  if (parsed.plan.extractionId !== job.activeExtractionId) {
    return fail("plan-stale", "accepted plan predates the active job description", {
      planId: plan.id,
    });
  }
  if (parsed.version === 1) {
    return {
      ok: true,
      value: {
        version: 1,
        plan: parsed.plan,
        planHash: plan.planHash,
        validatedAt: plan.createdAt,
        supersedesPlanId: plan.supersedesPlanId,
      },
    };
  }
  const version = getProfileVersion(handle, row.profileVersionId);
  if (version === null) {
    return fail("storage-unavailable", "captured profile version is gone");
  }
  let payload: StoredProfilePayload;
  try {
    payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
  } catch {
    return fail("storage-unavailable", "captured profile payload is unreadable");
  }
  const employmentByFactId = new Map<string, string | null>();
  for (const achievement of payload.achievements) {
    employmentByFactId.set(achievement.factId, achievement.employmentId ?? null);
  }
  const employmentIds = payload.employment.map((entry) => entry.id);
  const eligibleRoles = parsed.plan.suggestions.map((suggestion) => ({
    suggestionId: suggestion.suggestionId,
    eligibleRoleIds: deriveEligibleRoles({
      citedFactIds: suggestion.factIds,
      employmentByFactId,
      employmentIds,
    }).eligibleRoleIds,
  }));
  return {
    ok: true,
    value: {
      version: 2,
      plan: parsed.plan,
      eligibleRoles,
      planHash: plan.planHash,
      validatedAt: plan.createdAt,
      supersedesPlanId: plan.supersedesPlanId,
    },
  };
}

export interface ValidateDraftResult {
  validationId: string;
  validation: ReturnType<typeof validateStep2Segments>;
}

/**
 * Validate exact edited text against the accepted plan (S2-A §4,
 * §7.5 derivation). Advisory: needs-evidence is data, not an
 * error — the verdict row persists either way. Re-verifies the
 * captured binding, JD freshness, and workspace revision before
 * computing anything. Never triggers AI calls.
 */
export function validateDraft(
  handle: DatabaseHandle,
  input: { jobId: string; body: ValidateDraftBodyV1Type; now: string },
): { ok: true; value: ValidateDraftResult } | ({ ok: false } & PreparationFailure) {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail("job-not-found", `job '${input.jobId}' does not exist`);
    }
    const row = readPreparationByJob(handle, input.jobId);
    if (row === null || row.acceptedPlanId === null) {
      return fail("plan-not-found", "job has no accepted plan yet");
    }
    const stored = readPlan(handle, row.acceptedPlanId);
    if (stored === null) {
      return fail("storage-unavailable", "accepted plan is unreadable");
    }
    let plan: PreparationPlanV1Type;
    try {
      plan = PreparationPlanV1.parse(JSON.parse(stored.planJson) as unknown);
    } catch {
      return fail("storage-unavailable", "accepted plan is unreadable");
    }
    if (plan.extractionId !== job.activeExtractionId) {
      return fail("plan-stale", "accepted plan predates the active job description", {
        planId: stored.id,
      });
    }
    const workspace = readWorkspace(handle, input.jobId);
    if (workspace === null || workspace.revision !== input.body.workspaceRevision) {
      return fail("workspace-conflict", "workspace revision moved under this validation", {
        currentWorkspaceRevision: workspace?.revision,
      });
    }
    if (verifyCapturedBinding(handle, row).ok !== true) {
      return fail("profile-not-ready", "captured profile evidence no longer verifies");
    }
    const active = resolveActiveExtraction(handle, input.jobId);
    if (active === null) {
      return fail("jd-not-ready", "job has no retained job description");
    }

    const version = getProfileVersion(handle, row.profileVersionId);
    if (version === null) {
      return fail("profile-not-ready", "captured profile version is gone");
    }
    let payload: StoredProfilePayload;
    try {
      payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
    } catch {
      return fail("storage-unavailable", "captured profile payload is unreadable");
    }
    const master = masterBulletsByRole(payload);
    // Shared §7.5 derivation (S2-D): the endpoint and the
    // generation gate derive identical segments from identical
    // bytes, so advisory verdicts and blocking verdicts agree.
    const segments = deriveStep2Segments({
      plan,
      master,
      summaryText: input.body.summaryText,
      operations: input.body.operations,
    });
    const employmentOf = new Map<string, string>();
    const metricsByFact = new Map<string, string[]>();
    for (const achievement of payload.achievements) {
      if (achievement.employmentId !== undefined) {
        employmentOf.set(achievement.factId, achievement.employmentId);
      }
      metricsByFact.set(achievement.factId, [...achievement.metrics]);
    }
    const snapshotFacts = listFactsByVersion(handle, version.id).map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      verification: fact.verification,
      profileVersionId: version.id,
      employmentId: employmentOf.get(fact.factId) ?? null,
      metrics: metricsByFact.get(fact.factId) ?? [],
    }));
    const planTexts = [
      ...plan.suggestions.map((suggestion) => ({ textId: suggestion.suggestionId, text: suggestion.text })),
      ...plan.positioning.angles.map((angle) => ({ textId: angle.angleId, text: angle.summaryText })),
      ...(plan.positioning.keepMasterSummary === ""
        ? []
        : [{ textId: "keep-master", text: plan.positioning.keepMasterSummary }]),
    ];
    const summarySource =
      input.body.summaryText === plan.positioning.keepMasterSummary
        ? ("master" as const)
        : plan.positioning.angles.some((angle) => angle.summaryText === input.body.summaryText)
          ? ((plan.positioning.angles.find((angle) => angle.summaryText === input.body.summaryText)
              ?.angleId ?? "angle-1") as "angle-1" | "angle-2")
          : ("edited" as const);
    const draft = Step2DraftV1.parse({
      schemaVersion: "step2-draft/v1",
      planId: plan.planId,
      planHash: stored.planHash,
      summaryText: input.body.summaryText,
      summarySource,
      operations: input.body.operations,
    });
    const draftHash = draftHashFor(draft);
    const validation = validateStep2Segments({
      segments,
      planId: plan.planId,
      planHash: stored.planHash,
      draftHash,
      boundProfileVersionId: row.profileVersionId,
      snapshotFacts,
      planTexts,
      master,
      employments: payload.employment.map((entry) => ({ id: entry.id, company: entry.company })),
      versionCreatedAt: version.createdAt,
      planAcceptedAt: stored.createdAt,
      now: input.now,
      validatedAt: input.now,
      summaryText: input.body.summaryText,
      operations: input.body.operations,
    });
    const saved = insertDraftValidation(handle, {
      jobId: input.jobId,
      planId: stored.id,
      workspaceRevision: input.body.workspaceRevision,
      draftHash,
      verdictJson: canonicalJson(validation),
      policyVersion: "step2-claims/1",
      now: input.now,
    });
    return { ok: true, value: { validationId: saved.id, validation } };
  });
}

export interface ValidateDraftV2Result {
  validationId: string;
  validation: ReturnType<typeof validateCorrectionSegments>;
}

/**
 * Validate exact v2 edited text against the accepted v2 plan
 * (correction contracts §4.3, §7). Advisory: provenance and
 * structural outcomes are data, not HTTP errors — the verdict row
 * persists either way under `step2-claims/2`. Re-verifies the
 * captured binding, JD freshness, and workspace revision before
 * computing anything. Never triggers AI calls. A v1 accepted plan
 * reports plan-stale: v2 validation needs a v2 cycle.
 */
export function validateDraftV2(
  handle: DatabaseHandle,
  input: { jobId: string; body: ValidateDraftBodyV2Type; now: string },
): { ok: true; value: ValidateDraftV2Result } | ({ ok: false } & PreparationFailure) {
  return withTransaction(handle.sqlite, () => {
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail("job-not-found", `job '${input.jobId}' does not exist`);
    }
    const row = readPreparationByJob(handle, input.jobId);
    if (row === null || row.acceptedPlanId === null) {
      return fail("plan-not-found", "job has no accepted plan yet");
    }
    const stored = readPlan(handle, row.acceptedPlanId);
    if (stored === null) {
      return fail("storage-unavailable", "accepted plan is unreadable");
    }
    const parsed = parseStoredPlan(stored.planJson);
    if (parsed === null) {
      return fail("storage-unavailable", "accepted plan is unreadable");
    }
    if (parsed.version !== 2) {
      return fail("plan-stale", "accepted plan predates correction validation; run preparation first");
    }
    const plan = parsed.plan;
    if (plan.extractionId !== job.activeExtractionId) {
      return fail("plan-stale", "accepted plan predates the active job description", {
        planId: stored.id,
      });
    }
    const workspace = readWorkspace(handle, input.jobId);
    if (workspace === null || workspace.revision !== input.body.workspaceRevision) {
      return fail("workspace-conflict", "workspace revision moved under this validation", {
        currentWorkspaceRevision: workspace?.revision,
      });
    }
    if (verifyCapturedBinding(handle, row).ok !== true) {
      return fail("profile-not-ready", "captured profile evidence no longer verifies");
    }
    const active = resolveActiveExtraction(handle, input.jobId);
    if (active === null) {
      return fail("jd-not-ready", "job has no retained job description");
    }

    const version = getProfileVersion(handle, row.profileVersionId);
    if (version === null) {
      return fail("profile-not-ready", "captured profile version is gone");
    }
    let payload: StoredProfilePayload;
    try {
      payload = parseStoredProfilePayload(JSON.parse(version.payloadJson) as unknown);
    } catch {
      return fail("storage-unavailable", "captured profile payload is unreadable");
    }
    const master = masterBulletsByRole(payload);
    // Shared §7.4 derivation: the endpoint, the generation gate,
    // and the worker derive identical segments from identical
    // bytes, so advisory verdicts, the gate, and execution agree.
    const segments = deriveCorrectionSegments({
      plan,
      master,
      masterSummary: payload.summary ?? "",
      summaryText: input.body.summaryText,
      summaryOrigin: input.body.summaryOrigin,
      operations: input.body.operations,
    });
    const employmentOf = new Map<string, string>();
    const metricsByFact = new Map<string, string[]>();
    for (const achievement of payload.achievements) {
      if (achievement.employmentId !== undefined) {
        employmentOf.set(achievement.factId, achievement.employmentId);
      }
      metricsByFact.set(achievement.factId, [...achievement.metrics]);
    }
    const snapshotFacts = listFactsByVersion(handle, version.id).map((fact) => ({
      factId: fact.factId,
      statement: fact.statement,
      verification: fact.verification,
      profileVersionId: version.id,
      employmentId: employmentOf.get(fact.factId) ?? null,
      metrics: metricsByFact.get(fact.factId) ?? [],
    }));
    const draft = Step2DraftV2.parse({
      schemaVersion: "step2-draft/v2",
      planId: plan.planId,
      planHash: stored.planHash,
      summaryText: input.body.summaryText,
      summaryOrigin: input.body.summaryOrigin,
      operations: input.body.operations,
    });
    const draftHash = correctionDraftHashFor(draft);
    const validation = validateCorrectionSegments({
      segments,
      plan,
      planHash: stored.planHash,
      draftHash,
      boundProfileVersionId: row.profileVersionId,
      snapshotFacts,
      master,
      masterSummary: payload.summary ?? "",
      employments: payload.employment.map((entry) => ({ id: entry.id, company: entry.company })),
      versionCreatedAt: version.createdAt,
      planAcceptedAt: stored.createdAt,
      now: input.now,
      validatedAt: input.now,
      summaryText: input.body.summaryText,
      operations: input.body.operations,
    });
    const saved = insertDraftValidation(handle, {
      jobId: input.jobId,
      planId: stored.id,
      workspaceRevision: input.body.workspaceRevision,
      draftHash,
      verdictJson: canonicalJson(validation),
      policyVersion: "step2-claims/2",
      now: input.now,
    });
    return { ok: true, value: { validationId: saved.id, validation } };
  });
}

/**
 * Batch diagnostics join (S2-A §4.3): one statement maps every item
 * id in the batch to its preparation state. Duplicate items carry
 * no row of their own — they resolve through the owning job.
 */
export function getBatchPreparationStates(
  handle: DatabaseHandle,
  input: { itemIds: string[]; jobIdByItemId: Map<string, string | null> },
): Map<string, BatchItemPreparationV1Type> {
  const states = new Map<string, BatchItemPreparationV1Type>();
  for (const itemId of input.itemIds) {
    states.set(itemId, null);
  }
  if (input.itemIds.length === 0) {
    return states;
  }
  const jobIds = [
    ...new Set([...input.jobIdByItemId.values()].filter((id): id is string => id !== null)),
  ];
  const rows = handle.db
    .select({
      intakeItemId: step2Preparations.intakeItemId,
      jobId: step2Preparations.jobId,
      preparationId: step2Preparations.id,
      state: step2Preparations.state,
      acceptedPlanId: step2Preparations.acceptedPlanId,
      failureJson: step2Preparations.failureJson,
    })
    .from(step2Preparations)
    .where(
      or(
        inArray(step2Preparations.intakeItemId, input.itemIds),
        jobIds.length === 0
          ? sql`0`
          : inArray(step2Preparations.jobId, jobIds),
      ),
    )
    .all();
  const byItem = new Map<string, (typeof rows)[number]>();
  const byJob = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.intakeItemId !== null) {
      byItem.set(row.intakeItemId, row);
    }
    if (row.jobId !== null) {
      byJob.set(row.jobId, row);
    }
  }
  for (const itemId of input.itemIds) {
    const direct = byItem.get(itemId);
    const jobId = input.jobIdByItemId.get(itemId) ?? null;
    const inherited = jobId === null ? undefined : byJob.get(jobId);
    const row = direct ?? inherited;
    if (row === undefined) {
      states.set(itemId, null);
      continue;
    }
    const failure =
      row.failureJson === null ? null : parsePreparationFailureDetail(row.failureJson);
    states.set(itemId, {
      state: row.state as "PENDING" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED",
      preparationId: row.preparationId,
      acceptedPlanId: row.acceptedPlanId,
      failureCode: failure?.code ?? null,
      retryAllowed:
        row.state === "FAILED" && failure !== null && isPreparationRetryableFailureCode(failure.code),
      jobId: row.jobId,
    });
  }
  return states;
}
