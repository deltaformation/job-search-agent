import {
  getProfile,
  getSourceByVersion,
  listFactsByVersion,
  listProfileVersions,
} from "../../../../../../src/db/candidates";
import {
  jsonError,
  openRequestDatabase,
  readGate,
} from "../../../../_lib/request";

/**
 * Master history for one profile (WO-1.2-C). Lists immutable versions
 * with activation state, fact counts, and recorded-source metadata so
 * settings can review, compare, activate, and export without touching
 * the default profile. Reads only; B's persistence stays authoritative.
 */
export const dynamic = "force-dynamic";

interface VersionsRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: VersionsRouteContext,
): Promise<Response> {
  const gate = readGate(request);
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
    const profile = getProfile(database.handle, id);
    if (profile === null) {
      return jsonError(404, "profile not found", id);
    }
    const versions = listProfileVersions(database.handle, profile.id).map((row) => {
      const facts = listFactsByVersion(database.handle, row.id);
      const sourceRow = getSourceByVersion(database.handle, row.id);
      return {
        id: row.id,
        version: row.version,
        createdAt: row.createdAt,
        activatedAt: row.activatedAt,
        active: row.activatedAt !== null,
        schemaVersion: row.schemaVersion,
        payloadHash: row.payloadHash,
        facts: {
          total: facts.length,
          approved: facts.filter((fact) => fact.verification === "APPROVED").length,
        },
        source:
          sourceRow === null
            ? null
            : {
                origin: sourceRow.origin,
                byteSize: sourceRow.byteSize,
                sha256: sourceRow.sha256,
                recordedAt: sourceRow.createdAt,
              },
      };
    });
    return Response.json({
      profile: {
        id: profile.id,
        name: profile.name,
        displayName: profile.displayName,
        isDefault: profile.isDefault,
      },
      versions,
    });
  } finally {
    database.release();
  }
}
