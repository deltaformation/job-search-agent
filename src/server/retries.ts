import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import { getActiveProfileVersion } from "../db/candidates";
import {
  getGenerationRequest,
  getLiveGenerationRequest,
  updateGenerationRequestStatus,
} from "../db/generation";
import { resumeVersions } from "../db/schema";
import { workAttempts, workItems } from "../db/schema/queue";
import { casJobTailoringState, getTailoringJob } from "../db/tailoring";
import { readPreparationByJob, readStep2GenerationInputs } from "../db/step2";
import { readRequestInputs, readWorkspace } from "../db/tailoringWorkspace";
import { withTransaction } from "../db/transactions";
import { utcNow } from "../db/utils";
import { EntityId, IsoUtcDateTime, RowVersion } from "../domain/fields";
import { requeueWorkItem } from "../queue/leases";
import { retryableFromErrorCode } from "../tailoring/failures";
import { verifyCapturedEvidence } from "./preparation";

/**
 * v1.3 transaction R: attempt-specific explicit retry (WO-1.3-F,
 * contracts §4.1). The caller names the exact failed attempt it
 * observed; R requeues the same work item through the existing
 * primitive — immutable input and attempt numbering preserved, old
 * attempts never rewritten — or replays without writes.
 *
 * One outer transaction: resolve the owned request and observed
 * attempt FIRST. A later attempt, or already-requeued/running work,
 * returns 200 replay with zero writes (an earlier observed attempt
 * can never requeue a later failure). Otherwise R requires current
 * inputs, a retryable terminal failure, job CAS, and no other live
 * run, then marks the request QUEUED and the job PENDING. The next
 * claim creates the new attempt; automatic maxAttempts/backoff
 * still bounds the requeued work.
 *
 * v1.3 requests only: a request without the immutable input
 * extension is a legacy run and retries through the legacy route
 * until H cuts over — R answers 422 rather than forging the
 * workspace revision the reply owes.
 */

export const RetryGenerationInput = z.object({
  jobId: EntityId,
  requestId: EntityId,
  observedAttemptId: EntityId,
  observedRowVersion: RowVersion,
  now: IsoUtcDateTime.optional(),
});
export type RetryGenerationInput = z.infer<typeof RetryGenerationInput>;

export type RetryGenerationError =
  | "unknown-request"
  | "unknown-attempt"
  | "job-conflict"
  | "generation-busy"
  | "retry-not-allowed"
  | "input-stale"
  | "storage-unavailable";

export interface RetryGenerationFailure {
  error: RetryGenerationError;
  detail: string;
  currentRowVersion?: number;
}

export type RetryGenerationResult =
  | {
      ok: true;
      requestId: string;
      workItemId: string;
      status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
      replayed: boolean;
      jobRowVersion: number;
      workspaceRevision: number;
    }
  | { ok: false; failure: RetryGenerationFailure };

function fail(
  error: RetryGenerationError,
  detail: string,
  extra: Partial<RetryGenerationFailure> = {},
): { ok: false; failure: RetryGenerationFailure } {
  return { ok: false, failure: { error, detail, ...extra } };
}

function queueStatusOf(itemState: string): "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" {
  if (itemState === "RUNNING") {
    return "RUNNING";
  }
  if (itemState === "QUEUED") {
    return "QUEUED";
  }
  if (itemState === "SUCCEEDED") {
    return "SUCCEEDED";
  }
  return "FAILED";
}

