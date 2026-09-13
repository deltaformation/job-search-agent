import { setDefaultProfile } from "../../../../../../src/db/candidates";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  routePolicy,
} from "../../../../_lib/request";

/**
 * Move the system default marker to one career profile. Tailoring and
 * master-resume re-sync resolve the default profile when no explicit
 * target is given.
 */
export const dynamic = "force-dynamic";

interface SetDefaultRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: SetDefaultRouteContext,
): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "profile id is empty");
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    if (!setDefaultProfile(database.handle, id)) {
      return jsonError(404, "profile not found");
    }
    return Response.json({ ok: true, defaultProfileId: id });
  } finally {
    database.release();
  }
}
