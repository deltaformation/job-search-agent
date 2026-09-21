import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "./client";
import { generationRequests, type GenerationRequest } from "./schema/generation";
import { workItems } from "./schema/queue";

/** Read/write access to `generation_requests` (WO-1.2-D). No validation here. */

export function getGenerationRequest(
  handle: DatabaseHandle,
  requestId: string,
): GenerationRequest | null {
  const row = handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.id, requestId))
    .get();
  return row ?? null;
}

export function getGenerationRequestByIdentity(
  handle: DatabaseHandle,
  requestIdentity: string,
): GenerationRequest | null {
  const row = handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.requestIdentity, requestIdentity))
    .get();
  return row ?? null;
}

export interface InsertGenerationRequestInput {
  id: string;
  requestIdentity: string;
  jobId: string;
  extractionId: string;
  profileId: string;
  profileVersionId: string;
  jdSnapshotId: string;
  parentVersionId: string | null;
  requestKind: string;
  steeringSnapshotJson: string;
  selectedKeywordsJson: string;
  directivesText: string | null;
  revisionNote: string | null;
  payloadHash: string;
  workItemId: string;
  now: string;
}

export function insertGenerationRequest(
  handle: DatabaseHandle,
  input: InsertGenerationRequestInput,
): GenerationRequest {
  return handle.db.insert(generationRequests).values(input).returning().get();
}

/** Live request for a job (QUEUED or RUNNING), newest first, if any. */
/**
 * The job's live generation request, if any. A request counts as live
 * only while its own queue item is QUEUED or RUNNING — a request whose
 * bookkeeping says RUNNING but whose item already finished (crash
 * between output commit and bookkeeping) must not block the next run
 * forever (§9).
 */
export function getLiveGenerationRequest(
  handle: DatabaseHandle,
  jobId: string,
): GenerationRequest | null {
  const rows = handle.db
    .select({ request: generationRequests })
    .from(generationRequests)
    .innerJoin(workItems, eq(workItems.id, generationRequests.workItemId))
    .where(
      and(
        eq(generationRequests.jobId, jobId),
        inArray(generationRequests.status, ["QUEUED", "RUNNING"]),
        inArray(workItems.state, ["QUEUED", "RUNNING"]),
      ),
    )
    .orderBy(generationRequests.createdAt, generationRequests.id)
    .all();
  return rows[rows.length - 1]?.request ?? null;
}

/** The request a queue item belongs to, if it was queued explicitly. */
export function getGenerationRequestByWorkItem(
  handle: DatabaseHandle,
  workItemId: string,
): GenerationRequest | null {
  const row = handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.workItemId, workItemId))
    .get();
  return row ?? null;
}

export function listGenerationRequests(
  handle: DatabaseHandle,
  jobId: string,
): GenerationRequest[] {
  return handle.db
    .select()
    .from(generationRequests)
    .where(eq(generationRequests.jobId, jobId))
    .orderBy(generationRequests.createdAt, generationRequests.id)
    .all();
}

export type GenerationRequestStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

/**
 * Execution bookkeeping transition (the only post-insert mutation the
 * frozen trigger permits). Terminal states carry finished/error detail.
 */
/**
 * Fail one request's bookkeeping without touching its job. Used when the
 * job is owned elsewhere (concurrent human move fenced the run) or is
 * already terminal — the request must still record its own outcome.
 * No-op when the request is already terminal, so retries converge.
 */
export function failGenerationRequest(
  handle: DatabaseHandle,
  input: { requestId: string; errorCode: string; errorDetail: string; now: string },
): void {
  const current = getGenerationRequest(handle, input.requestId);
  if (current === null || current.status === "SUCCEEDED" || current.status === "FAILED") {
    return;
  }
  updateGenerationRequestStatus(handle, {
    requestId: input.requestId,
    status: "FAILED",
    errorCode: input.errorCode,
    errorDetail: input.errorDetail,
    finishedAt: input.now,
    now: input.now,
  });
}

export function updateGenerationRequestStatus(
  handle: DatabaseHandle,
  input: {
    requestId: string;
    status: GenerationRequestStatus;
    errorCode?: string | null;
    errorDetail?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    now: string;
  },
): void {
  handle.db
    .update(generationRequests)
    .set({
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorDetail: input.errorDetail ?? null,
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      updatedAt: input.now,
    })
    .where(eq(generationRequests.id, input.requestId))
    .run();
}
