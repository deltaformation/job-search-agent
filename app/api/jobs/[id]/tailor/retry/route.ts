import {
  RequestGenerationInput,
  defaultProviderAvailable,
  requestGeneration,
  type RequestGenerationError,
} from "../../../../../../src/server/tailoring";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../../_lib/request";
import { jobIdGate } from "../../../_lib/failures";

/**
 * Explicit human generation command for one job (WO-1.2-D). The body
 * carries optional guidance (`profileId`, `selectedKeywords`,
 * `directives`, `parentVersionId`, `requestId`); the command pref lights
 * profile readiness, evidence, JD content, and provider availability
 * before writing anything, then records the immutable request plus its
 * v2 queue item. Preflight failures are 422 with an actionable next
 * step; state conflicts are 409. Starting generation never approves a
 * resume and never moves the board card — the worker still has to claim
 * and run the item.
 */
export const dynamic = "force-dynamic";

const GenerationBody = RequestGenerationInput.omit({ jobId: true, actor: true });

function generationFailureStatus(error: RequestGenerationError): number {
  switch (error) {
    case "unknown-job":
      return 404;
    case "conflict":
    case "request-forbidden":
    case "parent-mismatch":
      return 409;
    case "profile-not-found":
      return 400;
    default:
      return 422;
  }
}

interface RetryTailoringRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: RetryTailoringRouteContext,
): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idGate = jobIdGate(id);
  if (idGate !== null) {
    return idGate;
  }
  const body = await parseJsonBody(request, GenerationBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const result = requestGeneration(
      database.handle,
      { ...body.value, jobId: id, actor: "human" },
      { providerAvailable: () => defaultProviderAvailable() },
    );
    if (!result.ok) {
      if (result.error === "unknown-job") {
        return jsonError(404, "job not found", result.detail);
      }
      return Response.json(
        { error: result.error, reason: result.detail, action: result.action },
        { status: generationFailureStatus(result.error) },
      );
    }
    return Response.json({
      requestId: result.requestId,
      requestKind: result.requestKind,
      workItemId: result.workItemId,
      deduped: result.deduped,
      requeued: result.requeued,
      newRowVersion: result.newRowVersion,
    });
  } finally {
    database.release();
  }
}
