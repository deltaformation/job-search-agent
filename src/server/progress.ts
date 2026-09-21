import { z } from "zod";
import type { DatabaseHandle } from "../db/client";
import { getGenerationRequest } from "../db/generation";
import { readRequestProgress } from "../db/tailoringWorkspace";
import { utcNow } from "../db/utils";
import { EntityId, IsoUtcDateTime } from "../domain/fields";
import {
  ProgressReply,
  type ProgressReply as ProgressReplyType,
  type TailoringFailure as TailoringFailureType,
} from "../domain/tailoringWorkspace";
import {
  isRetryableFailureCode,
  legacyFailure,
  parseFailureDetail,
} from "../tailoring/failures";

/**
 * v1.3 generation progress read (WO-1.3-F, contracts §6). One bounded
 * repository read (≤5 statements, no lease tokens/queue payloads),
 * mapped onto ProgressReply from actual queue/attempt state:
 *
 * - A committed version wins over every other signal (SUCCEEDED).
 * - A RUNNING item reports RUNNING; a QUEUED item reports QUEUED and
 *   retains the latest failed attempt's failure evidence.
 * - A terminally failed item reports FAILED with typed failure
 *   evidence; legacy/corrupt error text degrades to INTERNAL with a
 *   persisted-timestamp occurredAt — never to persisted values.
 * - retryAllowed is advisory: FAILED plus a retryable code.
 *   Transaction R re-enforces liveness, CAS, and current inputs.
 *
 * Read-only: no timestamps are written and no work is claimed.
 */

export const ReadProgressInput = z.object({
  jobId: EntityId,
  requestId: EntityId,
  now: IsoUtcDateTime.optional(),
});
export type ReadProgressInput = z.infer<typeof ReadProgressInput>;

export type ReadProgressError = "unknown-request" | "storage-unavailable";

export interface ReadProgressFailure {
  error: ReadProgressError;
  detail: string;
}

export type ReadProgressResult =
  | { ok: true; reply: ProgressReplyType }
  | { ok: false; failure: ReadProgressFailure };

export function readGenerationProgress(
  handle: DatabaseHandle,
  rawInput: unknown,
): ReadProgressResult {
  const input = ReadProgressInput.parse(rawInput);
  const serverNow = input.now ?? utcNow();
  const request = getGenerationRequest(handle, input.requestId);
  if (request === null || request.jobId !== input.jobId) {
    return {
      ok: false,
      failure: {
        error: "unknown-request",
        detail: `generation request ${input.requestId} does not belong to job ${input.jobId}`,
      },
    };
  }
  const snapshot = readRequestProgress(handle, input.requestId);
  if (snapshot === null || snapshot.workItemId === null) {
    return {
      ok: false,
      failure: {
        error: "storage-unavailable",
        detail: `request ${input.requestId} has no queue linkage; inspect the row, do not trust it`,
      },
    };
  }

  let state: ProgressReplyType["state"];
  if (snapshot.resumeVersionId !== null) {
    state = "SUCCEEDED";
  } else if (snapshot.workState === "RUNNING") {
    state = "RUNNING";
  } else if (snapshot.workState === "QUEUED") {
    state = "QUEUED";
  } else if (snapshot.workState === "SUCCEEDED") {
    // Defensive: the queue finished without committing a version —
    // attach commits both atomically, so this row is corrupt. Report
    // FAILED rather than a success with no output.
    state = "FAILED";
  } else {
    state = "FAILED";
  }

  let failure: TailoringFailureType | null = null;
  const latestFailed =
    (snapshot.result === "FAILED" || snapshot.result === "BLOCKED") &&
    (state === "QUEUED" || state === "FAILED");
  if (latestFailed) {
    failure =
      parseFailureDetail(snapshot.errorDetail) ??
      legacyFailure(snapshot.finishedAt ?? serverNow);
  } else if (state === "FAILED") {
    failure = legacyFailure(snapshot.finishedAt ?? serverNow);
  }

  const reply = ProgressReply.safeParse({
    ok: true,
    requestId: snapshot.requestId,
    state,
    serverNow,
    attemptId: snapshot.attemptId,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    leaseExpiresAt: snapshot.workState === "RUNNING" ? snapshot.leaseExpiresAt : null,
    lastHeartbeatAt: snapshot.lastHeartbeatAt,
    events: snapshot.events.map((event) => ({
      seq: event.seq,
      stage: event.stage,
      source: event.source,
      recordedAt: event.recordedAt,
    })),
    failure,
    resumeVersionId: snapshot.resumeVersionId,
    retryAllowed:
      state === "FAILED" && failure !== null && isRetryableFailureCode(failure.code),
  });
  if (!reply.success) {
    return {
      ok: false,
      failure: {
        error: "storage-unavailable",
        detail: `request ${input.requestId} progress failed strict validation; inspect the rows, do not trust them`,
      },
    };
  }
  return { ok: true, reply: reply.data };
}
