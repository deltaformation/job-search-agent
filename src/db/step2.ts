import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import {
  PreparationPlanV1,
  Step2ValidationV1,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type Step2ValidationV1 as Step2ValidationV1Type,
} from "../domain/step2";
import {
  PreparationPlanV2,
  Step2ValidationV2,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2ValidationV2 as Step2ValidationV2Type,
} from "../domain/step2Correction";
import {
  jobExtractions,
  step2DraftValidations,
  step2GenerationInputs,
  step2Plans,
  step2PreparationEvents,
  step2Preparations,
  workAttempts,
  workItems,
  type Step2DraftValidation,
  type Step2GenerationInput,
  type Step2Plan,
  type Step2Preparation,
  type Step2PreparationEvent,
} from "./schema";
import { withTransaction } from "./transactions";
import { newId } from "./utils";

/**
 * Step 2 preparation repositories (WO-1.3-S2-B). Thin SQL over the
 * five 0009 tables, mirroring the 0008 repository rules: every
 * method runs in one short synchronous transaction (nest-safe, so
 * services compose them inside P/PR and handler fences); methods
 * accept trusted service clocks (`now`) and lease tuples as
 * explicit parameters; JSON columns are stored and returned as
 * text — services parse them through the strict S2 Zod schemas.
 * Constraint and trigger violations propagate as `SqliteError`
 * carrying the exact SQL name (`PREPARATION_IMMUTABLE`,
 * `BINDING_IMMUTABLE`, `PLAN_*`, `LEASE_LOST`, `PREP_PROGRESS_*`,
 * `VERDICT_IMMUTABLE`, `S2_INPUT_*`).
 */

export type PreparationState =
  | "PENDING"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED";

/** Preparation row by job, intake item, id, or work item (PK lookups). */
export function readPreparationByJob(
  handle: DatabaseHandle,
  jobId: string,
): Step2Preparation | null {
  const row = handle.db
    .select()
    .from(step2Preparations)
    .where(eq(step2Preparations.jobId, jobId))
    .get();
  return row ?? null;
}

export function readPreparationById(
  handle: DatabaseHandle,
  preparationId: string,
): Step2Preparation | null {
  const row = handle.db
    .select()
    .from(step2Preparations)
    .where(eq(step2Preparations.id, preparationId))
    .get();
  return row ?? null;
}

export function readPreparationByIntakeItem(
  handle: DatabaseHandle,
  intakeItemId: string,
): Step2Preparation | null {
  const row = handle.db
    .select()
    .from(step2Preparations)
    .where(eq(step2Preparations.intakeItemId, intakeItemId))
    .get();
  return row ?? null;
}

export interface InsertPreparationInput {
  id?: string;
  intakeItemId: string | null;
  jobId: string | null;
  batchId: string | null;
  profileId: string;
  profileVersionId: string;
  profilePayloadHash: string;
  evidenceHash: string;
  masterSourceId: string | null;
  /** Canonical IntakeBindingV1 bytes (service-validated). */
  bindingJson: string;
  now: string;
}

/**
 * Insert one PENDING preparation row. The binding columns are
 * written once here and frozen by `s2_prep_binding_locked`
 * afterwards; duplicate intake items/jobs abort on the UNIQUE
 * indexes so retries reuse the existing row instead of rebinding.
 */
