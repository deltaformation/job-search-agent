import { readFile } from "node:fs/promises";
import { getArtifact } from "../../../../src/server/queries";
import { resolveDataRoot } from "../../../../src/security/data-root";
import { resolveArtifactPath } from "../../../../src/security/paths";
import { jsonError, openRequestDatabase, readGate } from "../../_lib/request";

/**
 * Serve one captured evidence file by artifact id. Access resolves
 * through the database row and the allowlisted evidence root — never a
 * caller-supplied path — and fetched bytes are hostile content: they
 * ship with a sandboxing CSP plus nosniff even when rendered inline.
 * `?download=1` switches to an attachment disposition.
 */
export const dynamic = "force-dynamic";

interface EvidenceRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: EvidenceRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "artifact id is empty");
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const artifact = getArtifact(database.handle, id);
    if (artifact === null) {
      return jsonError(404, "artifact not found");
    }
    let absolute: string;
    try {
      const paths = resolveDataRoot(process.env);
      absolute = resolveArtifactPath(paths.evidenceDir, artifact.relativePath);
    } catch {
      return jsonError(500, "artifact path rejected");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      return jsonError(500, "artifact bytes missing");
    }
    const download =
      new URL(request.url).searchParams.get("download") === "1";
    const headers = new Headers({
      "content-type": artifact.mediaType,
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
    if (download) {
      headers.set(
        "content-disposition",
        `attachment; filename="${artifact.sha256.slice(0, 16)}"`,
      );
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  } finally {
    database.release();
  }
}
