import { UpdateCareerProfileInputV1 } from "../../../../../src/domain/candidate";
import { updateProfile } from "../../../../../src/db/candidates";
import { utcNow } from "../../../../../src/db/utils";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  routePolicy,
} from "../../../_lib/request";

/**
 * Update mutable career-profile metadata (display name, work
 * preferences, executive narrative). Identity (`id`, `name`) is frozen
 * by trigger. A field set to null clears it.
 */
export const dynamic = "force-dynamic";

interface ProfileRouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(
  request: Request,
  context: ProfileRouteContext,
): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "profile id is empty");
  }
  const parsed = await parseJsonBody(request, UpdateCareerProfileInputV1);
  if (!parsed.ok) {
    return parsed.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const updated = updateProfile(database.handle, id, parsed.value, utcNow());
    if (updated === null) {
      return jsonError(404, "profile not found");
    }
    return Response.json({ profile: updated });
  } finally {
    database.release();
  }
}
