import type { DatabaseHandle } from "../db/client";
import { getJobDescriptionPointer } from "../db/candidates";
import { getLatestTailorWorkItem, getTailoringJob } from "../db/tailoring";
import { requeueWorkItem } from "../queue/leases";
import { requestTailoring } from "../tailoring/enqueue";

/**
 * Job-scoped tailoring retry ("ensure tailoring runs"): requeues the
 * job's latest FAILED TAILOR item, enqueues a first run when tailoring
 * never started, and no-ops when work is already queued, running, or
 * succeeded. The route never touches `jobs.tailoring_state` directly —
 * only the worker's leased claim may move a run to RUNNING, so retries
 * cannot bypass queue fencing or strand duplicate runs.
 */

export type RetryTailoringAction =
  | "enqueued"
  | "requeued"
  | "already_queued"
  | "already_running"
  | "already_succeeded";

export interface RetryTailoringSuccess {
  ok: true;
  workItemId: string;
  action: RetryTailoringAction;
}

export interface RetryTailoringFailure {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
  message: string;
}

export type RetryTailoringResult = RetryTailoringSuccess | RetryTailoringFailure;

function noopForState(
  workItemId: string,
  state: string,
): RetryTailoringSuccess | RetryTailoringFailure {
  if (state === "QUEUED") {
    return { ok: true, workItemId, action: "already_queued" };
  }
  if (state === "RUNNING") {
    return { ok: true, workItemId, action: "already_running" };
  }
  if (state === "SUCCEEDED") {
    return { ok: true, workItemId, action: "already_succeeded" };
  }
  if (state === "CANCELLED") {
    return {
      ok: false,
      status: 409,
      error: "tailoring cancelled",
      message: "this job's tailoring run was cancelled and cannot be retried",
    };
  }
  return {
    ok: false,
    status: 409,
    error: "tailoring not retryable",
    message: `unexpected tailor queue state: ${state}`,
  };
}

export function retryTailoring(handle: DatabaseHandle, jobId: string): RetryTailoringResult {
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return { ok: false, status: 404, error: "job not found", message: `unknown job: ${jobId}` };
  }
  const pointer = getJobDescriptionPointer(handle, jobId);
  const extractionId = pointer?.activeExtractionId ?? null;
  const descriptionText = pointer?.descriptionText ?? "";
  if (extractionId === null || descriptionText.trim() === "") {
    return {
      ok: false,
      status: 400,
      error: "extraction incomplete",
      message: "this job has no extracted description text to tailor against yet",
    };
  }
  const latest = getLatestTailorWorkItem(handle, jobId);
  if (latest === null) {
    const enqueued = requestTailoring(handle, { jobId, extractionId });
    return { ok: true, workItemId: enqueued.workItemId, action: "enqueued" };
  }
  if (latest.state !== "FAILED") {
    return noopForState(latest.id, latest.state);
  }
  const requeued = requeueWorkItem(handle, { workItemId: latest.id });
  if (requeued.ok) {
    return { ok: true, workItemId: latest.id, action: "requeued" };
  }
  // Lost a race (a worker claimed the item, or it finished): re-read
  // instead of reporting a stale failure.
  const current = getLatestTailorWorkItem(handle, jobId);
  if (current === null) {
    const enqueued = requestTailoring(handle, { jobId, extractionId });
    return { ok: true, workItemId: enqueued.workItemId, action: "enqueued" };
  }
  if (current.id === latest.id && current.state === "FAILED") {
    return {
      ok: false,
      status: 409,
      error: "tailoring not retryable",
      message: "the tailor queue item could not be requeued",
    };
  }
  return noopForState(current.id, current.state);
}
