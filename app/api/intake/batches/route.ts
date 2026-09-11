import { listBatches } from "../../../../src/server/queries";
import { openRequestDatabase, readGate } from "../../_lib/request";

/** Recent intake batches, newest first. `?limit=` clamps to 1–100. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const raw = new URL(request.url).searchParams.get("limit");
  const parsed = raw === null ? 20 : Number(raw);
  const limit = Number.isFinite(parsed) ? parsed : 20;
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    return Response.json({ batches: listBatches(database.handle, limit) });
  } finally {
    database.release();
  }
}
