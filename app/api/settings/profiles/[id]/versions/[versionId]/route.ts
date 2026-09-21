import {
  getProfile,
  getProfileVersion,
  getSourceByVersion,
} from "../../../../../../../src/db/candidates";
import { parseStoredProfilePayload } from "../../../../../../../src/domain/candidate";
import {
  jsonError,
  openRequestDatabase,
  readGate,
} from "../../../../../_lib/request";

/**
 * Read one immutable profile version with its parsed payload (WO-1.2-C).
 * Powers the settings full preview of any version — active or staged
 * draft — without changing the default. Ownership is enforced: a
 * version id from another profile reads as not found.
 */
export const dynamic = "force-dynamic";

interface VersionRouteContext {
  params: Promise<{ id: string; versionId: string }>;
}

export async function GET(
  request: Request,
  context: VersionRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id, versionId } = await context.params;
  if (id.trim() === "" || versionId.trim() === "") {
    return jsonError(400, "invalid request", "profile id or version id is empty");
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
    const row = getProfileVersion(database.handle, versionId);
    if (row === null || row.profileId !== profile.id) {
      return jsonError(404, "version not found", versionId);
    }
    let payload: unknown;
    try {
      payload = parseStoredProfilePayload(JSON.parse(row.payloadJson) as unknown);
    } catch (error: unknown) {
      return jsonError(
        500,
        "stored version payload is corrupt",
        error instanceof Error ? error.message : String(error),
      );
    }
    const sourceRow = getSourceByVersion(database.handle, row.id);
    return Response.json({
      profile: {
        id: profile.id,
        name: profile.name,
        displayName: profile.displayName,
        isDefault: profile.isDefault,
      },
      version: {
        id: row.id,
        version: row.version,
        createdAt: row.createdAt,
        activatedAt: row.activatedAt,
        active: row.activatedAt !== null,
        schemaVersion: row.schemaVersion,
        payloadHash: row.payloadHash,
      },
      payload,
      source:
        sourceRow === null
          ? null
          : {
              origin: sourceRow.origin,
              byteSize: sourceRow.byteSize,
              sha256: sourceRow.sha256,
              recordedAt: sourceRow.createdAt,
            },
    });
  } finally {
    database.release();
  }
}
