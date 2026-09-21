import { EntityId } from "@/src/domain/fields";
import {
  getRecommendations,
  type RecommendationFailure,
} from "@/src/server/recommendations";
import { hashRecommendation } from "@/src/tailoring/requestsV3";
import {
  openTailoringDatabase,
  tailoringError,
  tailoringJson,
  tailoringPathId,
  tailoringReadGate,
} from "@/app/api/_lib/tailoring";

/**
 * v1.3 recommendations API (WO-1.3-D): deterministic GET over an
 * explicit active binding. Two required UUID query params; owned
 * but no-longer-active bindings fail 409 INPUT_STALE, active
 * bindings without JD text fail 422 JD_NOT_READY, and corrupt
 * storage fails 503. Read-only (ΔQ1=0, ΔQ9=0); no provider call.
 */

interface RecommendationsRouteContext {
  params: Promise<{ id: string }>;
}

function failureResponse(failure: RecommendationFailure) {
  switch (failure.error) {
    case "unknown-job":
    case "not-found":
      return tailoringError(404, "NOT_FOUND", failure.detail, { field: failure.field });
    case "input-stale":
      return tailoringError(409, "INPUT_STALE", failure.detail, { field: failure.field });
    case "jd-not-ready":
      return tailoringError(422, "JD_NOT_READY", failure.detail, { field: failure.field });
    case "storage-unavailable":
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.detail, { field: failure.field });
  }
}

export async function GET(request: Request, context: RecommendationsRouteContext) {
  const gate = tailoringReadGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const query = new URL(request.url).searchParams;
  const extractionId = query.get("extractionId");
  const profileVersionId = query.get("profileVersionId");
  if (extractionId === null || EntityId.safeParse(extractionId).success === false) {
    return tailoringError(400, "INVALID_REQUEST", "query extractionId must be a UUID", {
      field: "extractionId",
    });
  }
  if (profileVersionId === null || EntityId.safeParse(profileVersionId).success === false) {
    return tailoringError(400, "INVALID_REQUEST", "query profileVersionId must be a UUID", {
      field: "profileVersionId",
    });
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const result = getRecommendations(db.handle, { jobId: id, extractionId, profileVersionId });
    if (!result.ok) {
      return failureResponse(result.failure);
    }
    return tailoringJson(200, {
      ok: true,
      recommendations: result.recommendations,
      recommendationHash: hashRecommendation(result.recommendations),
    });
  } finally {
    db.close();
  }
}