export function insertPreparation(
  handle: DatabaseHandle,
  input: InsertPreparationInput,
): Step2Preparation {
  return withTransaction(handle.sqlite, () => {
    const id = input.id ?? newId();
    handle.db
      .insert(step2Preparations)
      .values({
        id,
        intakeItemId: input.intakeItemId,
        jobId: input.jobId,
        batchId: input.batchId,
        profileId: input.profileId,
        profileVersionId: input.profileVersionId,
        extractionId: null,
        profilePayloadHash: input.profilePayloadHash,
        evidenceHash: input.evidenceHash,
        masterSourceId: input.masterSourceId,
        bindingJson: input.bindingJson,
        state: "PENDING",
        workItemId: null,
        acceptedPlanId: null,
        lastOperationId: null,
        lastOperationHash: null,
        failureJson: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
    const row = handle.db
      .select()
      .from(step2Preparations)
      .where(eq(step2Preparations.id, id))
      .get();
    if (row === undefined) {
      throw new Error(`inserted preparation ${id} is not readable`);
    }
    return row;
  });
}

/**
 * Link a preparation row to its job and extraction (extraction
 * success path). Only an unlinked row moves; an already-linked row
 * reports `already-linked` so re-scrapes wait for the explicit
 * supersession command instead of silently retargeting.
 */
export function linkPreparationExtraction(
  handle: DatabaseHandle,
  input: { preparationId: string; jobId: string; extractionId: string; now: string },
): { ok: true } | { ok: false; error: "already-linked" | "missing" } {
  return withTransaction(handle.sqlite, () => {
    const row = handle.db
      .select({
        jobId: step2Preparations.jobId,
        extractionId: step2Preparations.extractionId,
      })
      .from(step2Preparations)
      .where(eq(step2Preparations.id, input.preparationId))
      .get();
    if (row === undefined) {
      return { ok: false, error: "missing" } as const;
    }
    if (row.jobId !== null || row.extractionId !== null) {
      return { ok: false, error: "already-linked" } as const;
    }
    handle.db
      .update(step2Preparations)
      .set({ jobId: input.jobId, extractionId: input.extractionId, updatedAt: input.now })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
    return { ok: true } as const;
  });
}

/** Relink the extraction of a linked row (explicit supersession only). */
export function relinkPreparationExtraction(
  handle: DatabaseHandle,
  input: { preparationId: string; extractionId: string; now: string },
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .update(step2Preparations)
      .set({ extractionId: input.extractionId, updatedAt: input.now })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
  });
}

export interface MarkPreparationQueuedInput {
  preparationId: string;
  workItemId: string;
  /** Explicit-command identity; null on the automatic schedule path. */
  lastOperationId: string | null;
  lastOperationHash: string | null;
  now: string;
}

/**
 * Move PENDING/FAILED/SUCCEEDED(supersede) to QUEUED with the new
 * work item and operation identity; clears the failure evidence.
 * QUEUED/RUNNING rows refuse with `busy` (the service maps 409).
 */
export function markPreparationQueued(
  handle: DatabaseHandle,
  input: MarkPreparationQueuedInput,
): { ok: true } | { ok: false; error: "busy" | "missing" } {
  return withTransaction(handle.sqlite, () => {
    const row = handle.db
      .select({ state: step2Preparations.state })
      .from(step2Preparations)
      .where(eq(step2Preparations.id, input.preparationId))
      .get();
    if (row === undefined) {
      return { ok: false, error: "missing" } as const;
    }
    if (row.state === "QUEUED" || row.state === "RUNNING") {
      return { ok: false, error: "busy" } as const;
    }
    handle.db
      .update(step2Preparations)
      .set({
        state: "QUEUED",
        workItemId: input.workItemId,
        lastOperationId: input.lastOperationId,
        lastOperationHash: input.lastOperationHash,
        failureJson: null,
        updatedAt: input.now,
      })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
    return { ok: true } as const;
  });
}

/**
 * Begin a preparation run: QUEUED/FAILED/RUNNING → RUNNING. FAILED
 * reopens after an auto-retry requeue (the dispatcher's bounded
 * retry, not an explicit command); RUNNING continues after a crash
 * replay under a fresh attempt. SUCCEEDED never reopens here —
 * the handler converges onto the accepted plan instead.
 */
export function markPreparationRunning(
  handle: DatabaseHandle,
  input: { preparationId: string; now: string },
): boolean {
  return withTransaction(handle.sqlite, () => {
    const row = handle.db
      .select({ state: step2Preparations.state })
      .from(step2Preparations)
      .where(eq(step2Preparations.id, input.preparationId))
      .get();
    if (row === undefined || row.state === "SUCCEEDED") {
      return false;
    }
    handle.db
      .update(step2Preparations)
      .set({ state: "RUNNING", updatedAt: input.now })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
    return true;
  });
}

/**
 * Flip the accepted pointer and mark SUCCEEDED. The conditional
 * update makes crash-replay idempotent; the forward-only trigger
 * refuses backward moves. Clears failure evidence on success.
 */
export function markPreparationSucceeded(
  handle: DatabaseHandle,
  input: { preparationId: string; planId: string; now: string },
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .update(step2Preparations)
      .set({
        acceptedPlanId: input.planId,
        state: "SUCCEEDED",
        failureJson: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(step2Preparations.id, input.preparationId),
          // Parenthesized: a bare OR would escape the AND (SQL
          // precedence) and rewrite every preparation row.
          sql`(${step2Preparations.acceptedPlanId} IS NULL OR ${step2Preparations.acceptedPlanId} != ${input.planId})`,
        ),
      )
      .run();
    handle.db
      .update(step2Preparations)
      .set({ state: "SUCCEEDED", failureJson: null, updatedAt: input.now })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
  });
}

