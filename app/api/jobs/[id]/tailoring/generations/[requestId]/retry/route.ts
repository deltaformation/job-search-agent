import { GenerationReply, RetryBody } from "@/src/domain/tailoringWorkspace";
import { retryGeneration, type RetryGenerationFailure } from "@/src/server/retries";
import {
  openTailoringDatabase,
  parseCappedJsonBody,
  tailoringError,
  tailoringJson,
  tailoringMutationGate,
  tailoringPathId,
} from "@/app/api/_lib/tailoring";

/**
 * v1.3 transaction R (WO-1.3-F): attempt-specific explicit retry. The
 * caller names the exact failed attempt it observed; an already
 * requeued/running attempt — or a later attempt the observation
 * predates — replays 200 with zero writes instead of forking work.
 */

interface RetryRouteContext {
  params: Promise<{ id: string; requestId: string }>;
}

function failureResponse(failure: RetryGenerationFailure) {
  switch (failure.error) {
    case "unknown-request":
    case "unknown-attempt":
      return tailoringError(404, "NOT_FOUND", failure.detail);
    case "job-conflict":
      return tailoringError(409, "JOB_CONFLICT", failure.detail, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "generation-busy":
      return tailoringError(409, "GENERATION_BUSY", failure.detail, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "input-stale":
      return tailoringError(409, "INPUT_STALE", failure.detail);
    case "retry-not-allowed":
      return tailoringError(422, "RETRY_NOT_ALLOWED", failure.detail);
    case "storage-unavailable":
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.detail);
  }
}

export async function POST(request: Request, context: RetryRouteContext) {
  const gate = tailoringMutationGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id, requestId } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const requestCheck = tailoringPathId(requestId);
  if (!requestCheck.ok) {
    return requestCheck.response;
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const body = await parseCappedJsonBody(request, RetryBody);
    if (!body.ok) {
      return body.response;
    }
    const result = retryGeneration(db.handle, {
      jobId: id,
      requestId,
      observedAttemptId: body.value.observedAttemptId,
      observedRowVersion: body.value.observedRowVersion,
    });
    if (!result.ok) {
      return failureResponse(result.failure);
    }
    return tailoringJson(
      result.replayed ? 200 : 202,
      GenerationReply.parse({
        ok: true,
        requestId: result.requestId,
        workItemId: result.workItemId,
        status: result.status,
        replayed: result.replayed,
        jobRowVersion: result.jobRowVersion,
        workspaceRevision: result.workspaceRevision,
      }),
    );
  } finally {
    db.close();
  }
}
