import { getBatchView } from "../../../../../src/server/queries";
import { jsonError, openRequestDatabase, readGate } from "../../../_lib/request";

/** One batch with per-line outcomes plus live queue state per line. */
export const dynamic = "force-dynamic";

interface BatchRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: BatchRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "batch id is empty");
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const view = getBatchView(database.handle, id);
    if (view === null) {
      return jsonError(404, "batch not found");
    }
    return Response.json(view);
  } finally {
    database.release();
  }
}
