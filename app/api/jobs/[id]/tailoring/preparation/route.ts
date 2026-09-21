import {
  openTailoringDatabase,
  parseCappedJsonBody,
  tailoringError,
  tailoringJson,
  tailoringMutationGate,
  tailoringPathId,
  tailoringReadGate,
} from "@/app/api/_lib/tailoring";
import {
  PreparationStatusV1,
  PrepareCommandV1,
  type PreparationStatusV1 as PreparationStatusV1Type,
} from "@/src/domain/step2";
import {
  readPreparationStatus,
  schedulePreparation,
  type PreparationFailure,
} from "@/src/server/preparation";

interface PreparationRouteContext {
  params: Promise<{ id: string }>;
}

function failureResponse(failure: PreparationFailure) {
  switch (failure.error) {
    case "job-not-found":
    case "profile-unknown":
      return tailoringError(404, "NOT_FOUND", failure.message);
    case "job-conflict":
    case "job-rejected":
      return tailoringError(409, "JOB_CONFLICT", failure.message, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "preparation-busy":
      return tailoringError(409, "PREPARATION_BUSY", failure.message, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "idempotency-mismatch":
      return tailoringError(409, "IDEMPOTENCY_MISMATCH", failure.message);
    case "profile-not-ready":
      return tailoringError(422, "PROFILE_NOT_READY", failure.message);
    case "jd-not-ready":
      return tailoringError(422, "JD_NOT_READY", failure.message);
    case "provider-not-ready":
      return tailoringError(422, "PROVIDER_NOT_READY", failure.message);
    case "storage-unavailable":
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.message);
    default:
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.message);
  }
}

export async function GET(request: Request, context: PreparationRouteContext) {
  const gate = tailoringReadGate(request, process.env);
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
    const preparation = readPreparationStatus(
      db.handle,
      id,
      new Date().toISOString(),
    );
    if (preparation === null) {
      return tailoringError(404, "NOT_FOUND", `job '${id}' does not exist`);
    }
    const parsed: PreparationStatusV1Type = PreparationStatusV1.parse(preparation);
    return tailoringJson(200, { ok: true, preparation: parsed });
  } finally {
    db.close();
  }
}

export async function POST(request: Request, context: PreparationRouteContext) {
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
    const body = await parseCappedJsonBody(request, PrepareCommandV1);
    if (!body.ok) {
      return body.response;
    }
    const result = schedulePreparation(db.handle, {
      jobId: id,
      body: body.value,
      env: process.env,
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
      profileId: result.value.profileId,
      profileVersionId: result.value.profileVersionId,
    });
  } finally {
    db.close();
  }
}