export function retryGeneration(
  handle: DatabaseHandle,
  rawInput: unknown,
): RetryGenerationResult {
  const input = RetryGenerationInput.parse(rawInput);
  const now = input.now ?? utcNow();

  return withTransaction(handle.sqlite, () => {
    const request = getGenerationRequest(handle, input.requestId);
    if (request === null || request.jobId !== input.jobId) {
      return fail(
        "unknown-request",
        `generation request ${input.requestId} does not belong to job ${input.jobId}`,
      );
    }
    if (request.workItemId === null) {
      return fail(
        "storage-unavailable",
        `request ${input.requestId} has no queue linkage; inspect the row, do not trust it`,
      );
    }
    const item = handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, request.workItemId))
      .get();
    if (item === undefined) {
      return fail(
        "storage-unavailable",
        `request ${input.requestId} points at missing work ${request.workItemId}`,
      );
    }
    const attempts = handle.db
      .select()
      .from(workAttempts)
      .where(eq(workAttempts.workItemId, item.id))
      .orderBy(asc(workAttempts.attemptNumber))
      .all();
    const observed = attempts.find((attempt) => attempt.id === input.observedAttemptId);
    if (observed === undefined) {
      return fail(
        "unknown-attempt",
        `attempt ${input.observedAttemptId} does not belong to request ${input.requestId}`,
      );
    }
    const latest = attempts[attempts.length - 1];
    if (latest === undefined) {
      return fail(
        "storage-unavailable",
        `work ${item.id} has no attempts; inspect the rows, do not trust them`,
      );
    }
    const inputs = readRequestInputs(handle, request.id);
    if (inputs === null) {
      return fail(
        "retry-not-allowed",
        `request ${input.requestId} predates explicit retry; start a new run from Step 2`,
      );
    }
    const workspaceRevision =
      readWorkspace(handle, input.jobId)?.revision ?? inputs.workspaceRevision;

    // Replay precedes every check (including CAS): a lost-202 retry
    // reconciles without a second requeue, and an earlier observed
    // attempt can never requeue a later failure.
    if (observed.id !== latest.id || item.state === "QUEUED" || item.state === "RUNNING") {
      const job = getTailoringJob(handle, input.jobId);
      return {
        ok: true,
        requestId: request.id,
        workItemId: item.id,
        status: queueStatusOf(item.state),
        replayed: true,
        jobRowVersion: job?.rowVersion ?? input.observedRowVersion,
        workspaceRevision,
      };
    }
    if (item.state !== "FAILED") {
      return fail(
        "retry-not-allowed",
        `request ${input.requestId} is not in a retryable terminal state`,
      );
    }
    const committed = handle.db
      .select({ id: resumeVersions.id })
      .from(resumeVersions)
      .where(eq(resumeVersions.generationRequestId, request.id))
      .get();
    if (committed !== undefined) {
      return fail(
        "retry-not-allowed",
        `request ${input.requestId} already published a version; review it instead of retrying`,
      );
    }
    if (latest.result === "SUCCEEDED") {
      return fail(
        "retry-not-allowed",
        `request ${input.requestId} already succeeded; start a new run for fresh output`,
      );
    }
    if (latest.result !== "FAILED" && latest.result !== "BLOCKED") {
      return fail(
        "storage-unavailable",
        `work ${item.id} is terminal with a live latest attempt; inspect the rows, do not trust them`,
      );
    }
    const classified = retryableFromErrorCode(latest.errorCode);
    if (!classified.retryable) {
      return fail(
        "retry-not-allowed",
        `request ${input.requestId} failed with non-retryable ${classified.code}; start a new run instead`,
      );
    }
    const job = getTailoringJob(handle, input.jobId);
    if (job === null) {
      return fail(
        "unknown-request",
        `generation request ${input.requestId} does not belong to job ${input.jobId}`,
      );
    }
    if (job.status === "REJECTED") {
      return fail(
        "retry-not-allowed",
        "rejected jobs cannot retry generation; restore the job first",
      );
    }
    if (job.activeExtractionId !== request.extractionId) {
      return fail(
        "input-stale",
        "the request's extraction is no longer the job's active extraction; start a new run",
      );
    }
    // S2-D: edited-plan retries re-verify the captured evidence
    // digest instead of the active pointer — later Settings edits
    // never strand frozen work, while evidence drift fails closed.
    // The worker re-executes the frozen bytes; nothing here reads
    // newer draft or settings values.
    const step2 = readStep2GenerationInputs(handle, request.id);
    if (step2 !== null) {
      const preparation = readPreparationByJob(handle, input.jobId);
      const evidence =
        preparation === null
          ? null
          : verifyCapturedEvidence(handle, {
              profileId: request.profileId,
              profileVersionId: request.profileVersionId,
              profilePayloadHash: preparation.profilePayloadHash,
              evidenceHash: preparation.evidenceHash,
            });
      if (evidence === null || evidence.ok !== true) {
        return fail(
          "input-stale",
          "the request's captured profile evidence no longer verifies; start a new run",
        );
      }
    } else {
      const active = getActiveProfileVersion(handle, request.profileId);
      if (active === null || active.id !== request.profileVersionId) {
        return fail(
          "input-stale",
          "the request's profile version is no longer active; start a new run",
        );
      }
    }
    if (job.rowVersion !== input.observedRowVersion) {
      return fail("job-conflict", "job changed during retry; reload and retry", {
        currentRowVersion: job.rowVersion,
      });
    }
    if (job.tailoringState === "PENDING" || job.tailoringState === "RUNNING") {
      return fail("generation-busy", "a tailoring run is already live for this job", {
        currentRowVersion: job.rowVersion,
      });
    }
    const live = getLiveGenerationRequest(handle, input.jobId);
    if (live !== null) {
      return fail(
        "generation-busy",
        `request ${live.id} is already live for this job; wait for it instead of retrying`,
        { currentRowVersion: job.rowVersion },
      );
    }

    const requeued = requeueWorkItem(handle, { workItemId: item.id, now });
    if (!requeued.ok) {
      return fail("generation-busy", "the work item left its retryable state during retry", {
        currentRowVersion: job.rowVersion,
      });
    }
    updateGenerationRequestStatus(handle, {
      requestId: request.id,
      status: "QUEUED",
      errorCode: null,
      errorDetail: null,
      finishedAt: null,
      now,
    });
    const moved = casJobTailoringState(handle, {
      jobId: input.jobId,
      rowVersion: input.observedRowVersion,
      tailoringState: "PENDING",
      reasonCode: null,
      now,
    });
    if (!moved) {
      return fail("job-conflict", "job changed during retry; reload and retry", {
        currentRowVersion: getTailoringJob(handle, input.jobId)?.rowVersion ?? input.observedRowVersion,
      });
    }
    return {
      ok: true,
      requestId: request.id,
      workItemId: item.id,
      status: "QUEUED",
      replayed: false,
      jobRowVersion: input.observedRowVersion + 1,
      workspaceRevision,
    };
  });
}
