import type { DatabaseHandle } from "../db/client";
import { getJobDescriptionPointer, getProfile } from "../db/candidates";
import {
  getLatestTailorWorkItem,
  getTailorWorkItemState,
  getTailoringJob,
} from "../db/tailoring";
import { requeueWorkItem } from "../queue/leases";
import {
  normalizeTailoringGuidance,
  requestTailoring,
  TailoringGuidanceV1,
} from "../tailoring/enqueue";

/**
 * Job-scoped tailoring retry ("ensure tailoring runs"): requeues the
 * job's latest FAILED TAILOR item, enqueues a first run when tailoring
 * never started, and no-ops when work is already queued, running, or
 * succeeded. With human guidance (career profile, keywords, directives)
 * it enqueues a guidance-scoped run instead — except on already-tailored
 * jobs, where re-tailoring must go through a human revision request. The
 * route never touches `jobs.tailoring_state` directly — only the
 * worker's leased claim may move a run to RUNNING, so retries cannot
 * bypass queue fencing or strand duplicate runs.
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

export function retryTailoring(
  handle: DatabaseHandle,
  jobId: string,
  guidanceRaw: unknown = {},
): RetryTailoringResult {
  const parsedGuidance = TailoringGuidanceV1.safeParse(guidanceRaw ?? {});
  if (!parsedGuidance.success) {
    return {
      ok: false,
      status: 400,
      error: "invalid guidance",
      message: parsedGuidance.error.issues[0]?.message ?? "schema mismatch",
    };
  }
  const guidance = normalizeTailoringGuidance(parsedGuidance.data);
  const job = getTailoringJob(handle, jobId);
  if (job === null) {
    return { ok: false, status: 404, error: "job not found", message: `unknown job: ${jobId}` };
  }
  if (
    parsedGuidance.data.profileId !== undefined &&
    getProfile(handle, parsedGuidance.data.profileId) === null
  ) {
    return {
      ok: false,
      status: 404,
      error: "profile not found",
      message: `unknown career profile: ${parsedGuidance.data.profileId}`,
    };
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
    const enqueued = requestTailoring(handle, {
      jobId,
      extractionId,
      ...(guidance ?? {}),
    });
    return { ok: true, workItemId: enqueued.workItemId, action: "enqueued" };
  }
  if (latest.state === "QUEUED" || latest.state === "RUNNING") {
    return noopForState(latest.id, latest.state);
  }
  if (guidance === null) {
    if (latest.state !== "FAILED") {
      return noopForState(latest.id, latest.state);
    }
    return requeueFailed(handle, jobId, extractionId, latest.id);
  }
  if (latest.state !== "FAILED" && latest.state !== "SUCCEEDED") {
    return noopForState(latest.id, latest.state);
  }
  if (job.tailoringState === "AWAITING_REVIEW" || job.tailoringState === "APPROVED") {
    return {
      ok: false,
      status: 409,
      error: "tailoring already succeeded",
      message: "request a revision to re-tailor this resume with new guidance",
    };
  }
  const enqueued = requestTailoring(handle, { jobId, extractionId, ...guidance });
  if (!enqueued.deduped) {
    return { ok: true, workItemId: enqueued.workItemId, action: "enqueued" };
  }
  // Identical guidance was already requested: report that run's position,
  // re-driving it when it ended FAILED.
  let state = getTailorWorkItemState(handle, enqueued.workItemId);
  if (state === "FAILED") {
    const requeued = requeueWorkItem(handle, { workItemId: enqueued.workItemId });
    if (requeued.ok) {
      return { ok: true, workItemId: enqueued.workItemId, action: "requeued" };
    }
    state = getTailorWorkItemState(handle, enqueued.workItemId);
  }
  if (state === null || state === "FAILED") {
    return {
      ok: false,
      status: 409,
      error: "tailoring not retryable",
      message: "the matching guided run could not be requeued",
    };
  }
  return noopForState(enqueued.workItemId, state);
}

function requeueFailed(
  handle: DatabaseHandle,
  jobId: string,
  extractionId: string,
  workItemId: string,
): RetryTailoringResult {
  const latest = { id: workItemId, state: "FAILED" as const };
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
