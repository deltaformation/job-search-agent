import { getJobDetail } from "../../../../src/server/board";
import { jsonError, openRequestDatabase, readGate } from "../../_lib/request";

/**
 * Complete card detail: normalized job, validated source URLs, scrape
 * attempts, active extraction, resume versions with artifact refs and
 * reviews, notes, application record, workflow history, and intake
 * provenance. File bytes stay behind /api/evidence ids; no stored path
 * is ever serialized.
 */
export const dynamic = "force-dynamic";

interface JobRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: JobRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "job id is empty");
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const detail = getJobDetail(database.handle, id);
    if (detail === null) {
      return jsonError(404, "job not found");
    }
    return Response.json(detail);
  } finally {
    database.release();
  }
}
