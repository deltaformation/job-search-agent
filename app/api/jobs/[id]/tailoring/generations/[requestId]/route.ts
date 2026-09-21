import { readGenerationProgress } from "@/src/server/progress";
import {
  openTailoringDatabase,
  tailoringError,
  tailoringJson,
  tailoringPathId,
  tailoringReadGate,
} from "@/app/api/_lib/tailoring";

/**
 * v1.3 generation progress (WO-1.3-F): request-scoped worker truth —
 * queue state, latest-attempt timing, lease liveness, fenced stage
 * events, and typed safe failures. Read-only; polling never mutates.
 */

interface ProgressRouteContext {
  params: Promise<{ id: string; requestId: string }>;
}

export async function GET(request: Request, context: ProgressRouteContext) {
  const gate = tailoringReadGate(request, process.env);
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
    const result = readGenerationProgress(db.handle, { jobId: id, requestId });
    if (!result.ok) {
      if (result.failure.error === "unknown-request") {
        return tailoringError(404, "NOT_FOUND", result.failure.detail);
      }
      return tailoringError(503, "STORAGE_UNAVAILABLE", result.failure.detail);
    }
    return tailoringJson(200, result.reply);
  } finally {
    db.close();
  }
}