/** Record a terminal preparation failure (QUEUED/RUNNING → FAILED). */
export function markPreparationFailed(
  handle: DatabaseHandle,
  input: { preparationId: string; failureJson: string; now: string },
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .update(step2Preparations)
      .set({ state: "FAILED", failureJson: input.failureJson, updatedAt: input.now })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
  });
}

/**
 * Requeue a FAILED preparation run for explicit retry (PR): state →
 * QUEUED, failure evidence cleared, explicit-command identity kept.
 * Only FAILED rows move; anything else reports `not-failed`.
 */
export function requeuePreparationRun(
  handle: DatabaseHandle,
  input: { preparationId: string; now: string },
): { ok: true } | { ok: false; error: "not-failed" | "missing" } {
  return withTransaction(handle.sqlite, () => {
    const row = handle.db
      .select({ state: step2Preparations.state })
      .from(step2Preparations)
      .where(eq(step2Preparations.id, input.preparationId))
      .get();
    if (row === undefined) {
      return { ok: false, error: "missing" } as const;
    }
    if (row.state !== "FAILED") {
      return { ok: false, error: "not-failed" } as const;
    }
    handle.db
      .update(step2Preparations)
      .set({ state: "QUEUED", failureJson: null, updatedAt: input.now })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
    return { ok: true } as const;
  });
}

/** Persist the latest explicit-command operation identity. */
export function recordPreparationOperation(
  handle: DatabaseHandle,
  input: { preparationId: string; lastOperationId: string; lastOperationHash: string; now: string },
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .update(step2Preparations)
      .set({
        lastOperationId: input.lastOperationId,
        lastOperationHash: input.lastOperationHash,
        updatedAt: input.now,
      })
      .where(eq(step2Preparations.id, input.preparationId))
      .run();
  });
}

export interface InsertPlanInput {
  id?: string;
  preparationId: string;
  /** Canonical plan bytes, v1 or v2 (service-validated). */
  planJson: string;
  planHash: string;
  providerId: string;
  model: string | null;
  promptVersion: "prepare-prompt/v1" | "prepare-prompt/v2";
  proposalSchemaVersion: "preparation-proposal/v1" | "preparation-proposal/v2";
  claimsPolicyVersion: "step2-claims/1" | "step2-claims/2";
  inputHash: string;
  proposalHash: string;
  attemptId: string;
  /** Canonical per-item validation record, v1 or v2 (service-validated). */
  validationJson: string;
  supersedesPlanId: string | null;
  now: string;
}

/**
 * Append one immutable plan row with the next `plan_seq` for its
 * preparation. Identical bytes re-insert aborts on
 * `s2_plans_hash`, so a crashed flip replays converge instead of
 * duplicating.
 */
export function insertPlan(handle: DatabaseHandle, input: InsertPlanInput): Step2Plan {
  return withTransaction(handle.sqlite, () => {
    const id = input.id ?? newId();
    const latest = handle.db
      .select({ planSeq: step2Plans.planSeq })
      .from(step2Plans)
      .where(eq(step2Plans.preparationId, input.preparationId))
      .orderBy(desc(step2Plans.planSeq))
      .limit(1)
      .get();
    handle.db
      .insert(step2Plans)
      .values({
        id,
        preparationId: input.preparationId,
        planSeq: (latest?.planSeq ?? 0) + 1,
        planJson: input.planJson,
        planHash: input.planHash,
        providerId: input.providerId,
        model: input.model,
        promptVersion: input.promptVersion,
        proposalSchemaVersion: input.proposalSchemaVersion,
        claimsPolicyVersion: input.claimsPolicyVersion,
        inputHash: input.inputHash,
        proposalHash: input.proposalHash,
        attemptId: input.attemptId,
        validationJson: input.validationJson,
        supersedesPlanId: input.supersedesPlanId,
        createdAt: input.now,
      })
      .run();
    const row = handle.db
      .select()
      .from(step2Plans)
      .where(eq(step2Plans.id, id))
      .get();
    if (row === undefined) {
      throw new Error(`inserted plan ${id} is not readable`);
    }
    return row;
  });
}

