import {
  openTailoringDatabase,
  parseCappedJsonBody,
  tailoringError,
  tailoringJson,
  tailoringMutationGate,
  tailoringPathId,
} from "@/app/api/_lib/tailoring";
import { PrepareRetryBodyV1 } from "@/src/domain/step2";
import {
  retryPreparation,
  type PreparationFailure,
} from "@/src/server/preparation";

interface PreparationRetryRouteContext {
  params: Promise<{ id: string }>;
}

function failureResponse(failure: PreparationFailure) {
  switch (failure.error) {
    case "job-not-found":
    case "attempt-not-found":
      return tailoringError(404, "NOT_FOUND", failure.message);
    case "job-conflict":
      return tailoringError(409, "JOB_CONFLICT", failure.message, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "preparation-busy":
      return tailoringError(409, "PREPARATION_BUSY", failure.message, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "retry-not-allowed":
      return tailoringError(422, "RETRY_NOT_ALLOWED", failure.message);
    case "profile-not-ready":
      return tailoringError(422, "PROFILE_NOT_READY", failure.message);
    case "jd-not-ready":
      return tailoringError(422, "JD_NOT_READY", failure.message);
    case "storage-unavailable":
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.message);
    default:
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.message);
  }
}

export async function POST(request: Request, context: PreparationRetryRouteContext) {
  const gate = tailoringMutationGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const body = await parseCappedJsonBody(request, PrepareRetryBodyV1);
    if (!body.ok) {
      return body.response;
    }
    const result = retryPreparation(db.handle, {
      jobId: id,
      body: body.value,
      now: new Date().toISOString(),
    });
    if (!result.ok) {
      return failureResponse(result);
    }
    return tailoringJson(result.value.replayed ? 200 : 202, {
      ok: true,
      preparationId: result.value.preparationId,
      state: result.value.state,
      replayed: result.value.replayed,
    });
  } finally {
    db.close();
  }
}
