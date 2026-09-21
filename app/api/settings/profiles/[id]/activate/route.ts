import { z } from "zod";
import {
  getProfile,
  getProfileVersion,
} from "../../../../../../src/db/candidates";
import { EntityId } from "../../../../../../src/domain/fields";
import { activateProfileVersion } from "../../../../../../src/server/candidates";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  routePolicy,
} from "../../../../_lib/request";

/**
 * Explicitly activate one staged profile version (WO-1.2-C). The human
 * review action behind copy drafts (B6) and version history: only the
 * named version of the named profile is activated, and a version from
 * another profile reads as not found. Idempotent — re-activating the
 * active version reports `alreadyActive` without writing history.
 */
export const dynamic = "force-dynamic";

const ActivateBody = z.object({ versionId: EntityId }).strict();

interface ActivateRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: ActivateRouteContext,
): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "profile id is empty");
  }
  const parsed = await parseJsonBody(request, ActivateBody);
  if (!parsed.ok) {
    return parsed.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const profile = getProfile(database.handle, id);
    if (profile === null) {
      return jsonError(404, "profile not found", id);
    }
    const row = getProfileVersion(database.handle, parsed.value.versionId);
    if (row === null || row.profileId !== profile.id) {
      return jsonError(404, "version not found", parsed.value.versionId);
    }
    const result = activateProfileVersion(database.handle, {
      versionId: row.id,
      actor: "human",
    });
    if (!result.ok) {
      return jsonError(404, "version not found", parsed.value.versionId);
    }
    const refreshed = getProfileVersion(database.handle, row.id);
    return Response.json({
      ok: true,
      profileId: profile.id,
      versionId: result.versionId,
      version: result.version,
      alreadyActive: result.alreadyActive,
      activatedAt: refreshed?.activatedAt ?? null,
    });
  } finally {
    database.release();
  }
}
