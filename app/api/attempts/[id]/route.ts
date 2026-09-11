import { getWorkItemView } from "../../../../src/server/queries";
import { jsonError, openRequestDatabase, readGate } from "../../_lib/request";

/**
 * One work item with its queue attempts, latest scrape attempt, job,
 * extraction summary, and artifact links — everything the attempt view
 * needs to explain what happened and what to do next.
 */
export const dynamic = "force-dynamic";

interface AttemptRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: AttemptRouteContext,
): Promise<Response> {
  const gate = readGate(request);
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
    const view = getWorkItemView(database.handle, id);
    if (view === null) {
      return jsonError(404, "work item not found");
    }
    return Response.json(view);
  } finally {
    database.release();
  }
}
