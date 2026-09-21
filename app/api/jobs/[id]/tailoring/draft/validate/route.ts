import { z } from "zod";
import {
  openTailoringDatabase,
  parseCappedJsonBody,
  tailoringError,
  tailoringJson,
  tailoringMutationGate,
  tailoringPathId,
  zodInvalidRequest,
} from "@/app/api/_lib/tailoring";
import { ValidateDraftBodyV1, ValidateDraftReplyV1 } from "@/src/domain/step2";
import {
  STEP2_CORRECTION_VERSIONS,
  ValidateDraftBodyV2,
  ValidateDraftReplyV2,
} from "@/src/domain/step2Correction";
import {
  validateDraft,
  validateDraftV2,
  type PreparationFailure,
} from "@/src/server/preparation";

interface ValidateDraftRouteContext {
  params: Promise<{ id: string }>;
}

function failureResponse(failure: PreparationFailure) {
  switch (failure.error) {
    case "job-not-found":
    case "plan-not-found":
      return tailoringError(404, "NOT_FOUND", failure.message);
    case "plan-stale":
      return tailoringError(409, "PLAN_STALE", failure.message);
    case "workspace-conflict":
      return tailoringError(409, "WORKSPACE_CONFLICT", failure.message, {
        currentWorkspaceRevision: failure.currentWorkspaceRevision,
      });
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

export async function POST(request: Request, context: ValidateDraftRouteContext) {
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
    const raw = await parseCappedJsonBody(request, z.unknown());
    if (!raw.ok) {
      return raw.response;
    }
    // S2-CP-B: v1 and v2 validate bodies discriminate by
    // `schemaVersion`; verdicts persist under their own policy
    // (`step2-claims/1` or `/2`) and never cross-read.
    const schemaVersion = (raw.value as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (schemaVersion === STEP2_CORRECTION_VERSIONS.validateDraft) {
      const body = ValidateDraftBodyV2.safeParse(raw.value);
      if (!body.success) {
        return zodInvalidRequest(body.error);
      }
      const result = validateDraftV2(db.handle, {
        jobId: id,
        body: body.data,
        now: new Date().toISOString(),
      });
      if (!result.ok) {
        return failureResponse(result);
      }
      return tailoringJson(
        200,
        ValidateDraftReplyV2.parse({
          ok: true,
          validationId: result.value.validationId,
          validation: result.value.validation,
        }),
      );
    }
    const body = ValidateDraftBodyV1.safeParse(raw.value);
    if (!body.success) {
      return zodInvalidRequest(body.error);
    }
    const result = validateDraft(db.handle, {
      jobId: id,
      body: body.data,
      now: new Date().toISOString(),
    });
    if (!result.ok) {
      return failureResponse(result);
    }
    return tailoringJson(
      200,
      ValidateDraftReplyV1.parse({
        ok: true,
        validationId: result.value.validationId,
        validation: result.value.validation,
      }),
    );
  } finally {
    db.close();
  }
}
