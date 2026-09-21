import {
  getProfile,
  getProfileVersion,
} from "../../../../../../../../src/db/candidates";
import {
  parseStoredProfilePayload,
  type StoredProfilePayload,
} from "../../../../../../../../src/domain/candidate";
import { renderMasterMarkdown } from "../../../../../../../../src/domain/master-preview";
import { readSourceBytes } from "../../../../../../../../src/server/sources";
import {
  jsonError,
  openRequestDatabase,
  readGate,
} from "../../../../../../_lib/request";
import { resolveRoutePaths } from "../../../../../../_lib/data-mgmt";

/**
 * Export one immutable profile version (WO-1.2-C):
 * `?format=json` (default) downloads the recorded authored bytes
 * verbatim; `?format=md` renders the deterministic readable projection.
 * Versions without recorded source bytes export a payload
 * reconstruction that is labeled as such in the filename, a response
 * header, and (for Markdown) a banner line.
 */
export const dynamic = "force-dynamic";

interface ExportRouteContext {
  params: Promise<{ id: string; versionId: string }>;
}

function slugify(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "profile" : slug;
}

export async function GET(
  request: Request,
  context: ExportRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id, versionId } = await context.params;
  if (id.trim() === "" || versionId.trim() === "") {
    return jsonError(400, "invalid request", "profile id or version id is empty");
  }
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "md") {
    return jsonError(400, "unsupported export format", "use format=json or format=md");
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
    let payload: StoredProfilePayload;
    try {
      payload = parseStoredProfilePayload(JSON.parse(row.payloadJson) as unknown);
    } catch (error: unknown) {
      return jsonError(
        500,
        "stored version payload is corrupt",
        error instanceof Error ? error.message : String(error),
      );
    }
    const { paths } = resolveRoutePaths(process.env);
    const base = `master-${slugify(profile.displayName)}-v${row.version}`;
    if (format === "md") {
      const source = readSourceBytes(database.handle, paths.sourcesDir, profile.id, row.id);
      const reconstructed = !source.ok;
      const markdown = renderMasterMarkdown(payload, {
        profileDisplayName: profile.displayName,
        version: row.version,
        reconstructed,
      });
      return new Response(markdown, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${base}${reconstructed ? "-reconstructed" : ""}.md"`,
          ...(reconstructed ? { "x-export-note": "reconstructed-from-payload" } : {}),
        },
      });
    }
    const source = readSourceBytes(database.handle, paths.sourcesDir, profile.id, row.id);
    if (source.ok) {
      return new Response(new Uint8Array(source.bytes), {
        status: 200,
        headers: {
          "content-type": source.row.mediaType,
          "content-disposition": `attachment; filename="${base}.json"`,
        },
      });
    }
    if (source.error !== "source-missing") {
      return jsonError(500, "master source unreadable", source.detail);
    }
    // No recorded bytes (pre-backfill version): export a labeled
    // reconstruction of the authoritative stored payload.
    const reconstructed = `${JSON.stringify(payload, null, 2)}\n`;
    return new Response(reconstructed, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${base}-reconstructed.json"`,
        "x-export-note": "reconstructed-from-payload",
      },
    });
  } finally {
    database.release();
  }
}