export function readPlan(handle: DatabaseHandle, planId: string): Step2Plan | null {
  const row = handle.db
    .select()
    .from(step2Plans)
    .where(eq(step2Plans.id, planId))
    .get();
  return row ?? null;
}

export function readPlanByHash(
  handle: DatabaseHandle,
  preparationId: string,
  planHash: string,
): Step2Plan | null {
  const row = handle.db
    .select()
    .from(step2Plans)
    .where(
      and(
        eq(step2Plans.preparationId, preparationId),
        eq(step2Plans.planHash, planHash),
      ),
    )
    .get();
  return row ?? null;
}

export function readLatestPlan(
  handle: DatabaseHandle,
  preparationId: string,
): Step2Plan | null {
  const row = handle.db
    .select()
    .from(step2Plans)
    .where(eq(step2Plans.preparationId, preparationId))
    .orderBy(desc(step2Plans.planSeq))
    .limit(1)
    .get();
  return row ?? null;
}

export type StoredStep2Plan =
  | { version: 1; plan: PreparationPlanV1Type }
  | { version: 2; plan: PreparationPlanV2Type };

export type StoredStep2Validation =
  | { version: 1; validation: Step2ValidationV1Type }
  | { version: 2; validation: Step2ValidationV2Type };

function storedSchemaVersion(rawJson: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "string" ? version : null;
}

/**
 * Version-aware plan reader (correction contracts §12): parse
 * `planJson` by its embedded `schemaVersion` into a tagged union.
 * Unknown versions and unparseable bytes fail closed as null —
 * callers map that to `storage-unavailable`, never guess.
 */
