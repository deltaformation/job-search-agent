import { GenerateBody, GenerationReply } from "@/src/domain/tailoringWorkspace";
import { requestGeneration } from "@/src/server/tailoring";
import type { SubmitGenerationFailure } from "@/src/server/generations";
import {
  openTailoringDatabase,
  parseCappedJsonBody,
  tailoringError,
  tailoringJson,
  tailoringMutationGate,
  tailoringPathId,
} from "@/app/api/_lib/tailoring";

/**
 * v1.3 transaction G (WO-1.3-E): atomic generation/revision
 * submission over the exact stored focus. The client mints the
 * operation UUID once; byte-identical resubmits replay with 200 and
 * zero writes, while changed bytes under a reused ID fail 409.
 * G enqueues only — provider execution stays in the worker.
 */

interface GenerationsRouteContext {
  params: Promise<{ id: string }>;
}

function failureResponse(failure: SubmitGenerationFailure) {
  switch (failure.error) {
    case "unknown-job":
      return tailoringError(404, "NOT_FOUND", failure.detail);
    case "workspace-conflict":
      return tailoringError(409, "WORKSPACE_CONFLICT", failure.detail, {
        currentWorkspaceRevision: failure.currentWorkspaceRevision,
      });
    case "job-conflict":
      return tailoringError(409, "JOB_CONFLICT", failure.detail, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "input-stale":
      return tailoringError(409, "INPUT_STALE", failure.detail);
    case "generation-busy":
      return tailoringError(409, "GENERATION_BUSY", failure.detail, {
        currentRowVersion: failure.currentRowVersion,
      });
    case "idempotency-mismatch":
      return tailoringError(409, "IDEMPOTENCY_MISMATCH", failure.detail);
    case "profile-not-ready":
      return tailoringError(422, "PROFILE_NOT_READY", failure.detail);
    case "jd-not-ready":
      return tailoringError(422, "JD_NOT_READY", failure.detail);
    case "provider-not-ready":
      return tailoringError(422, "PROVIDER_NOT_READY", failure.detail);
    case "plan-stale":
      return tailoringError(409, "PLAN_STALE", failure.detail);
    case "unresolved-evidence":
      return tailoringError(422, "UNRESOLVED_EVIDENCE", failure.detail, {
        currentWorkspaceRevision: failure.currentWorkspaceRevision,
      });
    case "budget-exceeded":
      return tailoringError(422, "BUDGET_EXCEEDED", failure.detail, {
        currentWorkspaceRevision: failure.currentWorkspaceRevision,
      });
    case "invalid-selection":
      return tailoringError(422, "INVALID_SELECTION", failure.detail, {
        field: failure.field,
      });
    case "storage-unavailable":
      return tailoringError(503, "STORAGE_UNAVAILABLE", failure.detail);
  }
}

export async function POST(request: Request, context: GenerationsRouteContext) {
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
    const body = await parseCappedJsonBody(request, GenerateBody);
    if (!body.ok) {
      return body.response;
    }
    const result = requestGeneration(db.handle, {
      jobId: id,
      requestId: body.value.requestId,
      workspaceRevision: body.value.workspaceRevision,
      observedRowVersion: body.value.observedRowVersion,
      actor: "human",
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
