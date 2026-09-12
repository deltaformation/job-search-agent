import { retryTailoring } from "../../../../../../src/server/tailoring";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
} from "../../../../_lib/request";
import { jobIdGate } from "../../../_lib/failures";

/**
 * Human-driven tailoring retry for one job: requeues a FAILED tailor
 * run, enqueues a first run when none exists, and no-ops when work is
 * already queued, running, or succeeded. The request body is ignored —
 * the path id is the target. Retrying never approves a resume and never
 * moves the board card; the worker still has to claim and run the item.
 */
export const dynamic = "force-dynamic";

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
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const result = retryTailoring(database.handle, id);
    if (!result.ok) {
      return jsonError(result.status, result.error, result.message);
    }
    return Response.json({ workItemId: result.workItemId, action: result.action });
  } finally {
    database.release();
  }
}
