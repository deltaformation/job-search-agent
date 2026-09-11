import { z } from "zod";
import type { WorkflowCommandFailure } from "../../../../src/server/workflow";
import { jsonError } from "../../_lib/request";

/**
 * Path-id gate: empty or non-UUID ids are malformed requests (400), so the
 * R3-A commands — which require UUID job ids — never see them. Unknown but
 * well-formed ids still reach the service and map to 404.
 */
export function jobIdGate(id: string): Response | null {
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "job id is empty");
  }
  if (!z.uuid().safeParse(id).success) {
    return jsonError(400, "invalid request", "job id must be a uuid");
  }
  return null;
}

/**
 * Shared failure mapping for the R3-A command routes. Every rejection
 * carries its machine-readable `error` code so the board can react
 * (refresh-and-retry on conflict, inline message otherwise); conflicts
 * also carry `currentRowVersion` for the retry.
 */
export function commandFailureResponse(
  failure: WorkflowCommandFailure,
): Response {
  const detail = {
    error: failure.error,
    reason: failure.detail,
    from: failure.from,
    to: failure.to,
    currentRowVersion: failure.currentRowVersion,
  };
  if (failure.error === "unknown-job") {
    return jsonError(404, "job not found", failure.detail);
  }
  if (failure.error === "conflict") {
    return Response.json(detail, { status: 409 });
  }
  return Response.json(detail, { status: 400 });
}
