import { requeueWorkItem } from "../../../../../src/queue/leases";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
} from "../../../_lib/request";

/**
 * Human-driven retry of a finished FAILED work item: grants a fresh
 * bounded attempt budget and requeues immediately. Only FAILED items
 * are eligible; successes are never rewritten and live leases never
 * yanked. The request body is ignored — the path id is the target.
 */
export const dynamic = "force-dynamic";

interface RetryRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: RetryRouteContext,
): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "work item id is empty");
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const result = requeueWorkItem(database.handle, { workItemId: id });
    if (!result.ok) {
      return result.error === "unknown-item"
        ? jsonError(404, "work item not found")
        : jsonError(
          409,
          "work item is not retryable",
          "only finished FAILED items can be retried",
        );
    }
    return Response.json({ state: result.state });
  } finally {
    database.release();
  }
}