export function parseStoredPlan(planJson: string): StoredStep2Plan | null {
  const version = storedSchemaVersion(planJson);
  try {
    if (version === "step2-plan/v1") {
      return {
        version: 1,
        plan: PreparationPlanV1.parse(JSON.parse(planJson) as unknown),
      };
    }
    if (version === "step2-plan/v2") {
      return {
        version: 2,
        plan: PreparationPlanV2.parse(JSON.parse(planJson) as unknown),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Version-aware verdict reader (correction contracts §12): parse
 * `verdictJson` by its embedded `schemaVersion` into a tagged
 * union. Unknown versions and unparseable bytes fail closed as
 * null — `/2` never reinterprets a `/1` row and vice versa.
 */
export function parseStoredValidation(verdictJson: string): StoredStep2Validation | null {
  const version = storedSchemaVersion(verdictJson);
  try {
    if (version === "step2-validation/v1") {
      return {
        version: 1,
        validation: Step2ValidationV1.parse(JSON.parse(verdictJson) as unknown),
      };
    }
    if (version === "step2-validation/v2") {
      return {
        version: 2,
        validation: Step2ValidationV2.parse(JSON.parse(verdictJson) as unknown),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export interface AppendPreparationEventInput {
  preparationId: string;
  workItemId: string;
  attemptId: string;
  seq: number;
  stage: string;
  source: "provider" | "cached";
  leaseToken: string;
  recordedAt: string;
}

/**
 * Append one fenced boundary event. The `s2_event_fence` trigger
 * rechecks the live lease tuple, sequence, stage order, time, and
 * source constancy; violations propagate (`LEASE_LOST`,
 * `PREP_PROGRESS_*`) so the handler aborts write-free on lease loss
 * and loudly on its own bugs.
 */
export function appendPreparationEventFenced(
  handle: DatabaseHandle,
  input: AppendPreparationEventInput,
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(step2PreparationEvents)
      .values({
        preparationId: input.preparationId,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        seq: input.seq,
        stage: input.stage,
        source: input.source,
        leaseToken: input.leaseToken,
        recordedAt: input.recordedAt,
      })
      .run();
  });
}

export function readPreparationEvents(
  handle: DatabaseHandle,
  attemptId: string,
): Step2PreparationEvent[] {
  return handle.db
    .select()
    .from(step2PreparationEvents)
    .where(eq(step2PreparationEvents.attemptId, attemptId))
    .orderBy(asc(step2PreparationEvents.seq))
    .all();
}

export interface InsertDraftValidationInput {
  id?: string;
  jobId: string;
  planId: string;
  workspaceRevision: number;
  draftHash: string;
  /** Canonical verdict bytes, `step2-claims/1` or `/2` (service-validated). */
  verdictJson: string;
  policyVersion: "step2-claims/1" | "step2-claims/2";
  now: string;
}

/** Append one immutable draft-verdict row (validate endpoint, S2-D gate). */
export function insertDraftValidation(
  handle: DatabaseHandle,
  input: InsertDraftValidationInput,
): Step2DraftValidation {
  return withTransaction(handle.sqlite, () => {
    const id = input.id ?? newId();
    handle.db
      .insert(step2DraftValidations)
      .values({
        id,
        jobId: input.jobId,
        planId: input.planId,
        workspaceRevision: input.workspaceRevision,
        draftHash: input.draftHash,
        verdictJson: input.verdictJson,
        policyVersion: input.policyVersion,
        createdAt: input.now,
      })
      .run();
    const row = handle.db
      .select()
      .from(step2DraftValidations)
      .where(eq(step2DraftValidations.id, id))
      .get();
    if (row === undefined) {
      throw new Error(`inserted draft validation ${id} is not readable`);
    }
    return row;
  });
}

/** One persisted verdict row by id, or null when unknown. */
export function readDraftValidation(
  handle: DatabaseHandle,
  validationId: string,
): Step2DraftValidation | null {
  const row = handle.db
    .select()
    .from(step2DraftValidations)
    .where(eq(step2DraftValidations.id, validationId))
    .get();
  return row ?? null;
}

export function readDraftValidationsByHash(
  handle: DatabaseHandle,
  jobId: string,
  draftHash: string,
): Step2DraftValidation[] {
  return handle.db
    .select()
    .from(step2DraftValidations)
    .where(
      and(
        eq(step2DraftValidations.jobId, jobId),
        eq(step2DraftValidations.draftHash, draftHash),
      ),
    )
    .orderBy(desc(step2DraftValidations.createdAt))
    .all();
}

export interface InsertStep2GenerationInputs {
  requestId: string;
  planId: string;
  planHash: string;
  draftHash: string;
  validationId: string;
  /** Canonical edited-inputs bytes (S2-D service-validated). */
  editedInputsJson: string;
  /** Canonical policy-versions bytes (S2-D service-validated). */
  policyVersionsJson: string;
  now: string;
}

/**
 * Insert the immutable edited-plan input extension (S2-D writes;
 * S2-B provides the repository with the table). Plan/request/
 * validation linkage disagreements abort with
 * `S2_INPUT_PLAN_MISMATCH`.
 */
export function insertStep2GenerationInputs(
  handle: DatabaseHandle,
  input: InsertStep2GenerationInputs,
): void {
  withTransaction(handle.sqlite, () => {
    handle.db
      .insert(step2GenerationInputs)
      .values({
        requestId: input.requestId,
        planId: input.planId,
        planHash: input.planHash,
        draftHash: input.draftHash,
        validationId: input.validationId,
        editedInputsJson: input.editedInputsJson,
        policyVersionsJson: input.policyVersionsJson,
        createdAt: input.now,
      })
      .run();
  });
}

/** Immutable edited-plan inputs for one generation request (S2-D reads). */
export function readStep2GenerationInputs(
  handle: DatabaseHandle,
  requestId: string,
): Step2GenerationInput | null {
  const row = handle.db
    .select()
    .from(step2GenerationInputs)
    .where(eq(step2GenerationInputs.requestId, requestId))
    .get();
  return row ?? null;
}

/** Raw extraction JSON for verification, or null when the row is gone. */
export function readJobExtractionJson(
  handle: DatabaseHandle,
  extractionId: string,
): string | null {
  const row = handle.db
    .select({ extractedJson: jobExtractions.extractedJson })
    .from(jobExtractions)
    .where(eq(jobExtractions.id, extractionId))
    .get();
  return row?.extractedJson ?? null;
}

/** Owning work item of an attempt, or null when the attempt is unknown. */
export function readAttemptWorkItemId(
  handle: DatabaseHandle,
  attemptId: string,
): string | null {
  const row = handle.db
    .select({ workItemId: workAttempts.workItemId })
    .from(workAttempts)
    .where(eq(workAttempts.id, attemptId))
    .get();
  return row?.workItemId ?? null;
}

export function readWorkItemById(
  handle: DatabaseHandle,
  workItemId: string,
): {
  id: string;
  kind: string;
  idempotencyKey: string;
  jobId: string | null;
  intakeItemId: string | null;
  payloadJson: string | null;
  state: string;
  attemptCount: number;
  maxAttempts: number;
  currentAttemptId: string | null;
} | null {
  const row = handle.db
    .select({
      id: workItems.id,
      kind: workItems.kind,
      idempotencyKey: workItems.idempotencyKey,
      jobId: workItems.jobId,
      intakeItemId: workItems.intakeItemId,
      payloadJson: workItems.payloadJson,
      state: workItems.state,
      attemptCount: workItems.attemptCount,
      maxAttempts: workItems.maxAttempts,
      currentAttemptId: workItems.currentAttemptId,
    })
    .from(workItems)
    .where(eq(workItems.id, workItemId))
    .get();
  return row ?? null;
}

export function readWorkItemByIdempotencyKey(
  handle: DatabaseHandle,
  idempotencyKey: string,
): { id: string; kind: string; state: string; jobId: string | null } | null {
  const row = handle.db
    .select({
      id: workItems.id,
      kind: workItems.kind,
      state: workItems.state,
      jobId: workItems.jobId,
    })
    .from(workItems)
    .where(eq(workItems.idempotencyKey, idempotencyKey))
    .get();
  return row ?? null;
}

export interface WorkAttemptRow {
  id: string;
  workItemId: string;
  attemptNumber: number;
  result: string;
  errorCode: string | null;
  errorDetail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function readWorkAttemptById(
  handle: DatabaseHandle,
  attemptId: string,
): WorkAttemptRow | null {
  const row = handle.db
    .select({
      id: workAttempts.id,
      workItemId: workAttempts.workItemId,
      attemptNumber: workAttempts.attemptNumber,
      result: workAttempts.result,
      errorCode: workAttempts.errorCode,
      errorDetail: workAttempts.errorDetail,
      startedAt: workAttempts.startedAt,
      finishedAt: workAttempts.finishedAt,
    })
    .from(workAttempts)
    .where(eq(workAttempts.id, attemptId))
    .get();
  return row ?? null;
}

export function readLatestWorkAttempt(
  handle: DatabaseHandle,
  workItemId: string,
): WorkAttemptRow | null {
  const row = handle.db
    .select({
      id: workAttempts.id,
      workItemId: workAttempts.workItemId,
      attemptNumber: workAttempts.attemptNumber,
      result: workAttempts.result,
      errorCode: workAttempts.errorCode,
      errorDetail: workAttempts.errorDetail,
      startedAt: workAttempts.startedAt,
      finishedAt: workAttempts.finishedAt,
    })
    .from(workAttempts)
    .where(eq(workAttempts.workItemId, workItemId))
    .orderBy(desc(workAttempts.attemptNumber))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Latest attempt of a work item plus the item's lease bookkeeping
 * for status reads (single statement; tokens stay server-side and
 * callers choose what to serialize).
 */
export function readPreparationWorkState(
  handle: DatabaseHandle,
  workItemId: string,
): {
  state: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
  currentAttemptId: string | null;
  attemptId: string | null;
  attemptNumber: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  errorCode: string | null;
  errorDetail: string | null;
} | null {
  const row = handle.db
    .select({
      state: workItems.state,
      leaseToken: workItems.leaseToken,
      leaseExpiresAt: workItems.leaseExpiresAt,
      updatedAt: workItems.updatedAt,
      currentAttemptId: workItems.currentAttemptId,
      attemptId: workAttempts.id,
      attemptNumber: workAttempts.attemptNumber,
      startedAt: workAttempts.startedAt,
      finishedAt: workAttempts.finishedAt,
      result: workAttempts.result,
      errorCode: workAttempts.errorCode,
      errorDetail: workAttempts.errorDetail,
    })
    .from(workItems)
    .leftJoin(workAttempts, eq(workAttempts.id, workItems.currentAttemptId))
    .where(eq(workItems.id, workItemId))
    .get();
  if (row === undefined) {
    return null;
  }
  // Terminal items hold no current attempt; status still reports
  // the latest attempt's envelope (diagnostics survive completion).
  if (row.currentAttemptId === null) {
    const latest = readLatestWorkAttempt(handle, workItemId);
    if (latest !== null) {
      return {
        ...row,
        attemptId: latest.id,
        attemptNumber: latest.attemptNumber,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
        result: latest.result,
        errorCode: latest.errorCode,
        errorDetail: latest.errorDetail,
      };
    }
  }
  return row;
}
